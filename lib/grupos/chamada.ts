/**
 * "Chamada" no modo `chamada` da IA em grupo (9224): a mensagem recebida (a) responde
 * (cita) uma mensagem enviada por este número, ou (b) marca este número com @, em
 * `contextInfo.participant`/`mentionedJid` (telefone OU LID, os dois endereçamentos).
 * Função pura: quem consulta o banco (a citada é nossa?) é `lib/channels/verdash/grupo.ts`.
 */
export interface ContextoDaMensagem {
  /** Id da mensagem citada (`stanzaId`). */
  citada: string | null;
  /** JIDs: autor da citada + marcados. */
  jids: string[];
}

export interface EuMesmo {
  phone: string | null;
  lid: string | null;
}

const PROFUNDIDADE = 6;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function achar(no: unknown, nivel = 0): Record<string, unknown> | null {
  if (typeof no !== "object" || no === null || nivel > PROFUNDIDADE) return null;
  const o = no as Record<string, unknown>;
  const direto = o.contextInfo ?? o.ContextInfo;
  if (typeof direto === "object" && direto !== null) return direto as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k === "quotedMessage" || k === "QuotedMessage") continue; // o contexto da citada não é desta mensagem.
    const r = achar(v, nivel + 1);
    if (r) return r;
  }
  return null;
}

/** `contextInfo` de QUALQUER tipo de mensagem (texto, imagem, vídeo...), com as duas grafias do FZAP. */
export function contextoDaMensagem(message: unknown): ContextoDaMensagem {
  const ci = achar(message);
  if (!ci) return { citada: null, jids: [] };
  const marcados = ci.mentionedJid ?? ci.mentionedJID ?? ci.MentionedJID;
  const lista = Array.isArray(marcados) ? marcados.map(str) : [];
  const jids = [str(ci.participant) ?? str(ci.Participant), ...lista].filter((j): j is string => !!j);
  return { citada: str(ci.stanzaId) ?? str(ci.stanzaID) ?? str(ci.StanzaID), jids };
}

const digitos = (v: string) => v.replace(/\D/g, "");

/** `5566…:12@s.whatsapp.net` e `123@lid` → dígitos do usuário (sem o sufixo de dispositivo). */
function usuario(jid: string): { dom: "lid" | "tel"; d: string } | null {
  const [u, dom] = jid.split("@");
  const d = digitos((u ?? "").split(":")[0] ?? "");
  if (!d) return null;
  return { dom: dom === "lid" ? "lid" : "tel", d };
}

/** Telefone BR com ou sem o nono dígito: compara pelo prefixo 55+DDD e os 8 últimos. */
const mesmoTelefone = (a: string, b: string) => a === b || (a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8) && a.slice(0, 2) === b.slice(0, 2));

export function ehChamada(ctx: ContextoDaMensagem, eu: EuMesmo, citouMensagemDoNumero: boolean): boolean {
  if (citouMensagemDoNumero) return true;
  const meuTel = eu.phone ? digitos(eu.phone) : null;
  const meuLid = eu.lid ? digitos(eu.lid) : null;
  return ctx.jids.some((j) => {
    const u = usuario(j);
    if (!u) return false;
    return u.dom === "lid" ? meuLid !== null && u.d === meuLid : meuTel !== null && mesmoTelefone(u.d, meuTel);
  });
}
