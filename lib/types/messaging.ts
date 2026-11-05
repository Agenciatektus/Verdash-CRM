/**
 * Shapes canônicos das tabelas conversations e messages (Spec 03).
 * Espelha o schema do Postgres — atualizar aqui quando a migration mudar.
 */

export interface Conversation {
  /**
   * POR ONDE a conversa entrou no Instagram: `direct` | `comentario`.
   *
   * Null nos outros canais, e tambem em conversa de Instagram anterior a esta
   * coluna. `story` NAO e valor: resposta a story E um Direct e cai na mesma
   * conversa de DM.
   */
  instagram_entrada?: string | null;
  /**
   * Campo calculado (migration 9047): `sem_passo` quando o contato não tem
   * tarefa aberta, `atrasada` quando tem uma vencida, `em_dia` no resto. Nulo em
   * conversa fechada, arquivada, de grupo ou sem contato. Opcional: o cache e o
   * realtime trazem a linha sem ele.
   */
  passo_da_conversa?: "sem_passo" | "atrasada" | "em_dia" | null;
  /** Campo calculado (migration 9047): de quem é a última mensagem. */
  autor_da_ultima_mensagem?: "cliente" | "ia" | "automacao" | "equipe" | null;
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  channel: string;
  status: string;
  status_changed_at: string;
  service_revision?: number;
  service_closed_at?: string | null;
  service_started_at?: string | null;
  current_demanda_id?: string | null;
  assigned_to_user_id: string | null;
  /**
   * Cópia desnormalizada do nome de quem atende (migration 0202), escrita por
   * `fn_conversation_assign` no mesmo UPDATE que grava `assigned_to_user_id`.
   * `null` quando não atribuída, ou quando o backfill/lookup não alcançou —
   * ver `lib/users/com-nome-do-atendente.ts` para o fallback desse caso raro.
   */
  assigned_to_user_name: string | null;
  assignee_kind: string | null;
  assigned_at: string | null;
  last_inbound_at: string | null;
  /**
   * A régua da Fila (migration 0267, issue #990): o instante da mensagem do
   * cliente MAIS ANTIGA que ninguém respondeu ainda — `min(sent_at)` dos inbound
   * posteriores a `last_outbound_at`. É o que ordena a aba Fila, o que a pílula
   * "Aguardando há…" mostra (`esperaDaConversa`) e o que a posição das ferramentas
   * de IA conta. Opcional cobrindo o intervalo entre o deploy deste código e a
   * migration aplicada; `null` quando o cliente nunca escreveu.
   */
  awaiting_since?: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count_for_assignee: number;
  is_group: boolean;
  group_chat_id: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  snooze_until: string | null;
  /**
   * Até quando o atendimento automático está desligado nesta conversa
   * (`'infinity'` depois de passar para uma pessoa). A tela precisa disto para
   * saber SE existe algo a devolver — sem o campo, o botão de retomar não teria
   * como aparecer só quando faz sentido, e a rota ficaria sem porta.
   */
  bot_silenced_until: string | null;
  /**
   * Campo CALCULADO pelo banco (migration 0203) — não é coluna, e por isso não vem
   * em `select=*`: quem o quiser tem de pedi-lo por nome. Opcional porque a
   * resposta de uma versão anterior, ainda em cache do react-query, não o tem.
   */
  comando_da_conversa?: string | null;
  last_handoff_at: string | null;
  /**
   * Por que o automático está parado. Diferencia o handoff formal de uma pausa
   * por resposta no celular (`comandoDaConversa` escolhe o motivo da tela).
   */
  last_handoff_reason?: string | null;
  /**
   * A conversa está marcada como EXEMPLO para o agente aprender (#3006) — o
   * opt-in de LGPD (L-08) que a rota `POST .../usable-for-rag` liga e que o
   * cron `kb-conversations-batch` consome.
   *
   * Opcional de propósito, como `comando_da_conversa`: uma resposta em cache de
   * antes deste campo entrar no `SELECT_COLS` da lista não o tem. AUSENTE é
   * "não afirmo que está marcada", nunca "não está" — e o selo da lista só
   * aparece com `true`, porque afirmar o contrário seria pior.
   */
  usable_for_rag?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Espelha o CHECK `messages_sent_via_check` do banco. O alias exportado existe
 * para o invariante banco×TypeScript ler a fonte real do vocabulário, sem criar
 * uma terceira lista manual só para o teste.
 */
export type SentVia = "user" | "ai" | "system" | "external_device" | "automation" | "crm";

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  channel_session_id: string;
  contact_id: string;
  external_id: string | null;
  type: string;
  direction: "inbound" | "outbound";
  status: string;
  ack: number | null;
  error_code: string | null;
  error_message: string | null;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  /**
   * URL assinada da mídia, que a LISTA de mensagens anexa em lote
   * (`lib/messaging/media/url-assinada.ts`). Ausente fora da lista (realtime,
   * envio): a tela cai na rota `/api/v1/messages/{id}/media`.
   */
  media_signed_url?: string | null;
  /**
   * Miniatura webp da imagem (migration 9033), no bucket `whatsapp-media`, na
   * pasta da organização. Null = sem miniatura: a tela usa a original.
   */
  media_thumb_path?: string | null;
  /** A miniatura assinada no mesmo lote de `media_signed_url`. */
  media_thumb_signed_url?: string | null;
  /**
   * Texto derivado da mídia pelo `workers/media-derive-worker.ts` (a transcrição,
   * no áudio). Null enquanto o worker não rodou, quando a mídia não tem texto, ou
   * depois da anonimização do titular (a cascata LGPD zera a coluna).
   */
  media_derived_text?: string | null;
  /** Estado da derivação (ready/failed/skipped; null = ainda processando, upstream #2133). */
  media_derived_status?: string | null;
  // Espelha o CHECK do banco (messages_sent_via_check): 'crm', 'external_device',
  // 'automation', 'ai', 'user', 'system'. O tipo listava só três e o TypeScript
  // aceitava os demais só porque o dado vem do Supabase sem cast — a tela então
  // não conseguia nem NOMEAR o valor para exibi-lo (ver MessageBubble).
  sent_via: SentVia;
  sent_by_user_id: string | null;
  /**
   * Quem DECIDIU o envio quando o que apertou foi um token (#1613, migration
   * 0416) — a pessoa "em nome de" quem a integração mandou. `null` em todo
   * envio direto, e ausente nas linhas anteriores à coluna. O balão lê este
   * campo junto de `metadata.sent_on_behalf` para dizer "Fulano · via {token}".
   */
  sent_on_behalf_of_user_id?: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  metadata: Record<string, unknown>;
  /**
   * Quando o AUTOR editou no aplicativo (migration 0143). `body` já é a versão
   * nova; este campo existe para a tela poder DIZER que houve edição — ler um
   * combinado sem saber que ele mudou é como o erro começa.
   */
  edited_at: string | null;
  /** Quando o AUTOR apagou para todos. A linha fica; o texto não é mostrado. */
  revoked_at: string | null;
  /** A mensagem que esta responde (citação). `null` = envio solto. */
  reply_to_message_id: string | null;
  created_at: string;
  /**
   * Última escrita na linha (trigger `trg_messages_updated_at`). É o relógio do
   * reenvio (`lib/messaging/reenvio.ts`): linha `queued` parada há muito pode
   * ter perdido o processo que a enviava. Opcional porque linhas montadas fora
   * do `MSG_COLS` (otimistas antigas, fixtures) não o trazem.
   */
  updated_at?: string;
}

/** Nota interna de conversa (Onda 5.2) — nunca vai ao cliente, tabela separada de messages. */
export interface Note {
  id: string;
  conversation_id: string;
  body: string;
  created_by_user_id: string | null;
  created_by_name: string | null;
  created_at: string;
  /**
   * O anexo da nota (#1863, F3), em `internal-media` — nunca no
   * `whatsapp-media`, que é o bucket do canal do cliente. Os três nascem com
   * `null` e continuam `null` em toda nota só de texto: um quarto de nota antiga
   * não muda de forma, só ganha as colunas.
   *
   * O tipo de render não vem do banco: é derivado de `media_mime` por
   * `kindFromMime` (o mesmo corte que aceitou o arquivo no upload).
   */
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
}

/**
 * Mapeia ack do WAHA (0..3) para o status canônico em messages.status.
 * 0=pending/sent server-side, 1=server-confirmed, 2=delivered (device), 3=read.
 */
export function ackToStatus(ack: number | null | undefined): Message["status"] {
  if (ack == null) return "sent";
  if (ack >= 3) return "read";
  if (ack >= 2) return "delivered";
  if (ack >= 1) return "sent";
  return "sending";
}
