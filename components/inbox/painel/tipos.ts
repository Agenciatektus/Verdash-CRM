import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { EtapaDoSeletor } from "@/components/kanban/SeletorDeEtapa";
import type { ProspectEnrichment } from "@/lib/prospecting/schema";

/**
 * As formas que a rota `crm-summary` devolve, num lugar só.
 *
 * Moravam no topo do `CRMSidePanel` quando o painel era uma rolagem única. Com
 * as abas, cada aba lê um pedaço do MESMO resumo — e cada uma redeclarar a sua
 * cópia do tipo seria o primeiro passo para duas abas discordarem sobre o que a
 * rota manda.
 */
export interface LeadRow {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  /** Mensalidade ao lado do valor único (9028, #3602); ausente no negócio de valor único. */
  recurring_value_cents?: number | null;
  recurring_period?: string | null;
  recurring_months?: number | null;
  updated_at: string;
  pipeline_id: string;
  stage_id: string;
  /** A posição na coluna do quadro: o "Desfazer" da barra de etapas a devolve. */
  position_in_stage?: number | null;
  /** Etapas ativas do funil deste lead, na ordem do quadro (crm-summary). */
  etapas?: EtapaDoSeletor[];
  motivos_de_perda?: string[];
  /** 9044: `false` quando o funil dispensa o motivo de perda (crm-summary). */
  motivo_de_perda_obrigatorio?: boolean;
  custom_fields: Record<string, unknown> | null;
  field_defs: CustomFieldDef[];
  funil_nome: string | null;
  etapa_nome: string | null;
  /** As etapas ativas do funil, na ordem do quadro (rota crm-summary). */
  etapas_do_funil?: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
  /**
   * Dono do negócio. Opcionais porque resposta em cache de antes destes campos
   * existirem não os traz, e ausente não pode virar "sem responsável".
   */
  owner_user_id?: string | null;
  owner_agent_id?: string | null;
  /** O código do motivo, quando o negócio foi perdido. */
  lost_reason?: string | null;
}

export interface OrderRow {
  id: string;
  external_id: string | null;
  status: string | null;
  total_cents: number | null;
  currency: string | null;
  created_at: string;
}

export interface ActivityRow {
  id: string;
  type: string;
  source_module: string;
  performed_at: string;
  payload: Record<string, unknown> | null;
  /** 0071: o porquê legível e quem agiu. */
  reason: string | null;
  actor_kind: string | null;
  /**
   * O NOME de quem agiu. `actor_kind` responde "uma pessoa ou o agente?"; esta
   * responde "qual pessoa?". `null` é estado declarado (sem service role), e aí
   * a linha volta ao rótulo genérico.
   */
  performed_by_name?: string | null;
}

/**
 * Passo 4 do cap. 5: a demanda no lugar onde o humano atende. As outras listas
 * contam o que já aconteceu; esta conta o que ainda não acabou.
 */
export interface DemandaRow {
  id: string;
  revision: number;
  aberta_em: string;
  origem: string;
  estado: string;
  proximo_passo: string | null;
  proximo_passo_em: string | null;
  prazo_em: string | null;
}

export interface DesfechoDraft {
  conversationId: string;
  contactId: string;
  demandaId: string;
  revision: number;
  desfecho: string;
  salvando: boolean;
}

export type Enriquecimento = (ProspectEnrichment & { collected_at: string }) | null;

export interface Fato {
  id: string;
  headline: string;
  body: string;
}

export interface DemandaEncerrada {
  id: string;
  desfecho: string;
  fechada_em: string;
}
