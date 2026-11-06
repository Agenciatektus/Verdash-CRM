import type { SupabaseClient } from "@supabase/supabase-js";

import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import type { WahaPayload } from "@/lib/waha/ingest";
import { TETO_DO_DOWNLOAD_MS } from "@/lib/channels/historico/prazo";
import { candidatosDeExternalId, mapearMensagemDoAcervo } from "@/lib/channels/historico/mapear";
import { BYTES_DE_CANDIDATOS_POR_CONSULTA, mensagemDeErro, type Importacao } from "@/lib/channels/historico/comum";
import { atualizarMensagem } from "@/lib/channels/historico/rodada-gravar";

/** Falhas de transporte do canal na mesma mídia antes de marcá-la indisponível. */
const LIMITE_DE_TENTATIVAS_DE_MIDIA = 3;

/** Cliente do canal, só com o que `resolverMidias` usa. */
export type CanalDeMidia = {
  baixarMidiaDaMensagem(
    session: string,
    chatId: string,
    messageId: string,
    opts?: { tetoMs?: number },
  ): Promise<{ url: string | null; erro: boolean }>;
};

/**
 * Resolve a mídia (imagem e áudio) das mensagens DESTA página, as recém-gravadas
 * e as que já existiam como `pendente` (página refeita). Devolve `false` quando o
 * teto de chamadas ou o prazo acabou antes de resolver todas, ou quando alguma
 * ficou `pendente` para tentar de novo: quem chama não firma o cursor e a
 * página é refeita. Cada download leva `TETO_DO_DOWNLOAD_MS` no próprio pedido.
 *
 * Tentativa que não é veredito (sem URL e sem erro, ou tempo esgotado no
 * download) conta `tentativas_midia` e a rodada segue para a próxima mídia; na
 * 3ª a mídia vira `indisponivel`. Sem esse limite, K mídias assim, com K maior
 * que os downloads que cabem numa rodada, deixariam a página aberta para sempre.
 * Outro erro de transporte (o canal fora do ar) sobe para a rodada, que para em
 * `erro` com o cursor firme anterior. Só `erro: true` (o canal diz que a mídia
 * não existe mais) vira `indisponivel` de uma vez.
 */
export async function resolverMidias(
  admin: SupabaseClient,
  imp: Importacao,
  canal: CanalDeMidia,
  nomeNoCanal: string,
  chatId: string,
  conversationId: string,
  mensagens: WahaPayload[],
  ctl: {
    noTeto: () => boolean;
    contarChamada: () => void;
    midias: { baixadas: number; indisponiveis: number };
  },
): Promise<boolean> {
  // external_id candidato -> id da mensagem no canal, só das que o mapeador marca `pendente`.
  const idNoCanal = new Map<string, string>();
  for (const p of mensagens) {
    const linha = mapearMensagemDoAcervo(p, {
      orgId: imp.organization_id,
      sessionId: imp.channel_session_id,
      contactId: "",
      conversationId,
    });
    if (linha.metadata.media_status !== "pendente" || !p.id) continue;
    for (const c of candidatosDeExternalId(p)) idNoCanal.set(c, p.id);
  }
  if (idNoCanal.size === 0) return true;

  const { data, error } = await buscaEmLotes(
    [...idNoCanal.keys()],
    (lote) =>
      admin
        .from("messages")
        .select("id, external_id, metadata")
        .eq("organization_id", imp.organization_id)
        .in("external_id", lote),
    { bytesPorLote: BYTES_DE_CANDIDATOS_POR_CONSULTA },
  );
  if (error) throw new Error(`messages_consulta_midia: ${mensagemDeErro(error)}`);

  const linhas = (data ?? []) as Array<{ id: string; external_id: string; metadata: Record<string, unknown> | null }>;
  let restouPendente = false;
  /** Tentativa sem veredito: conta e, na 3ª, desiste da mídia. */
  const contarTentativa = async (id: string, meta: Record<string, unknown>) => {
    const tentativas = (typeof meta.tentativas_midia === "number" ? meta.tentativas_midia : 0) + 1;
    if (tentativas < LIMITE_DE_TENTATIVAS_DE_MIDIA) {
      await atualizarMensagem(admin, imp, id, { metadata: { ...meta, tentativas_midia: tentativas } });
      restouPendente = true;
      return { tentativas, desistiu: false };
    }
    await atualizarMensagem(admin, imp, id, {
      metadata: { ...meta, tentativas_midia: tentativas, media_status: "indisponivel" },
    });
    ctl.midias.indisponiveis += 1;
    return { tentativas, desistiu: true };
  };
  for (const linha of linhas) {
    const meta = linha.metadata ?? {};
    // Só o que o importador marcou e ainda ninguém resolveu.
    if (meta.historico_importado !== "true" || meta.media_status !== "pendente") continue;
    const messageIdNoCanal = idNoCanal.get(linha.external_id);
    if (!messageIdNoCanal) continue;

    if (ctl.noTeto()) return false;
    ctl.contarChamada();
    let resposta: { url: string | null; erro: boolean };
    try {
      resposta = await canal.baixarMidiaDaMensagem(nomeNoCanal, chatId, messageIdNoCanal, {
        tetoMs: TETO_DO_DOWNLOAD_MS,
      });
    } catch (err) {
      // Limite de 3 tentativas por mensagem: sem ele, uma mídia que o canal
      // recusa SEMPRE (ex.: 500) derrubaria toda rodada na mesma página, e as
      // mídias seguintes nunca seriam alcançadas. Tempo esgotado em UM download
      // não é o canal fora do ar: conta e segue, sem levar a importação a `erro`.
      // Outro erro de transporte: nas duas primeiras a rodada para em erro
      // (cursor firme anterior); na terceira desiste e segue.
      const { desistiu } = await contarTentativa(linha.id, meta);
      if (!desistiu && !ehTempoEsgotado(err)) throw err;
      continue;
    }
    const { url, erro } = resposta;

    if (!url) {
      // `erro: true` é "indisponível, não tente de novo". Sem URL e sem erro o
      // canal não devolveu o arquivo agora (não é veredito): conta tentativa,
      // fica `pendente` até a 3ª e a página é refeita para tentar de novo.
      if (erro) {
        await atualizarMensagem(admin, imp, linha.id, { metadata: { ...meta, media_status: "indisponivel" } });
        ctl.midias.indisponiveis += 1;
      } else {
        await contarTentativa(linha.id, meta);
      }
      continue;
    }

    // `solicitada` (e não `pendente`) para uma página refeita não pedir de novo; o
    // worker troca por `stored`. Leia-modifique-escreva: `historico_importado` fica.
    await atualizarMensagem(admin, imp, linha.id, {
      media_url: url,
      metadata: { ...meta, media_status: "solicitada" },
    });
    const { error: erroDoEmit } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: linha.id,
      p_payload: { message_id: linha.id, conversation_id: conversationId },
      p_metadata: { source: "historico_importado" },
      p_organization_id: imp.organization_id,
    } as never);
    if (erroDoEmit) {
      // Desfaz para a próxima rodada tentar de novo; o pedido não saiu.
      await atualizarMensagem(admin, imp, linha.id, { media_url: null, metadata: meta });
      throw new Error(`emit_event: ${mensagemDeErro(erroDoEmit)}`);
    }
    ctl.midias.baixadas += 1;
  }
  return !restouPendente;
}

/** O teto de tempo do pedido estourou (o cliente do WAHA diz `waha_timeout`). */
function ehTempoEsgotado(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("waha_timeout");
}
