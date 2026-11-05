/**
 * "Tentar de novo" numa mensagem enviada que FALHOU (B15 da auditoria do
 * visual v2).
 *
 * ─── O desenho: linha NOVA com vínculo, pela MESMA rota de envio ────────────
 *
 * O reenvio é um `POST /api/v1/messages` comum, com o mesmo conteúdo e
 * `reenvio_de: <id da que falhou>`. Passa por tudo que um envio passa (papel,
 * suporte, ritmo, cadeia `before_send`, auditoria). A linha que falhou NÃO é
 * reaproveitada: `status` de mensagem é escrito pelo motor e pelo webhook do
 * provedor (ack, `failed` com o motivo), e reabrir uma linha `failed` para
 * `queued` faria o histórico dizer que ela nunca falhou. A nova leva
 * `metadata.reenvio_de`, e a tela esconde o botão da que já foi reenviada.
 *
 * Mensagem de SAÍDA não acorda a IA: os gatilhos de `messages` que disparam o
 * agente olham `direction = 'inbound'`. Nada aqui grava entrada.
 *
 * ─── As recusas, aqui no servidor, e não só na tela ─────────────────────────
 *
 *   - a mensagem tem de existir NESTA organização e NESTA conversa;
 *   - tem de ser de saída e estar `failed`;
 *   - tem de ser do canal ATUAL da conversa (se a conversa mudou de número, o
 *     cliente receberia por outro número uma mensagem "repetida");
 *   - não pode já ter sido reenviada. O índice único
 *     `messages_reenvio_unico` (migration 9048) é a trava que vale contra dois
 *     cliques simultâneos; a consulta abaixo só dá a mensagem legível antes.
 */
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export interface PedidoDeReenvio {
  organizationId: string;
  conversationId: string;
  /** O canal ATUAL da conversa, lido pelo handler de envio. */
  channelSessionId: string;
  reenvioDe: string;
  requestId: string;
  idioma?: Idioma;
}

export async function validarReenvio(supabase: SupabaseClient, p: PedidoDeReenvio): Promise<void> {
  const t = (texto: string) => traduzir(texto, p.idioma ?? "pt-BR");
  const { data: original, error } = await supabase
    .from("messages")
    .select("id, conversation_id, channel_session_id, direction, status")
    .eq("organization_id", p.organizationId)
    .eq("id", p.reenvioDe)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, p.requestId, error.message);
  const linha = original as {
    conversation_id: string;
    channel_session_id: string;
    direction: string;
    status: string;
  } | null;
  if (!linha || linha.conversation_id !== p.conversationId) {
    throw new ApiError(404, "not_found", undefined, p.requestId, t("A mensagem a reenviar não existe nesta conversa."));
  }
  if (linha.direction !== "outbound" || linha.status !== "failed") {
    throw new ApiError(409, "conflict", undefined, p.requestId, t("Só uma mensagem enviada que falhou pode ser reenviada."));
  }
  if (linha.channel_session_id !== p.channelSessionId) {
    throw new ApiError(
      409,
      "conflict",
      undefined,
      p.requestId,
      t("A conversa mudou de número desde o envio. Escreva uma mensagem nova."),
    );
  }
  const { data: jaReenviada, error: erroDaConsulta } = await supabase
    .from("messages")
    .select("id")
    .eq("organization_id", p.organizationId)
    .eq("conversation_id", p.conversationId)
    .eq("metadata->>reenvio_de", p.reenvioDe)
    .limit(1);
  if (erroDaConsulta) throw new ApiError(500, "internal_error", undefined, p.requestId, erroDaConsulta.message);
  if ((jaReenviada ?? []).length > 0) throw jaFoiReenviada(p.requestId, p.idioma);
}

/** A recusa de reenvio repetido: a da consulta e a do índice único (23505). */
export function jaFoiReenviada(requestId: string, idioma?: Idioma): ApiError {
  return new ApiError(
    409,
    "already_retried",
    undefined,
    requestId,
    traduzir("Esta mensagem já foi reenviada.", idioma ?? "pt-BR"),
  );
}

