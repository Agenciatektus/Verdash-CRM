/**
 * Banco falso para os testes de edição/apagada (`aplicarAlteracaoDeMensagem`).
 *
 * Responde às três leituras da guarda de autoria (a mensagem original, a
 * conversa e o contato) e registra toda escrita, para o teste provar o que
 * MUDOU e, nos controles negativos, que nada mudou.
 */
export const ORIGINAL_INBOUND = {
  id: "msg-orig",
  channel_session_id: "sess-1",
  direction: "inbound",
  conversation_id: "conv-1",
  contact_id: "ct-1",
};

interface Opcoes {
  original?: Record<string, unknown> | null;
  conversa?: Record<string, unknown> | null;
  contato?: Record<string, unknown> | null;
}

interface Chamada {
  tabela: string;
  op: "select" | "update" | "insert";
  valor?: unknown;
  filtros: Array<[string, unknown]>;
}

export function bancoFalso(opcoes: Opcoes = {}) {
  const linhas: Record<string, unknown> = {
    messages: opcoes.original === undefined ? ORIGINAL_INBOUND : opcoes.original,
    conversations: opcoes.conversa === undefined ? { provider_conversation_id: "100000000000001@lid" } : opcoes.conversa,
    contacts: opcoes.contato === undefined ? { phone_number: "+5513900000000", wa_lid: "100000000000001" } : opcoes.contato,
  };
  const chamadas: Chamada[] = [];

  const admin = {
    rpc: async () => ({ data: null, error: null }),
    from(tabela: string) {
      const c: Chamada = { tabela, op: "select", filtros: [] };
      chamadas.push(c);
      const q = {
        select() { return q; },
        update(valor: unknown) { c.op = "update"; c.valor = valor; return q; },
        insert(valor: unknown) { c.op = "insert"; c.valor = valor; return q; },
        eq(col: string, v: unknown) { c.filtros.push([col, v]); return q; },
        is() { return q; },
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
        // O update devolve a linha alterada (`.select("id")`, upstream #3279): sem linha, o apagar é eco.
        then(ok: (v: unknown) => unknown) {
          return Promise.resolve(ok({ data: c.op === "update" ? [{ id: "msg-orig" }] : null, error: null }));
        },
      };
      return q;
    },
  };

  return {
    admin: admin as never,
    chamadas,
    inseriu: () => chamadas.some((c) => c.op === "insert"),
    update: () => chamadas.find((c) => c.tabela === "messages" && c.op === "update"),
  };
}
