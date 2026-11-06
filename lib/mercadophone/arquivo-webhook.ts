/**
 * O que o webhook do MercadoPhone guarda em `webhook_events_log`.
 *
 * LGPD: lista do que se GUARDA, nunca do que se tira. O envelope real do MercadoPhone não é
 * conhecido e a venda pode trazer `clienteNome`, `observacao` (texto livre do balcão, onde
 * cabe telefone ou CPF) e o objeto `cliente`. Guardamos só o tipo, o id e os NOMES das chaves,
 * que bastam para descobrir o formato real sem reter valor de cliente.
 */
type Cru = Record<string, unknown>;

const ENVELOPES = ["dados", "venda", "data"] as const;

export function arquivoSemPii(body: Cru, venda: Cru, tipo: string, vendaId: string): Cru {
  const envelope = ENVELOPES.find((k) => body[k] === venda) ?? null;
  return {
    tipoEvento: tipo,
    venda_id: vendaId,
    envelope,
    chaves_do_corpo: Object.keys(body).slice(0, 80),
    chaves_da_venda: Object.keys(venda).slice(0, 80),
  };
}
