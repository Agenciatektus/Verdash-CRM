/**
 * Cliente da API do MercadoPhone (PDV).
 *
 * `POST https://app.mercadophone.tech/api.php?class=<X>ApiController&method=index|get`,
 * header `Authorization: <token>` (SEM Bearer), corpo `{page, limit, filters}`,
 * resposta `{data:{totalItens, itens}}`. O token nunca entra em log nem em erro.
 */

export const MERCADOPHONE_API_URL = "https://app.mercadophone.tech/api.php";
const TIMEOUT_MS = 10_000;

export class MercadoPhoneApiError extends Error {
  status: number;
  code: "unauthorized" | "forbidden" | "not_found" | "http_error" | "timeout" | "network_error" | "bad_response";

  constructor(status: number, code: MercadoPhoneApiError["code"]) {
    super(`MercadoPhone API ${status} (${code})`);
    this.name = "MercadoPhoneApiError";
    this.status = status;
    this.code = code;
  }
}

export interface MercadoPhonePagina<T = Record<string, unknown>> {
  totalItens: number;
  itens: T[];
}

async function chamar<T>(
  token: string,
  controller: string,
  method: "index" | "get",
  corpo: { page?: number; limit?: number; filters?: Record<string, unknown> },
): Promise<T> {
  if (!token) throw new Error("MercadoPhone: token obrigatório");
  const url = `${MERCADOPHONE_API_URL}?class=${encodeURIComponent(controller)}&method=${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Só o nome do erro: a mensagem do fetch pode carregar a URL ou cabeçalhos.
    const nome = (err as Error)?.name;
    throw new MercadoPhoneApiError(0, nome === "TimeoutError" || nome === "AbortError" ? "timeout" : "network_error");
  }
  if (res.status === 401) throw new MercadoPhoneApiError(401, "unauthorized");
  if (res.status === 403) throw new MercadoPhoneApiError(403, "forbidden");
  if (res.status === 404) throw new MercadoPhoneApiError(404, "not_found");
  if (!res.ok) throw new MercadoPhoneApiError(res.status, "http_error");
  try {
    const json = (await res.json()) as { data?: T };
    if (json?.data === undefined || json.data === null) throw new Error("sem data");
    return json.data;
  } catch {
    throw new MercadoPhoneApiError(res.status, "bad_response");
  }
}

export function listarEstoque(
  token: string,
  { page = 1, limit = 50 }: { page?: number; limit?: number } = {},
): Promise<MercadoPhonePagina> {
  return chamar(token, "EstoqueApiController", "index", { page, limit, filters: {} });
}

/** 404 vira null: cliente que não existe não é erro. */
export async function buscarCliente(token: string, id: number | string): Promise<Record<string, unknown> | null> {
  try {
    return await chamar<Record<string, unknown>>(token, "ClienteApiController", "get", { filters: { id } });
  } catch (err) {
    if (err instanceof MercadoPhoneApiError && err.code === "not_found") return null;
    throw err;
  }
}

export function listarVendas(
  token: string,
  p: { dataVendaInicial: string; dataVendaFinal: string; page?: number; limit?: number },
): Promise<MercadoPhonePagina> {
  return chamar(token, "VendaApiController", "index", {
    page: p.page ?? 1,
    limit: p.limit ?? 50,
    filters: { dataVendaInicial: p.dataVendaInicial, dataVendaFinal: p.dataVendaFinal },
  });
}

/** Itens vendidos com custo e lucro. `order`/`direction` dão 422 neste controller: não enviar. */
export function listarHistorico(
  token: string,
  p: { dataVendaInicial: string; dataVendaFinal: string; page?: number; limit?: number },
): Promise<MercadoPhonePagina> {
  return chamar(token, "HistoricoVendaApiController", "index", {
    page: p.page ?? 1,
    limit: Math.min(p.limit ?? 50, 100),
    filters: { dataVendaInicial: p.dataVendaInicial, dataVendaFinal: p.dataVendaFinal },
  });
}
