/**
 * Gestão de UM grupo de WhatsApp: a lista FECHADA de ações e como cada uma vira chamada ao FZAP.
 * Porte de `supabase/functions/crm-grupo-acao/handler.ts` da Verdash (a edge usa o mesmo contrato).
 * Pareado: só valida aqui e manda o pedido cru à edge; direto: monta e chama o FZAP.
 */

const soDigitos = (v: unknown) => String(v ?? "").split(/[:@]/)[0]!.replace(/\D/g, "");
const JID_DE_GRUPO = /^\d{5,20}(-\d{5,20})?@g\.us$/;
const TELEFONE = /^\d{10,15}$/;
export const OPERACOES_DE_PARTICIPANTE = ["add", "remove", "promote", "demote"] as const;
const DURACOES = ["off", "24h", "7d", "90d"];
// Só JPEG embutido (o WhatsApp exige JPEG): URL faria o FZAP buscar endereço arbitrário. ~2 MB de base64.
const FOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
export const FOTO_MAX = 2_800_000;

export type AcaoDeGrupo =
  | "info" | "link" | "sair" | "nome" | "descricao" | "so_admins_enviam" | "so_admins_editam"
  | "mensagens_temporarias" | "foto" | "remover_foto" | "participantes";

export type PedidoAoFzap = { method: "GET" | "POST"; rota: string; corpo?: Record<string, unknown> };

/** Valida a ação e monta a chamada ao FZAP. `string` = código do erro de validação. */
export function montarChamada(entrada: Record<string, unknown>): PedidoAoFzap | string {
  const groupJid = String(entrada.groupChatId ?? "");
  if (!JID_DE_GRUPO.test(groupJid)) return "grupo_invalido";
  const q = `groupJid=${encodeURIComponent(groupJid)}`;
  switch (entrada.acao) {
    case "info": return { method: "GET", rota: `/group/info?${q}` };
    case "link": return { method: "GET", rota: `/group/invitelink?${q}${entrada.reset === true ? "&reset=true" : ""}` };
    case "sair": return { method: "POST", rota: "/group/leave", corpo: { groupJid } };
    case "nome": {
      const name = String(entrada.nome ?? "").trim();
      if (!name || name.length > 100) return "nome_invalido";
      return { method: "POST", rota: "/group/name", corpo: { groupJid, name } };
    }
    case "descricao": {
      const topic = String(entrada.descricao ?? "");
      if (topic.length > 2048) return "descricao_invalida";
      return { method: "POST", rota: "/group/topic", corpo: { groupJid, topic } };
    }
    case "so_admins_enviam":
      if (typeof entrada.ligado !== "boolean") return "valor_invalido";
      return { method: "POST", rota: "/group/announce", corpo: { groupJid, announce: entrada.ligado } };
    case "so_admins_editam":
      if (typeof entrada.ligado !== "boolean") return "valor_invalido";
      return { method: "POST", rota: "/group/locked", corpo: { groupJid, locked: entrada.ligado } };
    case "mensagens_temporarias": {
      const duration = typeof entrada.duracao === "string" ? entrada.duracao : "";
      if (!DURACOES.includes(duration)) return "duracao_invalida";
      return { method: "POST", rota: "/group/ephemeral", corpo: { groupJid, duration } };
    }
    case "foto": {
      const image = String(entrada.imagem ?? "");
      if (image.length > FOTO_MAX || !FOTO.test(image)) return "foto_invalida";
      return { method: "POST", rota: "/group/photo", corpo: { groupJid, image } };
    }
    case "remover_foto": return { method: "POST", rota: "/group/photo/remove", corpo: { groupJid } };
    case "participantes": {
      const action = entrada.operacao as (typeof OPERACOES_DE_PARTICIPANTE)[number];
      if (!OPERACOES_DE_PARTICIPANTE.includes(action)) return "operacao_invalida";
      const tels = Array.isArray(entrada.telefones) ? entrada.telefones.map((t) => soDigitos(t)) : [];
      if (!tels.length || tels.length > 20 || !tels.every((t) => TELEFONE.test(t))) return "telefones_invalidos";
      return { method: "POST", rota: "/group/updateparticipants", corpo: { groupJid, action, phone: tels.map((t) => `${t}@s.whatsapp.net`) } };
    }
    default: return "acao_invalida";
  }
}

export interface ParticipanteDoGrupo {
  telefone: string | null;
  nome: string | null;
  admin: boolean;
  dono: boolean;
}

export interface InfoDoGrupo {
  subject: string | null;
  descricao: string | null;
  soAdminsEnviam: boolean;
  soAdminsEditam: boolean;
  criadoEm: string | null;
  mensagensTemporarias: "off" | "24h" | "7d" | "90d";
  tipo: "grupo" | "comunidade" | "grupo_da_comunidade";
  total: number;
  /** `null` = este número não está na lista (não dá para afirmar nada). */
  souAdmin: boolean | null;
  participantes: ParticipanteDoGrupo[];
}

/** Info do grupo para o painel: participantes com telefone e papel, e se ESTE número é admin. */
export function infoDoGrupo(data: Record<string, unknown>, meuNumero: string): InfoDoGrupo {
  const parts = (Array.isArray(data.participants) ? data.participants : []) as Array<Record<string, unknown>>;
  const participantes = parts.slice(0, 1100).map((p) => ({
    telefone: soDigitos(p.phoneNumber ?? p.PhoneNumber) || (String(p.jid ?? p.JID ?? "").endsWith("@s.whatsapp.net") ? soDigitos(p.jid ?? p.JID) : null),
    nome: String(p.displayName ?? "").trim().slice(0, 100) || null,
    admin: [p.isAdmin, p.isSuperAdmin, p.IsAdmin, p.IsSuperAdmin].some((x) => x === true),
    dono: p.isSuperAdmin === true || p.IsSuperAdmin === true,
  }));
  const eu = meuNumero ? participantes.find((p) => p.telefone === meuNumero) : undefined;
  return {
    subject: String(data.name ?? "").trim() || null,
    descricao: String(data.topic ?? "") || null,
    soAdminsEnviam: data.isAnnounce === true,
    soAdminsEditam: data.isLocked === true,
    criadoEm: String(data.groupCreated ?? "") || null,
    // Segundos do WhatsApp para o rótulo do seletor: 86400 = 24h, 604800 = 7d, 7776000 = 90d.
    mensagensTemporarias: ({ 86400: "24h", 604800: "7d", 7776000: "90d" } as Record<number, InfoDoGrupo["mensagensTemporarias"]>)[Number(data.disappearingTimer)] ?? "off",
    tipo: data.isParent === true || data.IsParent === true ? "comunidade"
      : String(data.linkedParentJid ?? data.LinkedParentJID ?? "").endsWith("@g.us") ? "grupo_da_comunidade" : "grupo",
    total: typeof data.participantCount === "number" ? data.participantCount : participantes.length,
    souAdmin: eu ? eu.admin : null,
    participantes,
  };
}

/** Erro de transporte/WhatsApp de uma ação, já com o código que a rota traduz para a tela. */
export class GrupoAcaoError extends Error {
  constructor(
    public readonly code: "whatsapp_recusou" | "instancia_desconectada" | "fzap_timeout" | "fzap_indisponivel" | "erro_interno",
    public readonly motivo: string = "",
  ) {
    super(code);
    this.name = "GrupoAcaoError";
  }
}

