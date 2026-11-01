import { describe, expect, it, vi } from "vitest";

import { decifraCpfsEmLote, TAMANHO_DO_BLOCO_DE_CPF } from "@/lib/contacts/decifrar-cpfs";

function contatos(n: number, comCpf = true) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, cpf_hash: comCpf ? `h${i}` : null }));
}

describe("export de contatos: CPF em lote (migration 9086)", () => {
  it("1.200 contatos com CPF viram 3 chamadas de decrypt_cpf_lote, nunca uma por contato", async () => {
    const rpc = vi.fn(async (_fn: "decrypt_cpf_lote", args: { p_contact_ids: string[] }) => ({
      data: args.p_contact_ids.map((id) => ({ contact_id: id, cpf: `cpf-${id}` })),
      error: null,
    }));
    const cpfs = await decifraCpfsEmLote({ rpc }, contatos(1200));
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.every(([fn]) => fn === "decrypt_cpf_lote")).toBe(true);
    expect(rpc.mock.calls[0]?.[1].p_contact_ids).toHaveLength(TAMANHO_DO_BLOCO_DE_CPF);
    expect(cpfs.size).toBe(1200);
    expect(cpfs.get("c1199")).toBe("cpf-c1199");
  });

  it("contato sem cpf_hash não vai para a RPC; sem nenhum, nenhuma chamada", async () => {
    const rpc = vi.fn();
    expect((await decifraCpfsEmLote({ rpc }, contatos(3, false))).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("bloco que falha degrada para coluna vazia SÓ nele; cpf nulo não entra", async () => {
    let chamada = 0;
    const rpc = vi.fn(async (_fn: "decrypt_cpf_lote", args: { p_contact_ids: string[] }) => {
      chamada += 1;
      if (chamada === 1) return { data: null, error: { message: "forbidden_role" } };
      return {
        data: args.p_contact_ids.map((id, i) => ({ contact_id: id, cpf: i === 0 ? null : `cpf-${id}` })),
        error: null,
      };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cpfs = await decifraCpfsEmLote({ rpc }, contatos(TAMANHO_DO_BLOCO_DE_CPF + 2));
    expect(cpfs.has("c0")).toBe(false);
    expect(cpfs.has(`c${TAMANHO_DO_BLOCO_DE_CPF}`)).toBe(false);
    expect(cpfs.get(`c${TAMANHO_DO_BLOCO_DE_CPF + 1}`)).toBe(`cpf-c${TAMANHO_DO_BLOCO_DE_CPF + 1}`);
  });
});
