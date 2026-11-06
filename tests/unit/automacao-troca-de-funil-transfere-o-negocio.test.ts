/**
 * A REGRA QUE TROCA DE FUNIL MOVE O MESMO NEGÓCIO — NÃO ABRE UM SEGUNDO (#992, 9053).
 *
 * A ação `create_or_move_lead` com negócio do contato aberto em OUTRO funil (ou com
 * o lead do gatilho em outro funil) MOVE o mesmo card pelo caminho da rota da tela
 * (`moverNegocioDeFunil`, decisão do Peterson de 19/10/2026): nada de clone, nada de
 * origem encerrada como "Levado para outro funil".
 *
 * Controle negativo: nos casos de troca, `createLeadHandler` (o negócio novo, que
 * emite `lead.created` e dispara a cadência) e `encerraDemanda` (a perda) NÃO são
 * chamados. Controles de comportamento: mesmo funil continua sendo `moveLeadHandler`
 * e sem negócio aberto a ação cria, como sempre criou.
 *
 * O bloco do fim prende o motivo canônico da transferência nos lugares que precisam
 * concordar (perdas antigas por clone seguem fora da métrica).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  createLeadHandler: vi.fn(),
  moveLeadHandler: vi.fn(),
  encerraDemanda: vi.fn(),
  moverNegocioDeFunil: vi.fn(),
}));

vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: (...args: unknown[]) => spies.createLeadHandler(...args),
  moveLeadHandler: (...args: unknown[]) => spies.moveLeadHandler(...args),
}));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: (...args: unknown[]) => spies.encerraDemanda(...args),
}));
vi.mock("@/lib/leads/mover-de-funil", () => ({
  moverNegocioDeFunil: (...args: unknown[]) => spies.moverNegocioDeFunil(...args),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: async () => null,
}));

import { getAction } from "@/lib/automation/actions";
import { MOTIVO_PADRAO_DA_TROCA } from "@/lib/leads/motivo-da-perda";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import type { ActionCtx } from "@/lib/automation/types";

import "@/lib/automation/actions/create-or-move-lead";

const MOTIVO_DA_TRANSFERENCIA = "moved_to_another_pipeline";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "c0c0c0c0-0000-0000-0000-000000000001";
const FUNIL_DA_REGRA = "f0f0f0f0-0000-0000-0000-000000000002";
const OUTRO_FUNIL = "f0f0f0f0-0000-0000-0000-000000000003";
const ETAPA_ESCOLHIDA = "e0e0e0e0-0000-0000-0000-000000000002";

const NEGOCIO_EM_OUTRO_FUNIL = {
  id: "1ea1-0000-0000-0000-000000000001",
  pipeline_id: OUTRO_FUNIL,
  stage_id: "e0e0e0e0-0000-0000-0000-0000000000aa",
  status: "won",
  contact_id: CONTATO,
  custom_fields: { ambiente: "cozinha" },
  value_cents: 250000,
};

/** O suficiente do client admin para as leituras que a ação faz. */
function adminFalso(cenarios: { negocioNoFunilDaRegra?: unknown; negocioEmOutroFunil?: unknown; porId?: unknown }) {
  return {
    from() {
      const filtros: Record<string, unknown> = {};
      const api: Record<string, unknown> = {};
      const mesmo = () => api;
      api.select = mesmo;
      api.order = mesmo;
      api.limit = mesmo;
      api.eq = (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return api;
      };
      api.neq = (coluna: string, valor: unknown) => {
        filtros[`neq:${coluna}`] = valor;
        return api;
      };
      const resposta = () => {
        if (filtros.id) return cenarios.porId ?? null;
        if (filtros["neq:pipeline_id"]) return cenarios.negocioEmOutroFunil ?? null;
        return cenarios.negocioNoFunilDaRegra ?? null;
      };
      const terminal = async () => ({ data: resposta(), error: null });
      api.maybeSingle = terminal;
      api.single = terminal;
      return api;
    },
  };
}

function contexto(cenarios: Parameters<typeof adminFalso>[0] = {}, lead?: Record<string, unknown>) {
  return {
    admin: adminFalso(cenarios),
    organizationId: ORG,
    ruleId: "r0r0r0r0-0000-0000-0000-000000000001",
    ruleName: "Ganho vai para o pós-venda",
    event: {},
    context: {
      contact: { id: CONTATO, name: "Marina Prado", phone_number: "+5511900000000" },
      ...(lead ? { lead } : {}),
    },
    requestId: "rule:r0r0r0r0-0000-0000-0000-000000000001",
  } as unknown as ActionCtx;
}

const CONFIG = { pipeline_id: FUNIL_DA_REGRA, stage_id: ETAPA_ESCOLHIDA };
const MOVIDO = { ...NEGOCIO_EM_OUTRO_FUNIL, pipeline_id: FUNIL_DA_REGRA, stage_id: ETAPA_ESCOLHIDA, status: "open" };

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
  spies.moverNegocioDeFunil.mockResolvedValue({ ok: true, lead: MOVIDO });
});

