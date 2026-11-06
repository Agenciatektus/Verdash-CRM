import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { identidadeDoChat } from "@/lib/channels/historico/mapear";
import { mensagemDeErro, type Importacao } from "@/lib/channels/historico/comum";
import { parseChatId, type WahaPayload } from "@/lib/waha/ingest";

/**
 * QUEM FOI APAGADO A PEDIDO NÃO VOLTA PELO HISTÓRICO (LGPD; doc 186, B). O
 * celular ainda guarda as conversas de quem pediu para ser apagado; sem esta
 * pergunta, a importação recriaria o contato e as mensagens.
 *
 * Pergunta por TODAS as identidades da página e do chat (cada telefone
 * canônico, cada lid, os alternativos do `_data.key`, o telefone que o canal
 * resolveu para o lid do chat), uma chamada por
 * identidade ainda não conferida nesta conversa: qualquer uma marcada basta.
 * Roda em cada página da passada de conferência, que lê a conversa inteira
 * antes de a primeira linha ser gravada, e de novo na de gravação. Erro na pergunta para a rodada (falha fechada):
 * importar na dúvida desfaria o apagamento.
 */
export async function titularApagadoNaPagina(
  admin: SupabaseClient,
  imp: Importacao,
  chatId: string,
  telefoneDoChat: string | null,
  mensagens: WahaPayload[],
  conferidas: Set<string>,
): Promise<boolean> {
  const telefones = new Set<string>();
  const lids = new Set<string>();
  const anotar = (phone: string | null, lid: string | null) => {
    if (phone) telefones.add(canonicalPhoneBR(phone));
    if (lid) lids.add(lid);
  };
  const anotarJid = (jid: string | null | undefined) => {
    if (!jid) return;
    const p = parseChatId(jid);
    anotar(p.phone, p.lid);
  };
  anotarJid(chatId);
  anotar(telefoneDoChat, null);
  for (const p of mensagens) {
    const id = identidadeDoChat(p);
    anotar(id.phone, id.lid);
    anotarJid(id.chatId);
    anotarJid(p._data?.key?.remoteJidAlt);
    anotarJid(p._data?.key?.participantAlt);
  }
  const perguntas = [
    ...[...telefones].map((t) => ({ chave: `t:${t}`, p_telefone: t, p_lid: null })),
    ...[...lids].map((l) => ({ chave: `l:${l}`, p_telefone: null, p_lid: l })),
  ].filter((q) => !conferidas.has(q.chave));
  for (const { chave, p_telefone, p_lid } of perguntas) {
    const { data: apagado, error } = await admin.rpc("fn_titular_apagado_a_pedido" as never, {
      p_org: imp.organization_id,
      p_telefone,
      p_lid,
    } as never);
    if (error) throw new Error(`fn_titular_apagado_a_pedido: ${mensagemDeErro(error)}`);
    // Resposta que não é sim/não também para a rodada: na dúvida, não importa.
    if (typeof apagado !== "boolean") throw new Error("fn_titular_apagado_a_pedido: resposta sem booleano");
    if (apagado) return true;
    conferidas.add(chave);
  }
  return false;
}
