import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

describe("organizador_passadas é exclusiva do servidor", () => {
  it("RLS ligada e nenhum papel de navegador acessa", () => {
    expect(sql("select relrowsecurity from pg_class where oid = 'public.organizador_passadas'::regclass")).toBe("t");
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, 'public.organizador_passadas', o))
           from unnest(array['anon','authenticated']) r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) o`,
      ),
    ).toBe("t");
  });
  it("service_role lê e grava (controle: a negação acima não é tabela quebrada)", () => {
    expect(
      sql(
        `select bool_and(has_table_privilege('service_role', 'public.organizador_passadas', o))
           from unnest(array['SELECT','INSERT','UPDATE']) o`,
      ),
    ).toBe("t");
  });
});
