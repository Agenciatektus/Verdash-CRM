/**
 * GATILHO POR FRASE (migration 9092).
 *
 * Os modos de falha vigiados: o cliente escrever a frase e o card andar; o card
 * recuar porque a loja repetiu uma frase de etapa antiga; frase de um funil mover
 * card de outro; e a recusa do funil (campo obrigatório, motivo de ganho) virar
 * retry infinito em vez de `skipped`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { dividirFrases, etapaQueCasa, normaliza, type EtapaComFrases } from "@/lib/leads/gatilho-por-frase";
import { gatilhoPorFraseHandler } from "@/lib/leads/gatilho-por-frase.handler";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler: vi.fn(async () => ({})) }));

const E = (n: number, frases: string[], extra: Partial<EtapaComFrases> = {}): EtapaComFrases => ({
  id: `e${n}`,
  position: n * 1000,
  is_lost: false,
  is_archived: false,
  gatilho_frases: frases,
  ...extra,
});

describe("gatilho por frase: casamento", () => {
  it("ignora acento, caixa e espaço repetido", () => {
    expect(normaliza("  PEDIDO   Confirmado ÃÉ ")).toBe("pedido confirmado ae");
    const r = etapaQueCasa("Oi! Seu PEDIDO  confirmádo, tá?", [E(3, ["pedido confirmado"])]);
    expect(r?.etapa.id).toBe("e3");
  });
  it("mais de uma etapa casando: a de maior posição vence", () => {
    const r = etapaQueCasa("pago e separado", [E(2, ["pago"]), E(5, ["separado"]), E(3, ["pago"])]);
    expect(r?.etapa.id).toBe("e5");
  });
  it("perda, arquivada, frase curta demais e texto sem a frase não casam", () => {
    expect(etapaQueCasa("pedido confirmado", [E(3, ["pedido confirmado"], { is_lost: true })])).toBeNull();
    expect(etapaQueCasa("pedido confirmado", [E(3, ["pedido confirmado"], { is_archived: true })])).toBeNull();
    expect(etapaQueCasa("ok pedido", [E(3, ["ok"])])).toBeNull();
    expect(etapaQueCasa("bom dia", [E(3, ["pedido confirmado"])])).toBeNull();
    expect(etapaQueCasa("pedido confirmado", [E(3, ["pedido confirmado"])])).not.toBeNull();
  });
  it("casa por PALAVRA inteira: 'sim' não casa em 'assim', mas casa em 'sim, pode' e em 'Sim!'", () => {
    const sim = [E(3, ["sim"])];
    expect(etapaQueCasa("assim fica bom", sim)).toBeNull();
    expect(etapaQueCasa("Sim!", sim)).not.toBeNull();
    expect(etapaQueCasa("claro, sim, pode ser", sim)).not.toBeNull();
    expect(etapaQueCasa("Pago ✅ obrigado", [E(4, ["Pago ✅"])])).not.toBeNull();
  });
  it("dividirFrases tira vazias e repetidas (sem acento nem caixa) e guarda a grafia original", () => {
    expect(dividirFrases("Pedido confirmado\n\n  pedido CONFIRMADO \nPago ✅")).toEqual(["Pedido confirmado", "Pago ✅"]);
  });
});

// ── o handler, com o banco de mentira ────────────────────────────────────────
const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "c1";
const MENSAGEM = "m1";

function fakeAdmin(t: {
  etapas: Array<EtapaComFrases & { pipeline_id: string }>;
  atuais?: Array<{ id: string; position: number }>;
  mensagem?: { direction: string; body: string | null; contact_id?: string | null; sent_via?: string; type?: string; metadata?: Record<string, unknown> } | null;
  negocios?: Array<{ id: string; stage_id: string; pipeline_id: string }>;
}) {
  return {
    from(tabela: string) {
      let comNeq = false;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: () => q,
        neq: () => {
          comNeq = true;
          return q;
        },
        maybeSingle: async () => ({
          data: tabela === "messages" && t.mensagem ? { contact_id: CONTATO, sent_via: "external_device", type: "text", metadata: {}, ...t.mensagem } : null,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) =>
          ok({
            data:
              tabela === "crm_stages" ? (comNeq ? t.etapas : (t.atuais ?? [])) : tabela === "crm_leads" ? (t.negocios ?? []) : [],
            error: null,
          }),
      };
      return q;
    },
  };
}

/** Forma do trigger `fn_emit_message_event` (eco do celular): traz message_id e contact_id no payload. */
const evento = (extra: Partial<EventRow["payload"]> = {}): EventRow => ({
  id: "ev1",
  organization_id: ORG,
  event_type: "message.sent",
  entity_kind: "message",
  entity_id: MENSAGEM,
  payload: { message_id: MENSAGEM, contact_id: CONTATO, ...extra },
  metadata: {},
  consumed_by: [],
  attempts: 0,
});

const ETAPAS = [{ ...E(3, ["pedido confirmado"]), pipeline_id: "p1" }];
const NEGOCIO = { id: "l1", stage_id: "e1", pipeline_id: "p1" };

function monta(t: Parameters<typeof fakeAdmin>[0]) {
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(t) as never);
}

