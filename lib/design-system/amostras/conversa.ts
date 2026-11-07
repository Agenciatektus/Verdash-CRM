/**
 * Amostras de conversa para a vitrine do design system: um contato, a conversa,
 * uma mensagem de cada tipo que a Inbox renderiza, a nota interna e a passagem
 * da IA. Tudo com os ids de `./ids`, que a API da vitrine responde sem sair do
 * navegador. Nada aqui é lido do banco.
 */
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { SESSAO_DE_EXEMPLO } from "@/lib/channels/presentation";
import { montarCartoesDaPassagem, type CartaoDaPassagem } from "@/lib/escalacao/cartao-da-passagem";
import type { Message, Note } from "@/lib/types/messaging";

import { IDS } from "./ids";

/** Minutos atrás, em ISO, a partir de um "agora" fixo por render. */
export const minutosAtras = (agora: number, m: number) => new Date(agora - m * 60_000).toISOString();

export function conversaDaVitrine(
  agora: number,
  opcoes: { semTarefa?: boolean; nome?: string } = {},
): ConversationWithContact {
  const contato = opcoes.semTarefa ? IDS.contatoSemTarefa : IDS.contato;
  const nome = opcoes.nome ?? "Mariana Couto";
  return {
    id: opcoes.semTarefa ? IDS.conversaSemTarefa : IDS.conversa,
    organization_id: IDS.org,
    contact_id: contato,
    channel_session_id: IDS.canal,
    channel: "whatsapp",
    status: "open",
    status_changed_at: minutosAtras(agora, 120),
    service_revision: 1,
    service_closed_at: null,
    service_started_at: minutosAtras(agora, 120),
    current_demanda_id: null,
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: null,
    assigned_at: null,
    last_inbound_at: minutosAtras(agora, 14),
    awaiting_since: minutosAtras(agora, 14),
    last_outbound_at: minutosAtras(agora, 30),
    last_message_at: minutosAtras(agora, 14),
    last_message_preview: "Ainda tem horário no sábado?",
    unread_count_for_assignee: 2,
    is_group: false,
    group_chat_id: null,
    tags: ["anuncio-meta"],
    metadata: {},
    snooze_until: null,
    created_at: minutosAtras(agora, 600),
    updated_at: minutosAtras(agora, 14),
    bot_silenced_until: null,
    last_handoff_at: minutosAtras(agora, 20),
    comando_da_conversa: "aguardando",
    contacts: {
      id: contato,
      display_name: nome,
      name: nome,
      phone_number: "+5511984723310",
      tags: ["anuncio-meta", "clareamento"],
      is_blocked: false,
      is_anonymized: false,
    },
    channel_sessions: { phone_number: "+5511900000000", display_name: "WhatsApp", ...SESSAO_DE_EXEMPLO.whatsapp },
  } as ConversationWithContact;
}

/** Uma mensagem válida; cada amostra muda só o que importa para ela. */
export function mensagem(n: number, agora: number, over: Partial<Message> = {}): Message {
  const quando = minutosAtras(agora, 60 - n);
  return {
    id: IDS.mensagem(n),
    organization_id: IDS.org,
    conversation_id: IDS.conversa,
    channel_session_id: IDS.canal,
    contact_id: IDS.contato,
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "read",
    ack: null,
    error_code: null,
    error_message: null,
    body: null,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: quando,
    delivered_at: quando,
    read_at: quando,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: quando,
    ...over,
  } as Message;
}

export function notaDaVitrine(agora: number, corpo: string): Note {
  return {
    id: IDS.nota,
    conversation_id: IDS.conversa,
    body: corpo,
    created_by_user_id: IDS.colega,
    created_by_name: "Bruno",
    created_at: minutosAtras(agora, 9),
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
  };
}

/** O cartão da passagem montado pela MESMA função que o fio usa. */
export function passagemDaVitrine(agora: number): CartaoDaPassagem | null {
  const [cartao] = montarCartoesDaPassagem(
    [
      {
        id: IDS.passagem,
        origem: "pedido_explicito",
        motivo_codigo: "requested_human",
        title: null,
        body: "Cliente quer confirmar horário no sábado de manhã.",
        notes: null,
        content: "Ainda tem horário no sábado?",
        tentativas: [{ o_que: "Ofereci os horários livres da agenda", desfecho: "Cliente pediu uma pessoa" }],
        cliente_avisado: true,
        aviso_motivo_codigo: null,
        caso_id: null,
        criado_em: minutosAtras(agora, 20),
        reconhecido_em: null,
        reconhecido_por: null,
      },
    ],
    { usuarioId: IDS.atendente, donoId: null, donoNome: null },
  );
  return cartao ?? null;
}
