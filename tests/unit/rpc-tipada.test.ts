/**
 * `rpc()` (lib/supabase/rpc.ts) confere nome e argumentos da RPC contra
 * `database.types.ts`. As linhas com `@ts-expect-error` SÃO a cerca: se o
 * helper parar de acusar, o `pnpm typecheck` reprova com "Unused
 * '@ts-expect-error' directive".
 */
import { describe, expect, it, vi } from "vitest";

import { rpc } from "@/lib/supabase/rpc";

function cliente() {
  return { rpc: vi.fn(async () => ({ data: "ok", error: null })) } as never;
}

describe("rpc tipada", () => {
  it("repassa nome e argumentos ao cliente, uma chamada", async () => {
    const c = cliente() as { rpc: ReturnType<typeof vi.fn> };
    const args = { p_event_type: "x", p_entity_kind: "crm_lead", p_entity_id: "1" };
    const r = await rpc(c as never, "emit_event", args);
    expect(c.rpc).toHaveBeenCalledWith("emit_event", args);
    expect(r.data).toBe("ok");
  });

  it("função sem parâmetro é chamada sem argumentos", async () => {
    const c = cliente() as { rpc: ReturnType<typeof vi.fn> };
    await rpc(c as never, "fn_agora");
    expect(c.rpc).toHaveBeenCalledWith("fn_agora", undefined);
  });

  it("o compilador recusa nome e argumento errados", () => {
    const c = cliente();
    const nuncaChama = () => {
      // @ts-expect-error nome que não existe em Database["public"]["Functions"]
      void rpc(c, "fn_que_nao_existe", {});
      // @ts-expect-error argumento com nome errado
      void rpc(c, "emit_event", { p_event_tipo: "x", p_entity_kind: "k", p_entity_id: "1" });
      // @ts-expect-error falta argumento obrigatório
      void rpc(c, "emit_event", { p_entity_kind: "k", p_entity_id: "1" });
      // jsonb aceita objeto de interface sem index signature
      const payload: { a: string } = { a: "x" };
      void rpc(c, "emit_event", { p_event_type: "x", p_entity_kind: "k", p_entity_id: "1", p_payload: payload });
    };
    expect(typeof nuncaChama).toBe("function");
  });
});
