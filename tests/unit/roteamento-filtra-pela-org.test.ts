/**
 * As escritas do roteamento (F3, `turno/roteamento.ts`) rodam com o pool do worker,
 * fora da RLS: o filtro de organização é o texto da query. Cerca por texto para que
 * o update da conversa e a decisão do roteador não percam o tenant (P2-2 da #473).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/turno/roteamento.ts"), "utf8");

describe("roteamento escreve só na organização do turno", () => {
  it("o update da conversa filtra por organization_id = $1 com o tenantId", () => {
    const update = fonte.match(/update conversations[\s\S]*?\[([^\]]*)\]/);
    expect(update, "update de conversations sumiu do roteamento").not.toBeNull();
    expect(update![0]).toMatch(/where organization_id = \$1 and id = \$2/);
    expect(update![1]!.trim().startsWith("tenantId,")).toBe(true);
  });

  it("a decisão do roteador grava organization_id como $1 = tenantId", () => {
    const insert = fonte.match(/insert into ai_router_decisions\s*\(\s*organization_id,[\s\S]*?values \(\$1,[\s\S]*?\[\s*([^,\]]+)/);
    expect(insert, "insert de ai_router_decisions sumiu ou mudou de forma").not.toBeNull();
    expect(insert![1]!.trim()).toBe("tenantId");
  });
});
