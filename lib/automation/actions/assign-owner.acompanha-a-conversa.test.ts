import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/leads/acompanhar-dono-na-conversa", () => ({
  acompanharDonoNaConversa: vi.fn(async () => 0),
}));
vi.mock("@/lib/automation/actions", () => ({ registerAction: vi.fn() }));

import { acompanharDonoNaConversa } from "@/lib/leads/acompanhar-dono-na-conversa";
import * as acoes from "@/lib/automation/actions";

import "./assign-owner";

function admin() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "update"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: { user_id: "u", role: "agent" }, error: null });
  q.then = (r: (v: unknown) => unknown) => r({ error: null });
  return { from: () => q };
}

const executar = (lead: Record<string, unknown>) => {
  const { execute } = vi.mocked(acoes.registerAction).mock.calls[0]![0] as never as {
    execute: (c: unknown, cfg: unknown) => Promise<{ status: string }>;
  };
  return execute({ admin: admin(), organizationId: "o1", context: { lead } }, { user_id: "u" });
};

beforeEach(() => vi.mocked(acompanharDonoNaConversa).mockClear());

describe("assign_owner e a conversa do contato", () => {
  it("lead sem contact_id: sucesso, e o helper recebe contato vazio (no-op)", async () => {
    const r = await executar({ id: "l1" });
    expect(r.status).toBe("success");
    expect(acompanharDonoNaConversa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactIds: [undefined] }),
    );
  });

  it("lead com contact_id: passa o contato e o novo dono", async () => {
    await executar({ id: "l1", contact_id: "k1" });
    expect(acompanharDonoNaConversa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactIds: ["k1"], novoDonoUserId: "u" }),
    );
  });
});
