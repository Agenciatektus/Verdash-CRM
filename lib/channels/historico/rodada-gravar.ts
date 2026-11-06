import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import { notifyNameOf, type WahaPayload } from "@/lib/waha/ingest";
import {
  candidatosDeExternalId,
  identidadeDoChat,
  mapearMensagemDoAcervo,
  type LinhaDeMensagemImportada,
} from "@/lib/channels/historico/mapear";
import { BYTES_DE_CANDIDATOS_POR_CONSULTA, mensagemDeErro, type Importacao } from "@/lib/channels/historico/comum";

/**
 * Contato pela MESMA RPC e com o MESMO telefone canônico do ingest ao vivo, e
 * conversa pela irmã que não reabre nem distribui. O nome só vem de mensagem
 * RECEBIDA: na enviada, o `pushName` é o do operador.
 * `ultimaEm` (epoch em segundos, da lista do canal) vira o `last_message_at` da
 * conversa SÓ quando ela nasce aqui: a inbox ordena por essa coluna, e sem ela
 * a conversa importada iria para o fim da lista. Conversa existente fica como está.
 */
export async function garantirContatoEConversa(
  admin: SupabaseClient,
  imp: Importacao,
  chatId: string,
  ultimaEm: number | null,
  mensagens: WahaPayload[],
): Promise<{ contactId: string; conversationId: string } | null> {
  const identidades = mensagens.map(identidadeDoChat);
  const id = identidades.find((x) => x.phone) ?? identidades[0];
  if (!id || (id.kind !== "phone" && id.kind !== "lid")) return null;
  const nome = mensagens
    .filter((p) => p.fromMe !== true)
    .map((p) => notifyNameOf(p)?.trim().slice(0, 200) || null)
    .find((n) => n) ?? null;

  const { data: contactId, error: erroDoContato } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: imp.organization_id,
    p_kind: id.kind,
    p_phone: id.phone ? canonicalPhoneBR(id.phone) : null,
    p_lid: id.kind === "lid" ? id.lid : null,
    p_chat_id: chatId,
    p_notify: nome,
  } as never);
  if (erroDoContato) throw new Error(`fn_upsert_wa_contact: ${mensagemDeErro(erroDoContato)}`);
  if (!contactId) return null;

  const { data: conversationId, error: erroDaConversa } = await admin.rpc(
    "fn_upsert_wa_conversation_importada" as never,
    {
      p_org: imp.organization_id,
      p_contact: contactId,
      p_session: imp.channel_session_id,
      p_last_message_at: ultimaEm !== null ? new Date(ultimaEm * 1000).toISOString() : null,
    } as never,
  );
  if (erroDaConversa) throw new Error(`fn_upsert_wa_conversation_importada: ${mensagemDeErro(erroDaConversa)}`);
  if (!conversationId) throw new Error("fn_upsert_wa_conversation_importada: sem id");
  return { contactId: contactId as string, conversationId: conversationId as string };
}

/**
 * Consulta antes (por TODOS os candidatos de `external_id`, porque o sufixo do
 * chat muda entre o acervo e o webhook) e insere o resto em lote. O unique
 * `(organization_id, external_id)` é DEFERRABLE e não serve para `on conflict`:
 * um 23505 no lote (corrida com o webhook entre a consulta e o insert) recusa
 * o lote inteiro, e aí cada linha vai sozinha, com o 23505 contado como
 * existente.
 */
export async function gravarMensagens(
  admin: SupabaseClient,
  imp: Importacao,
  alvo: { contactId: string; conversationId: string },
  mensagens: WahaPayload[],
  conta: { gravadas: number; existentes: number },
): Promise<void> {
  const candidatos = mensagens.map(candidatosDeExternalId);
  const { data: achadas, error: erroDaConsulta } = await buscaEmLotes(
    [...new Set(candidatos.flat())],
    (lote) =>
      admin
        .from("messages")
        .select("external_id, metadata")
        .eq("organization_id", imp.organization_id)
        .in("external_id", lote),
    { bytesPorLote: BYTES_DE_CANDIDATOS_POR_CONSULTA },
  );
  if (erroDaConsulta) throw new Error(`messages_consulta: ${mensagemDeErro(erroDaConsulta)}`);
  const linhasAchadas = (achadas ?? []) as Array<{ external_id: string | null; metadata?: Record<string, unknown> | null }>;
  const ja = new Set(linhasAchadas.map((m) => m.external_id));
  // Gravadas por ESTA importação numa rodada anterior (página refeita): não contam.
  const proprias = new Set(
    linhasAchadas.filter((m) => m.metadata?.importacao_id === imp.id).map((m) => m.external_id),
  );

  const novas: LinhaDeMensagemImportada[] = [];
  const vistos = new Set<string>();
  mensagens.forEach((p, i) => {
    const mapeada = mapearMensagemDoAcervo(p, {
      orgId: imp.organization_id,
      sessionId: imp.channel_session_id,
      contactId: alvo.contactId,
      conversationId: alvo.conversationId,
    });
    const linha = { ...mapeada, metadata: { ...mapeada.metadata, importacao_id: imp.id } };
    const doCandidato = candidatos[i] ?? [];
    if (doCandidato.some((c) => proprias.has(c))) return;
    // Repetida na própria página também é existente: o lote não pode colidir consigo.
    if (doCandidato.some((c) => ja.has(c)) || vistos.has(linha.external_id)) {
      conta.existentes += 1;
      return;
    }
    vistos.add(linha.external_id);
    novas.push(linha);
  });
  if (novas.length === 0) return;

  const { error: erroDoLote } = await admin.from("messages").insert(novas as never);
  if (!erroDoLote) {
    conta.gravadas += novas.length;
    return;
  }
  if ((erroDoLote as { code?: string }).code !== "23505") {
    throw new Error(`messages_insert: ${mensagemDeErro(erroDoLote)}`);
  }

  for (const linha of novas) {
    const { error } = await admin.from("messages").insert(linha as never);
    if (!error) conta.gravadas += 1;
    else if ((error as { code?: string }).code === "23505") conta.existentes += 1;
    else throw new Error(`messages_insert: ${mensagemDeErro(error)}`);
  }
}

export async function atualizarMensagem(
  admin: SupabaseClient,
  imp: Importacao,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("messages")
    .update(patch as never)
    .eq("id", id)
    .eq("organization_id", imp.organization_id);
  if (error) throw new Error(`messages_update_midia: ${mensagemDeErro(error)}`);
}
