import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";

/**
 * O AVISO QUE CHEGA NUMA CONEXÃO DA PRÓPRIA ORGANIZAÇÃO NÃO VIRA ATENDIMENTO (9231).
 *
 * Com `organizations.aviso_para_conexao_propria` ligada, o aviso de caso sai pela
 * conexão A e cai na conexão B, que tem roteador e agente. Se a mensagem
 * entrasse, B criaria contato/conversa com o número de A, o roteador e o agente
 * responderiam, e A receberia de volta: o laço robô↔robô. O corte é o mesmo do
 * número interno de avisos, ANTES do `upsertContact`: sem contato e sem conversa
 * não há rodízio, boas-vindas, follow-up, automação, lead nem despacho da IA.
 *
 * Entra pelo caminho de produção (`dispatchWahaEvent`) e mede a LIGAÇÃO: quem
 * decide é a flag lida do banco. CONTROLE: sem a flag, a MESMA mensagem vira
 * contato e conversa, como hoje em toda organização.
 */

const ORG = "org-1";
const SESSAO_DESTINO = "sessao-comercial";
/** Número da conexão REMETENTE do aviso, que também é conexão desta org. */
const NUMERO_DA_CONEXAO_REMETENTE = "+5522981356551";

function bancoDeMentira(flag: boolean) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Array<{ tabela: string; linha: Record<string, unknown> }> = [];

  const consulta = (lista: unknown[]) => {
    const q: Record<string, unknown> = {
      eq: () => q,
      in: () => q,
      is: () => q,
      not: () => q,
      neq: () => q,
      gte: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: lista, error: null })),
    };
    return q;
  };

  const admin = {
    from(tabela: string) {
      if (tabela === "config_aviso_de_caso" || tabela === "config_aviso_de_agendamento") {
        // O destino configurado é OUTRO número: o corte antigo não se aplica aqui.
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { aviso_para_conexao_propria: flag }, error: null }) }),
          }),
        };
      }
      return {
        select: () =>
          consulta(tabela === "channel_sessions" ? [{ phone_number: NUMERO_DA_CONEXAO_REMETENTE }] : []),
        insert: (linha: Record<string, unknown>) => {
          inserts.push({ tabela, linha });
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) };
        },
        update: () => {
          const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
            error: null,
            eq: () => encadeavel,
            in: () => encadeavel,
          };
          return encadeavel;
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, rpcs, inserts };
}

const AVISO_RECEBIDO: WahaPayload = {
  id: "false_5522981356551@c.us_3EB0AVISO01",
  from: "5522981356551@c.us",
  fromMe: false,
  body: "Caso #123 aberto. Acompanhe pelo painel: https://app.exemplo.com/app/ai/cases/123",
  timestamp: 1_760_000_000,
};

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message", session: "default", payload };
}

const sessao = { id: SESSAO_DESTINO, organization_id: ORG };

async function recebe(flag: boolean, payload: WahaPayload = AVISO_RECEBIDO) {
  limparCacheDoNumeroInterno();
  const duplo = bancoDeMentira(flag);
  await dispatchWahaEvent(duplo.admin as never, sessao as never, envelope(payload), "req-1");
  return {
    contatos: duplo.rpcs.filter((c) => c.fn === "fn_upsert_wa_contact"),
    conversas: duplo.rpcs.filter((c) => c.fn === "fn_upsert_wa_conversation"),
    mensagens: duplo.inserts.filter((i) => i.tabela === "messages"),
    jobs: duplo.inserts.filter((i) => i.tabela === "job_queue"),
    ignorada: duplo.rpcs.some((c) => c.fn === "fn_contar_mensagem_ignorada"),
  };
}

describe("aviso recebido de uma conexão da própria organização (9231)", () => {
  it("com a exceção ligada: não cria contato, conversa, mensagem nem job do agente", async () => {
    const r = await recebe(true);
    expect(r.contatos, "virou CONTATO: o roteador e o agente da conexão de destino atenderiam").toHaveLength(0);
    expect(r.conversas, "virou CONVERSA: rodízio, boas-vindas e IA disparam a partir dela").toHaveLength(0);
    expect(r.mensagens).toHaveLength(0);
    expect(r.jobs, "o despacho do agente entrou na fila").toHaveLength(0);
    expect(r.ignorada, "o descarte precisa deixar rastro no contador").toBe(true);
  });

  it("CONTROLE: sem a flag, a MESMA mensagem vira contato e conversa (nada muda nas outras orgs)", async () => {
    const r = await recebe(false);
    expect(r.contatos).toHaveLength(1);
    expect(r.conversas).toHaveLength(1);
  });

  it("CONTROLE: com a flag, mensagem de um número de FORA segue o caminho normal", async () => {
    const r = await recebe(true, {
      ...AVISO_RECEBIDO,
      id: "false_5521988887777@c.us_3EB0CLIENTE",
      from: "5521988887777@c.us",
      body: "Oi, quero um orçamento",
    });
    expect(r.contatos).toHaveLength(1);
    expect(r.conversas).toHaveLength(1);
  });
});
