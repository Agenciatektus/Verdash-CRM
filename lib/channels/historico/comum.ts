import type { WahaPayload } from "@/lib/waha/ingest";
import type { CursorDaImportacao } from "@/lib/channels/historico/rodada";
import type { EscopoDaImportacao } from "@/lib/channels/historico/fichas-do-crm";

/** Tipos e utilidades que as peças da rodada do histórico (#999) dividem. */

/**
 * Orçamento, em bytes codificados, dos `external_id` de UMA consulta de
 * deduplicação. Uma página de 100 mensagens de chat `@s.whatsapp.net` dá 300
 * candidatos de até ~70 B cada (13 a 19 KB de URL), e o Kong 2.8.1 devolve 414
 * acima de 8.192 B. Com 4 KB de valores, a URL inteira fica perto de 4,3 KB.
 */
export const BYTES_DE_CANDIDATOS_POR_CONSULTA = 4096;

export interface Importacao {
  id: string;
  organization_id: string;
  channel_session_id: string;
  status: string;
  /** `null` quando a janela é `desde`/`ate` (importação da queda). */
  dias: number | null;
  /** Ausentes nas linhas antigas (e nos dublês de teste): valem os padrões. */
  escopo?: EscopoDaImportacao | null;
  origem?: "manual" | "queda" | null;
  desde?: string | null;
  ate?: string | null;
  cursor: Partial<CursorDaImportacao> | null;
  conversas_feitas: number | null;
  mensagens_gravadas: number | null;
  mensagens_existentes: number | null;
  mensagens_ignoradas: number | null;
  midias_baixadas: number | null;
  midias_indisponiveis: number | null;
  fonte?: string | null;
  credencial_cifrada?: string | null;
}

export function mensagemDeErro(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Vocabulário aberto de fontes (a coluna `fonte` não tem CHECK; doutrina da 0127). */
export type FonteDoHistorico = "waha" | "izzy";

/**
 * O que a rodada pede à fonte do histórico. O cliente do WAHA já tem esta forma;
 * a fonte do Izzy (`fonte-izzy.ts`) devolve o mesmo formato de payload.
 */
export interface FonteDeHistorico {
  paginaDeConversas(
    session: string,
    opts: { limit: number; offset: number },
  ): Promise<{ conversas: Array<{ chatId: string; ultimaEm: number | null; posicao: number }>; lidas: number; semTelefone?: number[] }>;
  paginaDeMensagens(
    session: string,
    chatId: string,
    opts: { limit: number; offset: number; desde: number },
  ): Promise<{ mensagens: WahaPayload[]; lidas: number }>;
  resolvePhoneForLid(session: string, lid: string, opts?: { falhaLanca?: boolean }): Promise<string | null>;
  baixarMidiaDaMensagem(
    session: string,
    chatId: string,
    messageId: string,
    opts?: { tetoMs?: number },
  ): Promise<{ url: string | null; erro: boolean }>;
}

/** A fonte pediu para esperar (limite de chamadas, servidor sob carga): não é erro, a próxima rodada retoma. */
export class FonteAdiada extends Error {}
