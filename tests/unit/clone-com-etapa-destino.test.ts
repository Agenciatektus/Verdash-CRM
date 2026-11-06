/**
 * Levar para outro funil com ETAPA DE ENTRADA escolhida (#3643), no fork em que a
 * troca de funil MOVE o mesmo card (9053, `moverNegocioDeFunil`).
 *
 * O teste do upstream exercitava a RECRIAÇÃO (`createLeadHandler` + 201 + id
 * novo), que não existe mais aqui. As réguas que ele cobrava valem para o mover e
 * moram em `escolheEtapaDeDestino`, que o mover consulta antes de escrever:
 * etapa escolhida, primeira aberta por padrão, 422 de outro funil e 422 de etapa
 * de fechamento. A rota é cercada à parte: repassa `stage_id` ao mover e responde
 * 200 com o MESMO id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { escolheEtapaDeDestino, type EtapaDoFunil } from "@/lib/leads/clonar-para-funil";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { moverNegocioDeFunil } from "@/lib/leads/mover-de-funil";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/leads/mover-de-funil", () => ({ moverNegocioDeFunil: vi.fn() }));

import { POST } from "@/app/api/v1/leads/[id]/clone/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL_ORIGEM = "55555555-5555-4555-8555-555555555555";
const FUNIL_DESTINO = "66666666-6666-4666-8666-666666666666";
const ETAPA_GANHO = "77777777-7777-4777-8777-777777777777";
const ETAPA_PRIMEIRA = "88888888-8888-4888-8888-888888888888";
const ETAPA_SEGUNDA = "99999999-9999-4999-8999-999999999999";
const ETAPA_DE_OUTRO_FUNIL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A etapa de GANHO tem `position` menor que as abertas de propósito. */
const ETAPAS_DO_DESTINO: EtapaDoFunil[] = [
  { id: ETAPA_GANHO, pipeline_id: FUNIL_DESTINO, position: 500, is_won: true, is_lost: false, is_archived: false },
  { id: ETAPA_PRIMEIRA, pipeline_id: FUNIL_DESTINO, position: 1000, is_won: false, is_lost: false, is_archived: false },
  { id: ETAPA_SEGUNDA, pipeline_id: FUNIL_DESTINO, position: 2000, is_won: false, is_lost: false, is_archived: false },
];

describe("a etapa de entrada no funil destino (#3643): a régua que o mover consulta", () => {
  it("etapa ESCOLHIDA: o negócio entra nela", () => {
    const r = escolheEtapaDeDestino(ETAPAS_DO_DESTINO, ETAPA_SEGUNDA);
    expect(r).toMatchObject({ ok: true, etapa: { id: ETAPA_SEGUNDA } });
  });

  it("SEM etapa: a primeira ABERTA (menor position), nunca a de fechamento", () => {
    const r = escolheEtapaDeDestino(ETAPAS_DO_DESTINO, null);
    expect(r).toMatchObject({ ok: true, etapa: { id: ETAPA_PRIMEIRA } });
  });

  it("etapa de OUTRO funil: 422 `stage_pipeline_mismatch`", () => {
    expect(escolheEtapaDeDestino(ETAPAS_DO_DESTINO, ETAPA_DE_OUTRO_FUNIL)).toMatchObject({
      ok: false,
      status: 422,
      code: "stage_pipeline_mismatch",
    });
  });

  it("etapa de FECHAMENTO escolhida: 422 `stage_destino_terminal`", () => {
    expect(escolheEtapaDeDestino(ETAPAS_DO_DESTINO, ETAPA_GANHO)).toMatchObject({
      ok: false,
      status: 422,
      code: "stage_destino_terminal",
    });
  });
});

describe("POST /clone repassa a etapa ao mover e devolve o MESMO card (9053)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: ORG, role: "agent" },
    } as never);
    const negocio = {
      id: LEAD,
      pipeline_id: FUNIL_ORIGEM,
      stage_id: null,
      status: "open",
      contact_id: null,
      custom_fields: {},
      value_cents: 0,
    };
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: negocio, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => cadeia } as never);
  });

  it("com `stage_id`: o mover recebe a etapa e a resposta é 200 com o id da origem", async () => {
    vi.mocked(moverNegocioDeFunil).mockResolvedValue({
      ok: true,
      lead: { id: LEAD, pipeline_id: FUNIL_DESTINO, stage_id: ETAPA_SEGUNDA },
    } as never);
    const req = new NextRequest(`http://localhost/api/v1/leads/${LEAD}/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline_id: FUNIL_DESTINO, stage_id: ETAPA_SEGUNDA }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: LEAD }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(moverNegocioDeFunil).mock.calls[0]?.[3]).toMatchObject({
      pipelineId: FUNIL_DESTINO,
      stageId: ETAPA_SEGUNDA,
    });
    const corpo = (await res.json()) as { data: { lead: { id: string } } };
    expect(corpo.data.lead.id).toBe(LEAD);
  });
});