describe("gatilho por frase: handler", () => {
  beforeEach(() => {
    vi.mocked(moveLeadHandler).mockReset();
    vi.mocked(moveLeadHandler).mockResolvedValue({});
  });

  it("mensagem da loja com a frase move o card para a etapa", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "Seu Pedido Confirmado!" }, negocios: [NEGOCIO] });
    const r = await gatilhoPorFraseHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moveLeadHandler).mock.calls[0]?.[3]).toMatchObject({ to_stage_id: "e3" });
  });

  it("CONTROLE NEGATIVO: a mesma frase vinda do CLIENTE não move (direction inbound)", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "inbound", body: "pedido confirmado" }, negocios: [NEGOCIO] });
    const r = await gatilhoPorFraseHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "nao_e_mensagem_da_loja" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("só avança: card já na etapa, ou além dela, não anda", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 5000 }], mensagem: { direction: "outbound", body: "pedido confirmado" }, negocios: [NEGOCIO] });
    const r = await gatilhoPorFraseHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "nenhuma_frase_casou" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("frase de um funil não move o card de outro funil", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado" }, negocios: [{ ...NEGOCIO, pipeline_id: "p2" }] });
    const r = await gatilhoPorFraseHandler.handle(evento());
    expect(r.status).toBe("skipped");
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("org sem frase cadastrada, sem negócio aberto e mensagem sem texto: skipped, sem tocar no card", async () => {
    monta({ etapas: [], mensagem: { direction: "outbound", body: "oi" } });
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ status: "skipped", detail: "org_sem_gatilho" });
    monta({ etapas: ETAPAS, mensagem: { direction: "outbound", body: "pedido confirmado" }, negocios: [] });
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ status: "skipped", detail: "sem_negocio_aberto" });
    monta({ etapas: ETAPAS, mensagem: { direction: "outbound", body: "  " }, negocios: [NEGOCIO] });
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ status: "skipped", detail: "mensagem_sem_texto" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("recusa de regra do funil (422) vira skipped; falha de servidor vira error", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado" }, negocios: [NEGOCIO] });
    vi.mocked(moveLeadHandler).mockRejectedValueOnce(new ApiError(422, "required_fields_missing", undefined, "r"));
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ status: "skipped" });
    vi.mocked(moveLeadHandler).mockRejectedValueOnce(new ApiError(500, "internal_error", undefined, "r"));
    expect((await gatilhoPorFraseHandler.handle(evento())).status).toBe("error");
  });

  it("TESTE DA LIGAÇÃO: o evento do Inbox (emit_event de messages/_handler: só status e conversation_id, mensagem em entity_id) move o card", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado", sent_via: "crm" }, negocios: [NEGOCIO] });
    const doInbox = { ...evento(), payload: { status: "queued", conversation_id: "cv1" } };
    expect((await gatilhoPorFraseHandler.handle(doInbox)).status).toBe("ok");
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
  });

  it("só a equipe aciona: IA, automação, campanha e sistema não movem (controle: user/crm/external_device movem)", async () => {
    for (const via of ["ai", "automation", "system"]) {
      monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado", sent_via: via }, negocios: [NEGOCIO] });
      expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ status: "skipped", detail: "nao_e_da_equipe" });
    }
    expect(moveLeadHandler).not.toHaveBeenCalled();
    for (const via of ["user", "crm", "external_device"]) {
      monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado", sent_via: via }, negocios: [NEGOCIO] });
      expect((await gatilhoPorFraseHandler.handle(evento())).status).toBe("ok");
    }
  });

  it("o contato vem da LINHA da mensagem: contact_id forjado no payload é ignorado", async () => {
    const lidos: string[] = [];
    const admin = fakeAdmin({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado", contact_id: "contato-real" }, negocios: [NEGOCIO] });
    const from = admin.from.bind(admin);
    vi.mocked(createAdminClient).mockReturnValue({
      from(tabela: string) {
        const q = from(tabela) as Record<string, unknown>;
        const eq = q.eq as (c: string, v: unknown) => unknown;
        q.eq = (c: string, v: unknown): unknown => {
          if (tabela === "crm_leads" && c === "contact_id") lidos.push(String(v));
          return eq(c, v);
        };
        return q;
      },
    } as never);
    await gatilhoPorFraseHandler.handle(evento({ contact_id: "contato-da-vitima" }));
    expect(lidos).toEqual(["contato-real"]);
  });

  it("histórico importado e mensagem sem contato não movem", async () => {
    monta({ etapas: ETAPAS, atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado", metadata: { historico_importado: "true" } }, negocios: [NEGOCIO] });
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ detail: "historico_importado" });
    monta({ etapas: ETAPAS, mensagem: { direction: "outbound", body: "pedido confirmado", contact_id: null }, negocios: [NEGOCIO] });
    expect(await gatilhoPorFraseHandler.handle(evento())).toMatchObject({ detail: "mensagem_sem_contato" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("elemento que não é texto na coluna não derruba o handler", async () => {
    monta({ etapas: [{ ...E(3, []), pipeline_id: "p1", gatilho_frases: [null, "pedido confirmado"] as unknown as string[] }], atuais: [{ id: "e1", position: 1000 }], mensagem: { direction: "outbound", body: "pedido confirmado" }, negocios: [NEGOCIO] });
    expect((await gatilhoPorFraseHandler.handle(evento())).status).toBe("ok");
  });

  it("escuta só message.sent e pula org parada", () => {
    expect(gatilhoPorFraseHandler.events).toEqual(["message.sent"]);
    expect(gatilhoPorFraseHandler.naOrgParada).toBe("pula");
  });
});
