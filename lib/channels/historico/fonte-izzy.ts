/**
 * Fonte do histórico: o Izzy CRM (API pública com Bearer `izzy_...`). Devolve o
 * mesmo formato que o cliente do WAHA, então a rodada, o mapeador, a trava de
 * apagamento e a gravação não mudam.
 *
 * Campos conferidos com dado real (06/11): conversa `last_message_at` (ISO), `last_message_preview`,
 *   `contact` embutido (`id`, `name`, `phone`) ou, na falta, GET /contacts/{contact_id};
 *   mensagem `created_at` (ISO), `message_type`, `content`, `direction` inbound|outbound, `metadata.coex|echo`.
 *
 * O token NUNCA entra em mensagem de erro, log ou resposta.
 */
import { FonteAdiada, type FonteDeHistorico } from "@/lib/channels/historico/comum";
import type { WahaPayload } from "@/lib/waha/ingest";

export const BASE_DO_IZZY = "https://api.izzycrm.com.br/functions/v1/api-gateway";
/** Tentativas a mais quando /messages devolve vazio numa conversa que tem prévia (servidor sob carga). */
const REPETICOES_NO_VAZIO = 2;
const ESPERA_NO_VAZIO_MS = 1500;

type Obj = Record<string, unknown>;
export interface OpcoesDaFonteIzzy {
  fetch?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

async function pedir(
  token: string,
  caminho: string,
  params: Record<string, string>,
  f: typeof fetch,
): Promise<{ data: unknown; total: number | null }> {
  const url = `${BASE_DO_IZZY}${caminho}?${new URLSearchParams(params)}`;
  let res: Response;
  try {
    res = await f(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error("izzy_rede"); // a mensagem original pode ecoar o pedido
  }
  if (res.status === 429) throw new FonteAdiada("izzy_limite");
  if (res.status === 401 || res.status === 403) throw new Error("izzy_nao_autorizado");
  if (!res.ok) throw new Error(`izzy_${res.status}`);
  const corpo = (await res.json().catch(() => null)) as Obj | null;
  if (!corpo || typeof corpo !== "object") throw new Error("izzy_invalido");
  const meta = corpo.meta as Obj | undefined;
  return { data: corpo.data ?? corpo, total: typeof meta?.total === "number" ? meta.total : null };
}

/** Valida o token e devolve o total de conversas (GET /conversations?limit=1). Lança se o token não vale. */
export async function totalDeConversasDoIzzy(token: string, f: typeof fetch = fetch): Promise<number> {
  const r = await pedir(token, "/v1/conversations", { limit: "1" }, f);
  if (!Array.isArray(r.data)) throw new Error("izzy_invalido");
  return r.total ?? r.data.length;
}

const segundos = (iso: unknown): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const soDigitos = (v: unknown): string | null => {
  const d = (texto(v) ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d : null;
};

export function criarFonteIzzy(token: string, opts: OpcoesDaFonteIzzy = {}): FonteDeHistorico {
  const f = opts.fetch ?? fetch;
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // shortcut: duas conversas do Izzy com o mesmo telefone colidem no chatId (vale a última); separar se aparecer.
  const conversas = new Map<string, { id: string; preview: boolean; nome: string | null }>();
  const contatos = new Map<string, { phone: string | null; nome: string | null }>();

  const contatoDe = async (c: Obj) => {
    const embutido = c.contact as Obj | undefined;
    if (embutido && soDigitos(embutido.phone)) {
      return { phone: soDigitos(embutido.phone), nome: texto(embutido.name) };
    }
    const id = texto(c.contact_id);
    if (!id) return { phone: null, nome: null };
    const cache = contatos.get(id);
    if (cache) return cache;
    const r = await pedir(token, `/v1/contacts/${encodeURIComponent(id)}`, {}, f);
    const o = (r.data ?? {}) as Obj;
    const achado = { phone: soDigitos(o.phone), nome: texto(o.name) };
    contatos.set(id, achado);
    return achado;
  };

  return {
    async paginaDeConversas(_sessao, { limit, offset }) {
      const r = await pedir(token, "/v1/conversations", { limit: String(limit), offset: String(offset) }, f);
      if (!Array.isArray(r.data)) throw new Error("izzy_invalido");
      const saida: Array<{ chatId: string; ultimaEm: number | null; posicao: number }> = [];
      for (const [i, item] of (r.data as Obj[]).entries()) {
        const id = texto(item?.id);
        if (!id) continue;
        const { phone, nome } = await contatoDe(item);
        if (!phone) continue; // sem telefone não há como ligar ao contato do CRM
        const chatId = `${phone}@s.whatsapp.net`;
        conversas.set(chatId, { id, preview: !!texto(item.last_message_preview), nome });
        saida.push({ chatId, ultimaEm: segundos(item.last_message_at ?? item.updated_at), posicao: offset + i });
      }
      return { conversas: saida, lidas: r.data.length };
    },

    async paginaDeMensagens(_sessao, chatId, { limit, offset, desde }) {
      const conversa = conversas.get(chatId);
      if (!conversa) throw new Error("izzy_conversa_desconhecida");
      const params = { conversation_id: conversa.id, limit: String(limit), offset: String(offset) };
      let r = await pedir(token, "/v1/messages", params, f);
      // Sob carga o Izzy devolve 200 com lista vazia: só é fim se a conversa não tem mensagem alguma.
      for (let t = 0; t < REPETICOES_NO_VAZIO && offset === 0 && conversa.preview && Array.isArray(r.data) && r.data.length === 0; t++) {
        await dormir(ESPERA_NO_VAZIO_MS);
        r = await pedir(token, "/v1/messages", params, f);
      }
      if (!Array.isArray(r.data)) throw new Error("izzy_invalido");
      if (offset === 0 && conversa.preview && r.data.length === 0) throw new FonteAdiada("izzy_vazio_sob_carga");

      const mensagens: WahaPayload[] = [];
      for (const m of r.data as Obj[]) {
        const id = texto(m?.id);
        const timestamp = segundos(m.created_at ?? m.sent_at);
        if (!id || timestamp === null || timestamp < desde) continue;
        const meta = (m.metadata ?? {}) as Obj;
        const fromMe = m.direction === "outbound" || !!meta.coex || !!meta.echo;
        const tipo = texto(m.message_type)?.toLowerCase() ?? "text";
        const corpo = texto(m.content);
        // shortcut: sem mídia nesta versão, vira texto com o marcador do tipo; a mensagem traz `media_url` público e `media_mime_type`, baixar quando for preciso.
        const body = tipo === "text" || tipo === "chat" ? corpo : `[${tipo}]${corpo ? ` ${corpo}` : ""}`;
        mensagens.push({
          id: `${fromMe}_${chatId}_izzy-${id.replace(/_/g, "-")}`,
          ...(fromMe ? { to: chatId } : { from: chatId }),
          fromMe,
          body,
          type: "chat",
          timestamp,
          ...(!fromMe && conversa.nome ? { _data: { notifyName: conversa.nome } } : {}),
        } as WahaPayload);
      }
      return { mensagens, lidas: r.data.length };
    },

    // Chat do Izzy é sempre por telefone: não existe @lid.
    async resolvePhoneForLid() {
      return null;
    },
    // Mídia fora desta versão: o mapeador nunca marca `pendente`, então não é chamada.
    async baixarMidiaDaMensagem() {
      return { url: null, erro: true };
    },
  };
}
