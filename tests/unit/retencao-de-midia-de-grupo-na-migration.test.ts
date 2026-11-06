/**
 * Mídia de GRUPO vence em `group_media_retention_days` (piso 7); conversa normal
 * segue em `media_retention_days` (piso 30). Lê a migration 9222 como texto: o
 * CTE `alvo` é onde o prazo é escolhido, e o anexo da nota (passo 2c) não muda.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20261106120000_9222_midia_de_grupo_vence_antes.sql",
  "utf8",
);
const alvo = sql.slice(sql.indexOf("with alvo as"), sql.indexOf("), fila as"));
const ramoGrupo = "case when c.is_group";

describe("fn_enfileirar_midia_vencida: prazo por tipo de conversa", () => {
  it("o alvo junta a conversa e usa o prazo de grupo só para is_group", () => {
    expect(alvo).toContain("join public.conversations c on c.id = m.conversation_id");
    expect(alvo).toContain("then least(greatest(o.group_media_retention_days, 7), greatest(coalesce(o.media_retention_days, 365), 30))");
    expect(alvo).toContain("else greatest(coalesce(o.media_retention_days, 365), 30)");
  });

  it("retencao_dias e o filtro de idade usam o MESMO ramo", () => {
    expect(alvo.split(ramoGrupo).length - 1).toBe(2);
    expect(alvo).toMatch(/make_interval\(days => case when c\.is_group/);
  });

  it("o interruptor media_retention_enforced segue valendo e a coluna é limitada a 7..365", () => {
    expect(alvo).toContain("o.media_retention_enforced");
    expect(sql).toMatch(/group_media_retention_days integer not null default 30/);
    expect(sql).toMatch(/between 7 and 365/);
  });

  it("o anexo da nota interna continua só com o prazo da conversa normal", () => {
    const nota = sql.slice(sql.indexOf("limpas_da_nota") - 2000);
    expect(nota).toContain("greatest(coalesce(o.media_retention_days, 365), 30)");
  });

  it("função segue fechada ao service_role", () => {
    expect(sql).toMatch(/revoke execute on function public\.fn_enfileirar_midia_vencida\(integer\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.fn_enfileirar_midia_vencida\(integer\) to service_role/);
  });
});
