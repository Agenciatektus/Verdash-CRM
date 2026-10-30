/**
 * Chamada de RPC com nome, argumentos e retorno conferidos contra
 * `lib/database.types.ts`.
 *
 * Os clientes (`createClient`, `createAdminClient`) não são tipados com
 * `Database`: tipá-los levou o typecheck de ~1,5 min a mais de 10 (medido em
 * 30/10/2026). Sem tipo, `cliente.rpc("x", {...})` aceita qualquer nome e
 * qualquer argumento, e o `as never` que vivia nas chamadas não escondia nada.
 * Este helper confere só a RPC chamada, sem o custo do cliente inteiro.
 *
 * Função nova: declare a assinatura em `Database["public"]["Functions"]` a
 * partir do `supabase/baseline.sql` antes de chamar por aqui.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/database.types";

type Funcoes = Database["public"]["Functions"];

// Parâmetro jsonb aceita qualquer objeto: interface sem index signature não
// casa com `Json`, e o conteúdo do jsonb é livre por definição.
type ArgsRelaxados<A> = {
  [K in keyof A]: Json extends Exclude<A[K], undefined> ? A[K] | object : A[K];
};

// Função sem parâmetro (`Args: never`) é chamada sem o terceiro argumento.
type ArgsDa<N extends keyof Funcoes> = [Funcoes[N]["Args"]] extends [never]
  ? []
  : [args: ArgsRelaxados<Funcoes[N]["Args"]>];

export type RetornoDaRpc<N extends keyof Funcoes> = {
  data: Funcoes[N]["Returns"] | null;
  error: PostgrestError | null;
};

export function rpc<N extends keyof Funcoes & string>(
  cliente: Pick<SupabaseClient, "rpc">,
  nome: N,
  ...args: ArgsDa<N>
): PromiseLike<RetornoDaRpc<N>> {
  // O único cast: o cliente sem tipo devolve `any`; o contrato é o de cima.
  return cliente.rpc(nome, args[0] as Record<string, unknown> | undefined) as PromiseLike<
    RetornoDaRpc<N>
  >;
}