describe("create_or_move_lead — troca de funil move o mesmo card", () => {
  it("contato com negócio aberto em OUTRO funil: move ESSE negócio, sem criar nem encerrar", async () => {
    const ctx = contexto({ negocioEmOutroFunil: NEGOCIO_EM_OUTRO_FUNIL });
    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.moverNegocioDeFunil).toHaveBeenCalledTimes(1);
    const [, , negocio, destino] = spies.moverNegocioDeFunil.mock.calls[0] as unknown[];
    expect((negocio as { id: string }).id).toBe(NEGOCIO_EM_OUTRO_FUNIL.id);
    expect(destino).toMatchObject({ pipelineId: FUNIL_DA_REGRA, stageId: ETAPA_ESCOLHIDA });
    // Controle negativo: nenhum negócio novo (lead.created/cadência) e nenhuma perda.
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
    // As próximas ações da regra enxergam o MESMO id, agora no funil da regra.
    expect(ctx.context.lead as { id: string; pipeline_id: string }).toMatchObject({
      id: NEGOCIO_EM_OUTRO_FUNIL.id,
      pipeline_id: FUNIL_DA_REGRA,
    });
  });

  it("lead do gatilho em outro funil (ex.: ganho em Vendas): move o mesmo card, não falha", async () => {
    const ctx = contexto(
      { porId: NEGOCIO_EM_OUTRO_FUNIL },
      { id: NEGOCIO_EM_OUTRO_FUNIL.id, pipeline_id: OUTRO_FUNIL },
    );
    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.moverNegocioDeFunil).toHaveBeenCalledTimes(1);
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
  });

  it("a recusa da troca vira failed com o código, sem meia execução", async () => {
    spies.moverNegocioDeFunil.mockResolvedValue({
      ok: false,
      status: 422,
      code: "required_fields_missing",
      texto: "x",
    });
    const ctx = contexto({ negocioEmOutroFunil: NEGOCIO_EM_OUTRO_FUNIL });
    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG);

    expect(resultado).toMatchObject({ status: "failed", error: "required_fields_missing" });
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
  });

  it("CONTROLE: negócio aberto no MESMO funil continua sendo movido de etapa", async () => {
    spies.moveLeadHandler.mockResolvedValue({ id: "no-mesmo-funil", pipeline_id: FUNIL_DA_REGRA });
    const ctx = contexto({ negocioNoFunilDaRegra: { id: "no-mesmo-funil" } });
    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(spies.moverNegocioDeFunil).not.toHaveBeenCalled();
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
  });

  it("CONTROLE: sem negócio aberto, a ação cria — como sempre criou", async () => {
    spies.createLeadHandler.mockResolvedValue({ id: "novo-0001", contact_id: CONTATO });
    const ctx = contexto({});
    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    expect(spies.moverNegocioDeFunil).not.toHaveBeenCalled();
  });
});

describe("o motivo da transferência — as duas metades do mesmo nome", () => {
  const raiz = process.cwd();
  const baseline = readFileSync(path.join(raiz, "supabase/baseline.sql"), "utf8");

  it("é o padrão da troca e entra no vocabulário do código", () => {
    expect(MOTIVO_PADRAO_DA_TROCA).toBe(MOTIVO_DA_TRANSFERENCIA);
    expect([...CANONICAL_LOST_REASONS]).toContain(MOTIVO_DA_TRANSFERENCIA);
  });

  it("o trigger aceita o motivo — senão o banco recusa o encerramento com 22023", () => {
    // A ÚLTIMA definição é a que vale no banco (apêndice da 0266, depois do dump).
    const corte = baseline.lastIndexOf(
      "create or replace function public.fn_validate_lost_reason_required",
    );
    expect(corte).toBeGreaterThan(0);
    expect(baseline.slice(corte, corte + 2000)).toContain(`'${MOTIVO_DA_TRANSFERENCIA}'`);
  });

  it("a métrica de perdas não conta a transferência", () => {
    // A ÚLTIMA definição é a que vale (o irmão acima já faz isso): a função tem
    // TRÊS no arquivo — dump, apêndice e apêndice — e o `indexOf` pelo NOME
    // parava na do dump, a definição morta. O recorte daqui até o fim do
    // arquivo é satisfeito pela viva (CLAUDE.md, item 10).
    const corte = baseline.lastIndexOf("create or replace function public.fn_attendant_metrics(");
    expect(corte, "fn_attendant_metrics não encontrada no baseline").toBeGreaterThan(-1);
    const metrica = baseline.slice(corte);
    expect(metrica).toContain(`coalesce(lost_reason, '') <> '${MOTIVO_DA_TRANSFERENCIA}'`);
    // 9053: e conta os desfechos da época (o ganho que saiu com o card segue do responsável).
    expect(metrica.slice(0, 3000)).toContain("from public.crm_desfechos_de_negocio");
  });

  it("a migration 0266 existe, está no baseline e no MANIFEST", () => {
    const arquivos = readFileSync(path.join(raiz, "supabase/migrations/MANIFEST.md"), "utf8");
    expect(arquivos).toContain("0266_");
    expect(baseline).toContain("migration 0266");
  });
});
