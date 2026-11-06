/**
 * A API da vitrine: as chamadas que as amostras fazem nunca saem do navegador.
 *
 * Os componentes da vitrine são os de verdade, e eles leem e gravam pela API.
 * Os testes de cada um trocam o `apiClient` por `vi.mock`; em tempo de execução
 * a troca é aqui, no `fetch`. Enquanto a vitrine está aberta, fica no navegador:
 *
 *  1. TODA escrita (`POST`, `PUT`, `PATCH`, `DELETE`) para `/api/`, venha de onde
 *     vier. É a regra fechada que o Cassio pediu na #164: o "Conversar com" do
 *     cartão de contato faz `fetch` direto, com o id da amostra só no CORPO, e a
 *     rota gravava um contato REAL antes de responder 404. Lista de componentes
 *     não acompanharia o próximo `fetch` direto que alguém escrever; a regra por
 *     método acompanha. O preço: com esta página aberta, a casca também não
 *     grava nada (trocar a disponibilidade, resolver um aviso pelo sino). A
 *     página avisa isso.
 *  2. Leitura com o prefixo das amostras (`lib/design-system/amostras/ids`) na
 *     URL ou no corpo. Nenhum registro de verdade tem esse prefixo.
 *  3. Leitura feita DENTRO de uma consulta do React Query da vitrine
 *     (`clienteDaVitrine` embrulha cada `queryFn`/`mutationFn` em
 *     `dentroDaVitrine`). O `apiClient` chama o `fetch` antes do primeiro
 *     `await`, então a marca ainda está de pé quando ele chega aqui. É isto que
 *     separa a Central de avisos da vitrine da Central do sino, que lê a MESMA
 *     rota pelo React Query da casca.
 *  4. A busca da paleta (Ctrl K) enquanto a paleta DA VITRINE está aberta: ela
 *     chama o `apiClient` direto, num `setTimeout`. A paleta da casca não abre
 *     ao mesmo tempo (as duas são modais).
 *
 *  5. A lista de fluxos de follow-up (`/api/v1/ai/followup-flows`, sem id): o painel do
 *     contato a lê por `apiClient` direto num efeito (fora do React Query) e a URL não
 *     leva id de amostra. A casca não lê esta rota, então nada de verdade se perde.
 *
 * Leitura que não cai em 2 a 5 passa direto: a casca continua lendo do servidor.
 */
import { QueryClient } from "@tanstack/react-query";

import { ehDaVitrine } from "@/lib/design-system/amostras/ids";
import { respostaDaVitrine } from "@/lib/design-system/amostras/respostas";

let profundidade = 0;
let buscaAberta = false;
let original: typeof fetch | null = null;

/** Roda `fn` com a marca de "chamada da vitrine" ligada (síncrono). */
export function dentroDaVitrine<T>(fn: () => T): T {
  profundidade += 1;
  try {
    return fn();
  } finally {
    profundidade -= 1;
  }
}

export function marcarBuscaAberta(aberta: boolean): void {
  buscaAberta = aberta;
}

function enderecoDe(entrada: RequestInfo | URL): string {
  if (typeof entrada === "string") return entrada;
  if (entrada instanceof URL) return entrada.href;
  return entrada.url;
}

const BUSCA_DA_PALETA = /\/api\/v1\/(conversations|contacts|leads)\?/;
const LISTA_DE_FLUXOS = /\/api\/v1\/ai\/followup-flows(\?|$)/;
const ESCRITA = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `/api/...` relativo ou na mesma origem da página. */
function ehDaApi(endereco: string): boolean {
  const base = typeof window === "undefined" ? "http://vitrine.invalid" : window.location.origin;
  try {
    const url = new URL(endereco, base);
    return url.origin === new URL(base).origin && url.pathname.startsWith("/api/");
  } catch (erroDeEndereco) {
    void erroDeEndereco;
    return false;
  }
}

export function ehChamadaDaVitrine(endereco: string, metodo = "GET", corpo: unknown = null): boolean {
  if (ESCRITA.has(metodo.toUpperCase()) && ehDaApi(endereco)) return true;
  if (profundidade > 0) return true;
  if (ehDaVitrine(endereco)) return true;
  if (typeof corpo === "string" && ehDaVitrine(corpo)) return true;
  if (metodo.toUpperCase() === "GET" && LISTA_DE_FLUXOS.test(endereco)) return true;
  return buscaAberta && BUSCA_DA_PALETA.test(endereco);
}

/** Liga o desvio (idempotente). Devolve a função que desliga. */
export function instalarApiDaVitrine(): () => void {
  if (typeof window === "undefined" || original) return () => undefined;
  const anterior = globalThis.fetch;
  const real = anterior.bind(globalThis);
  original = anterior;
  const desvio = (entrada: RequestInfo | URL, init?: RequestInit) => {
    const endereco = enderecoDe(entrada);
    const metodo = init?.method ?? (entrada instanceof Request ? entrada.method : "GET");
    if (!ehChamadaDaVitrine(endereco, metodo, init?.body ?? null)) return real(entrada, init);
    const corpo = JSON.stringify(respostaDaVitrine(metodo, endereco, Date.now()));
    return Promise.resolve(new Response(corpo, { status: 200, headers: { "Content-Type": "application/json" } }));
  };
  globalThis.fetch = desvio;
  return () => {
    // Só devolve o `fetch` se ele ainda é o desvio: se outra camada embrulhou o
    // `fetch` depois (instrumentação carregada tarde), desfazer aqui jogaria o
    // embrulho dela fora.
    if (globalThis.fetch === desvio && original) globalThis.fetch = original;
    original = null;
    buscaAberta = false;
  };
}

function embrulhar<F>(fn: F): F {
  if (typeof fn !== "function") return fn;
  return ((...args: unknown[]) => dentroDaVitrine(() => (fn as (...a: unknown[]) => unknown)(...args))) as F;
}

/**
 * Um React Query só da vitrine. Cada consulta e gravação dele roda marcada
 * (item 3 acima), sem nova tentativa e sem releitura periódica: a amostra é
 * fixa, e a Central de avisos, que relê a cada 30 s, não precisa disso aqui.
 */
export function clienteDaVitrine(): QueryClient {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const consulta = cliente.defaultQueryOptions.bind(cliente);
  cliente.defaultQueryOptions = ((opcoes: Parameters<typeof consulta>[0]) => {
    const base = consulta(opcoes);
    return { ...base, queryFn: embrulhar(base.queryFn), refetchInterval: false, retry: false };
  }) as typeof cliente.defaultQueryOptions;
  const gravacao = cliente.defaultMutationOptions.bind(cliente);
  cliente.defaultMutationOptions = ((opcoes: Parameters<typeof gravacao>[0]) => {
    const base = gravacao(opcoes);
    return { ...base, mutationFn: embrulhar(base.mutationFn), retry: false };
  }) as typeof cliente.defaultMutationOptions;
  return cliente;
}