/**
 * QUAIS MENSAGENS PODEM SER ENVIADAS DE NOVO, e se pedem confirmação antes.
 *
 * Uma regra só, lida em dois lugares: a rota `POST /api/v1/messages/{id}/retry`
 * a usa como autoridade e a bolha a usa para decidir se desenha o botão. Se as
 * duas tivessem regra própria, a tela ofereceria um toque que o servidor recusa.
 *
 * - `seguro`: nada saiu. Reenviar não duplica.
 * - `confirmar`: pode ter saído (o canal não respondeu, ou respondeu algo que
 *   não sabemos ler). Quem reenvia confere antes no WhatsApp do cliente. O
 *   desconhecido cai AQUI de propósito: perguntar custa um toque, duplicar
 *   custa a confiança do cliente.
 * - `nenhum`: está em voo, já saiu, ou reenviar não resolve.
 *
 * Fica de fora o que não foi uma pessoa que escreveu: IA, automação e
 * integração já têm quem tente de novo (o motor do agente tem o próprio
 * ledger), e um reenvio humano por cima sairia em dobro.
 */

export type TipoDeReenvio = "seguro" | "confirmar" | "nenhum";

/** O recorte de `Message` que a regra lê — a linha do banco e a da tela cabem nele. */
export interface MensagemDoReenvio {
  organization_id: string;
  conversation_id: string;
  direction: string;
  sent_via: string;
  sent_by_user_id: string | null;
  type: string;
  body: string | null;
  status: string;
  error_code: string | null;
  media_storage_path: string | null;
  metadata: unknown;
  updated_at?: string | null;
}

/** Linha `queued` sem motivo há mais que isto: o processo pode ter morrido entre o envio e a marca. */
export const QUEUED_PARADA_MS = 5 * 60 * 1000;

const TIPOS_DE_MIDIA = new Set(["image", "audio", "video", "document", "sticker"]);

/** Nada saiu, e reenviar pode resolver. */
const FALHA_SEGURA = new Set([
  "storage_sign_failed",
  "channel_disabled",
  // Recusa definitiva da plataforma oficial, sem relação com a nota do número:
  // fora da janela (a rota confere a janela antes), e falha de mídia/genérica.
  "131047",
  "131052",
  "131053",
  "131000",
]);

/** Reenviar não resolve, ou insistir piora a reputação do número. */
const FALHA_SEM_REENVIO = new Set([
  "channel_archived",
  "missing_phone_number",
  // Número sem WhatsApp.
  "131026",
  // Limites de envio, de spam e de qualidade: um toque a mais é o que derruba o número.
  "131048",
  "131049",
  "131056",
  "130429",
  "368",
]);

export function reenvioDaMensagem(
  msg: MensagemDoReenvio,
  quem: { userId: string | null | undefined; podeReenviarDeOutros: boolean; agora?: number },
): TipoDeReenvio {
  if (msg.direction !== "outbound" || !["user", "crm"].includes(msg.sent_via)) return "nenhum";
  if (!quem.userId || (msg.sent_by_user_id !== quem.userId && !quem.podeReenviarDeOutros)) return "nenhum";

  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const conteudoReenviavel =
    msg.type === "text"
      ? Boolean(msg.body)
      : TIPOS_DE_MIDIA.has(msg.type) &&
        // O envio só aceita arquivo da pasta desta conversa (`isMediaPathOwnedBy`
        // no handler). Mídia de outro lugar — o PDF de uma proposta, por exemplo —
        // seria um botão que sempre recusa.
        Boolean(msg.media_storage_path) &&
        isMediaPathOwnedBy(msg.media_storage_path ?? "", msg.organization_id, msg.conversation_id) &&
        meta.media_status !== "expired";
  if (!conteudoReenviavel) return "nenhum";

  if (msg.status === "failed") {
    const codigo = msg.error_code ?? "";
    if (FALHA_SEGURA.has(codigo)) return "seguro";
    if (FALHA_SEM_REENVIO.has(codigo) || codigo.startsWith("pre_go_live")) return "nenhum";
    return "confirmar";
  }

  if (msg.status === "queued") {
    if (meta.queued_reason) return "seguro";
    // O relógio é o `updated_at`: o reenvio adianta ele, e é isso que faz um
    // segundo toque durante o envio cair em "em voo" em vez de reenviar.
    if (!msg.updated_at) return "nenhum";
    const agora = quem.agora ?? Date.now();
    return agora - new Date(msg.updated_at).getTime() >= QUEUED_PARADA_MS ? "confirmar" : "nenhum";
  }

  return "nenhum";
}
