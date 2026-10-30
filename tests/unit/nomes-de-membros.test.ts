import { beforeEach, describe, expect, it, vi } from "vitest";

import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDeMembros } from "@/lib/users/nomes-de-membros";

vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const rpc = vi.fn();
const getUserById = vi.fn();

beforeEach(() => {
  rpc.mockReset();
  getUserById.mockReset();
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  vi.mocked(createAdminClient).mockReturnValue({
    rpc,
    auth: { admin: { getUserById } },
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("nomesDeMembros", () => {
  it("N ids (com repetição e nulos) = UMA chamada ao banco, nenhuma ao GoTrue", async () => {
    rpc.mockResolvedValue({
      data: [
        { user_id: "u1", full_name: "Ana", email: "ana@x.com" },
        { user_id: "u2", full_name: null, email: "bia@x.com" },
      ],
      error: null,
    });

    const r = await nomesDeMembros("org-1", ["u1", "u2", "u1", null, undefined, "u3"]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_nomes_de_membros", {
      p_org: "org-1",
      p_user_ids: ["u1", "u2", "u3"],
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(r.get("u1")).toEqual({ full_name: "Ana", email: "ana@x.com", last_sign_in_at: null });
    expect(r.get("u2")).toEqual({ full_name: null, email: "bia@x.com", last_sign_in_at: null });
    // fora da org (o banco não devolveu): ausente, nunca com nome
    expect(r.has("u3")).toBe(false);
  });

  it("lista vazia não chama o banco", async () => {
    expect((await nomesDeMembros("org-1", [null])).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sem service role ou com erro do banco: mapa vazio, sem lançar", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValueOnce(false);
    expect((await nomesDeMembros("org-1", ["u1"])).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await nomesDeMembros("org-1", ["u1"])).size).toBe(0);
  });
});
