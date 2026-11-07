import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O CUSTO E O LUCRO DO PDV (order_margins, migration 9240) NÃO VAZAM ENTRE
 * ORGANIZAÇÕES, NEM PARA QUEM ESTÁ ABAIXO DE GESTOR NA PRÓPRIA.
 *
 * Arquivo próprio pelo mesmo motivo de `historico-de-captacao-rls.test.ts`: a
 * policy exige `manager`, e o molde de rls-isolation semeia `agent`, então o
 * controle positivo de lá falharia por acerto. Aqui o gate de papel é medido:
 * o `agent` da própria org (quem atende no WhatsApp) não pode ver quanto a loja
 * paga em cada aparelho.
 *
 * `set role authenticated` + `request.jwt.claims`: o mesmo caminho da produção.
 * Conectar como `postgres` mediria nada (rolbypassrls = t).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(last);
}

// UUIDs próprios para não disputar linhas com os outros arquivos da suíte.
const ORG_A = "dddddddd-9240-4000-8000-00000000000a";
const ORG_B = "dddddddd-9240-4000-8000-00000000000b";
const MANAGER_A = "dddddddd-9241-4000-8000-00000000000a";
const AGENT_A = "dddddddd-9241-4000-8000-00000000000c";
const MANAGER_B = "dddddddd-9241-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'margens-mgr-a@invariant.test'),
      ('${AGENT_A}',   'margens-agent-a@invariant.test'),
      ('${MANAGER_B}', 'margens-mgr-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'margens-inv-a', 'Margens Invariant A', 'Margens A'),
      ('${ORG_B}', 'margens-inv-b', 'Margens Invariant B', 'Margens B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.order_margins
      (organization_id, venda_id, item_seq, produto, categoria, valor_total_cents, valor_custo_cents, lucro_cents, origem, data_venda)
    select v.org, 'inv-1', 1, 'IPHONE SINTETICO', 'Celular', 410000, 375000, 35000, 'Trafego Pago', now()
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
    on conflict (organization_id, venda_id, item_seq) do nothing;
  `);
});

describe("order_margins — isolamento e gate de papel", () => {
  it("o manager da org A lê as margens da PRÓPRIA org (controle positivo)", () => {
    expect(
      countAs(MANAGER_A, `select count(*) from public.order_margins where organization_id = '${ORG_A}';`),
    ).toBeGreaterThan(0);
  });

  it("o manager da org A lê ZERO margens da org B", () => {
    expect(
      countAs(MANAGER_A, `select count(*) from public.order_margins where organization_id = '${ORG_B}';`),
    ).toBe(0);
  });

  it("sem filtro de organização, o manager da org A só alcança as suas", () => {
    const total = countAs(MANAGER_A, `select count(*) from public.order_margins;`);
    const proprias = countAs(
      MANAGER_A,
      `select count(*) from public.order_margins where organization_id = '${ORG_A}';`,
    );
    expect(total).toBe(proprias);
  });

  it("o AGENT da própria org não lê custo nem lucro", () => {
    expect(
      countAs(AGENT_A, `select count(*) from public.order_margins where organization_id = '${ORG_A}';`),
    ).toBe(0);
  });

  it("o manager da org B lê as dele (controle positivo do outro lado)", () => {
    expect(
      countAs(MANAGER_B, `select count(*) from public.order_margins where organization_id = '${ORG_B}';`),
    ).toBeGreaterThan(0);
  });

  it("ninguém com sessão consegue ESCREVER: só o service role grava", () => {
    // Prova por contagem (a recusa sai em stderr, que o execFileSync não lê).
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      do $$
      begin
        insert into public.order_margins
          (organization_id, venda_id, item_seq, valor_total_cents, valor_custo_cents, lucro_cents, data_venda)
          values ('${ORG_A}', 'forjada', 1, 1, 1, 0, now());
      exception when others then
        null;
      end
      $$;
    `);
    const forjadas = Number(
      sql(`select count(*) from public.order_margins where venda_id = 'forjada';`).split("\n").pop(),
    );
    expect(forjadas).toBe(0);
  });
});
