/**
 * RASTRO DE EFEITOS DO TURNO — teste de caracterização da ADR-0006 (fatia S0).
 *
 * O turno da IA vai ser fatiado em módulos (ADR-0006), uma PR por fase, só
 * movendo código. Este teste é a régua de "não mudou nada": roda o turno de
 * verdade (`runAgentTurn` → `executarTurnoDoAgente`) com dublês baratos e grava,
 * EM ORDEM, o que ele fez no mundo:
 *
 *   - `db:` escrita no banco (verbo + tabela, todas as de um CTE em ordem textual;
 *     leitura não entra), o `status` gravado em inbox, contato e conversa, e transação;
 *   - `send:` envio pelo canal (tipo e corpo);
 *   - `llm:` chamada de modelo por propósito (`purpose` do seam);
 *   - `tool:` ferramenta que o modelo chamou e o desfecho dela (`ok`/`code`);
 *   - `job:` reagendamento ou enfileiramento visto no SQL;
 *   - `log:` só os avisos e erros (e os `info` de saída do turno).
 *
 * O rastro de cada cenário é comparado com o snapshot versionado. Fatia de
 * MOVIMENTO não atualiza snapshot: se ele mudou, o comportamento mudou. Só uma
 * PR que muda comportamento de propósito regrava (`vitest -u`), e diz por quê.
 *
 * Dublês, sem Postgres: o pool fingido de `turno-le-em-paralelo.test.ts` (só
 * devolve as linhas mínimas para o turno abrir), o seam de modelo
 * (`runModelCall`) roteirizado por cenário, e o canal por `deps.channel`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SeamDeModelo from "@/lib/agent-engine/edge/llm/run-model-call";
import type * as Handoff from "@/lib/agent-engine/agent/human-handoff";
import type * as Roteador from "@/lib/agent-engine/agent/resolve-turn-agent";

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", async (importOriginal) => {
  const real = await importOriginal<typeof SeamDeModelo>();
  return { ...real, runModelCall: vi.fn() };
});
vi.mock("@/lib/agent-engine/agent/human-handoff", async (importOriginal) => {
  const real = await importOriginal<typeof Handoff>();
  return { ...real, isLeadInHandoff: vi.fn(async () => false) };
});
// O roteador só roda quando o cenário não traz `resolvedAgent` (ADR-0006, S4): cada
// chamada entra no rastro, para a contagem de chamadas do roteador ficar fixada.
vi.mock("@/lib/agent-engine/agent/resolve-turn-agent", async (importOriginal) => {
  const real = await importOriginal<typeof Roteador>();
  return { ...real, resolveConversationTurn: vi.fn() };
});

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";
import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { resolveConversationTurn } from "@/lib/agent-engine/agent/resolve-turn-agent";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "55555555-5555-4555-8555-555555555555";

const LINHA_DO_CONTATO = {
  name: "Cliente", display_name: null, email: null, phone_number: "5511999999999", tags: [],
  is_blocked: false, is_personal: false, source: "whatsapp", consent: null, is_anonymized: false,
};

type Rastro = string[];

const CHECKPOINT = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "resumo do turno" });

/** Tabelas cujo `status` gravado no SET entra no rastro (a passagem e o rascunho mudam estado por ele). */
const STATUS_NO_RASTRO = new Set(["agent_inbox_items", "contacts", "conversations"]);

/**
 * Efeitos de um SQL: transação, ou cada escrita (verbo + tabela) na ordem em que
 * aparece no texto, inclusive as de dentro de um CTE. Leitura não devolve nada.
 */
export function efeitosDoSql(sql: string): string[] {
  const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (/^(begin|commit|rollback)\b/.test(s)) return [`db:${s.split(" ")[0]}`];
  // Escrita por função do banco chamada como `select * from fn_x(...)` (ex.: `fn_reply_begin`).
  const fn = s.match(/^select \* from (?:public\.)?(fn_[a-z_]+)\(/);
  if (fn) return [`db:call ${fn[1]}`];
  const efeitos: string[] = [];
  for (const m of s.matchAll(/\b(insert into|update|delete from)\s+([a-z_."]+)/g)) {
    const [, verbo = "", alvo = ""] = m;
    // `for update` (trava de leitura) e `on conflict do update set` não são escrita própria.
    if (verbo === "update" && /\b(for|do) $/.test(s.slice(0, m.index))) continue;
    const tabela = alvo.replace(/"/g, "").replace(/^public\./, "");
    if (tabela === "jobs" || tabela === "job_queue") {
      efeitos.push(`job:${verbo.split(" ")[0]} ${tabela}`);
      continue;
    }
    let efeito = `db:${verbo.split(" ")[0]} ${tabela}`;
    if (verbo === "update" && STATUS_NO_RASTRO.has(tabela)) {
      const set = s.slice(m.index).split(" where ")[0] ?? "";
      const st = set.match(/\bstatus\s*=\s*('[^']*'|\$\d+|[a-z_]+)/);
      if (st) efeito += ` status=${st[1]}`;
    }
    efeitos.push(efeito);
  }
  return efeitos;
}

const FRONTEIRA = {
  organization_id: ORG, contact_id: CONTATO, conversation_id: CONVERSA, service_revision: 1,
  demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null,
};
const RASCUNHO = "77777777-7777-4777-8777-777777777777";
const VERSAO = "88888888-8888-4888-8888-888888888888";
/** Data fixa do claim do job: `new Date()` deixaria o rastro dependente do relógio. */
const CLAIM_EM = "2026-10-06T14:59:00.000Z";

/** O negócio ativo do contato: a nota da F13 (`recalculaScoreDoLead`) só escreve com ele. */
const NEGOCIO = {
  id: "99999999-9999-4999-8999-999999999999", organization_id: ORG, contact_id: CONTATO, pipeline_id: null,
  status: "open", last_activity_at: "2026-10-06T14:00:00.000Z", created_at: "2026-10-01T12:00:00.000Z",
  expected_duration_hours: null, qualification: {}, checkpoint_id: null, commitments: [], objections: [],
  band_anterior: null,
};

function poolQueGrava(rastro: Rastro, c: Cenario = {}) {
  // Lacuna consciente: o pool não devolve linhas de horário de atendimento. Fazer isso
  // exige injetar o relógio em `inbound-turn.ts` (linhas 2819, 2824, 4361 e 5826 em
  // `3ba2fe36d`), que hoje leem `new Date()` direto; sem isso o rastro dependeria da hora.
  const query = async (sql: string | { text: string }, params: unknown[] = []) => {
    const texto = typeof sql === "string" ? sql : sql.text;
    rastro.push(...efeitosDoSql(texto));
    await Promise.resolve();
    // Claim do turno autônomo (`requireCurrentAutonomousTurn`): o job do teste é o dono.
    if (texto.includes("fn_autonomous_turn_revoked")) return { rows: [{ current: true }], rowCount: 1 };
    // Fronteira de atendimento viva (`SERVICE_BOUNDARY_SQL`).
    if (texto.includes("c.service_revision::float8 as service_revision")) return { rows: [FRONTEIRA], rowCount: 1 };
    // O rascunho do assistido começa `generating`, com o token que o chamador mandou.
    if (texto.includes("fn_reply_begin")) {
      return {
        rows: [{
          id: RASCUNHO, status: "generating", revision: "1", generation_token: params[4],
          original_body: null, agent_version_id: VERSAO, service_boundary: FRONTEIRA,
        }],
        rowCount: 1,
      };
    }
    if (texto.includes("insert into lead_notes")) return { rows: [{ id: "nota-1", superseded: "0" }], rowCount: 1 };
    if (texto.includes("select timezone from organizations")) return { rows: [{ timezone: "America/Sao_Paulo" }], rowCount: 1 };
    if (texto.includes("playbook_pointers")) return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }], rowCount: 1 };
    if (/from contacts where organization_id = \$1 and id = \$2/.test(texto)) return { rows: [LINHA_DO_CONTATO], rowCount: 1 };
    if (texto.includes("from conversations") && texto.includes("is_group = false")) return { rows: [{ id: CONVERSA }], rowCount: 1 };
    if (c.comNegocio && texto.includes("from crm_leads l")) return { rows: [NEGOCIO], rowCount: 1 };
    // `applyLeadStateUpdate` lê a linha que gravou (`returning`): sem ela a ferramenta recusa.
    if (c.comNegocio && texto.includes("insert into lead_state ")) {
      return { rows: [{ organization_id: ORG, contact_id: CONTATO, stage: "contacted", qualification: {}, updated_at: CLAIM_EM }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

function canalQueGrava(rastro: Rastro) {
  let n = 0;
  return {
    channel: "fake",
    async send(input: { body?: string; kind?: string }) {
      n += 1;
      rastro.push(`send:${input.kind ?? "text"} ${JSON.stringify(input.body ?? "")}`);
      return { kind: "sent" as const, idempotencyKey: `k${n}`, messageId: `m${n}` };
    },
    async sessionHealth() { return { healthy: true, status: "WORKING", since: null }; },
    async signalTyping() {},
    capabilities: () => ({ freeformAnytime: true, serviceWindowHours: null }),
    costPerMessage: () => ({ perMessageUsdCents: 0, model: "flat" as const }),
  };
}

function logQueGrava(rastro: Rastro) {
  const saida = /^turno |turno do agente concluído|não executado|turno pulado|^aviso de fora do horário/;
  return {
    info: (msg: string) => { if (saida.test(msg)) rastro.push(`log:info ${msg}`); },
    warn: (msg: string) => rastro.push(`log:warn ${msg}`),
    error: (msg: string) => rastro.push(`log:error ${msg}`),
    debug: () => {},
  };
}

type ChamadaDeFerramenta = { nome: string; args: Record<string, unknown> };
type Cenario = {
  ferramentas?: ChamadaDeFerramenta[];
  agente?: Record<string, unknown>;
  modeloFalha?: Error;
  emHandoff?: boolean;
  /** Sem `resolvedAgent`: o turno chama o roteador (dublê) e recebe esta decisão. */
  roteador?: Record<string, unknown>;
  conducao?: Record<string, unknown>;
  /** Texto do checkpoint do fechamento; ausente = `CHECKPOINT` (sem mudança, sem emissão). */
  checkpoint?: string;
  /** O pool devolve um negócio ativo do contato (a nota da F13 escreve). */
  comNegocio?: boolean;
  knobs?: Record<string, unknown>;
};

const AGENTE = {
  agentId: "agente-1", versionId: "v1", operationMode: "automatic", pausedAt: null,
  systemPrompt: "persona", toolIds: [], casesEnabled: false, handoffToolEnabled: true,
  historyMessageWindow: 20, historyTokenWindow: 1000,
};

/** O seam de modelo roteirizado: classificadores degradam, o turno chama as ferramentas do cenário. */
function roteirizarModelo(rastro: Rastro, c: Cenario) {
  vi.mocked(runModelCall).mockImplementation((async (_db: unknown, _cfg: unknown, input: SeamDeModelo.RunModelCallInput) => {
    const proposito = input.purpose ?? "sem_proposito";
    rastro.push(`llm:${proposito}`);
    // O rascunho do assistido roda o mesmo turno em modo preview (`agent_preview`).
    if (proposito === "agent_turn" || proposito === "agent_preview") {
      if (c.modeloFalha) throw c.modeloFalha;
      let i = 0;
      for (const f of c.ferramentas ?? []) {
        const t = (input.tools ?? {})[f.nome] as { execute?: (a: unknown, o: unknown) => Promise<unknown> } | undefined;
        if (!t?.execute) { rastro.push(`tool:${f.nome} ausente`); continue; }
        const r = (await t.execute(f.args, { toolCallId: `tc${++i}`, messages: [] })) as
          | { ok?: boolean; code?: string; reason?: string; error?: string | { code?: string } }
          | undefined;
        const motivo = r?.code ?? r?.reason ?? (typeof r?.error === "string" ? r.error : r?.error?.code) ?? "?";
        rastro.push(`tool:${f.nome} ${r?.ok === false ? `recusou ${motivo}` : "ok"}`);
      }
      return { result: { finishReason: "stop", responseMessages: [], text: "", steps: [] }, model: "fake-model", callId: "call-turno" };
    }
    if (proposito === "checkpoint") return { result: { text: c.checkpoint ?? CHECKPOINT }, model: "fake-model", callId: "call-ck" };
    // Só roda com `knobs.stageClassifier`: sugere um estágio diferente do que o modelo confirma.
    if (proposito === "stage_classifier") return { result: { text: "qualifying" }, model: "fake-model", callId: "call-stage" };
    throw new Error(`dublê: sem roteiro para ${proposito}`);
  }) as never);
}

export async function rodarCenario(c: Cenario): Promise<Rastro> {
  const rastro: Rastro = [];
  vi.mocked(isLeadInHandoff).mockResolvedValue(c.emHandoff ?? false);
  roteirizarModelo(rastro, c);
  vi.mocked(resolveConversationTurn).mockImplementation((async () => {
    rastro.push("roteador:resolveConversationTurn");
    return { config: { ...AGENTE, ...c.agente }, ...c.roteador };
  }) as never);
  const pool = poolQueGrava(rastro, c);
  const deps = {
    log: logQueGrava(rastro),
    llmCfg: {},
    crmCfg: {},
    knobs: {
      maxSteps: 4,
      breaker: {
        exactFailureWarn: 2, exactFailureBlock: 3, sameToolFailureWarn: 3,
        sameToolFailureHalt: 5, noProgressWarn: 4, noProgressBlock: 6,
      },
      ...c.knobs,
    },
    clock: () => new Date("2026-10-06T15:00:00Z"),
    sleep: async () => {},
    channel: () => canalQueGrava(rastro),
  };
  const job = {
    id: "11111111-1111-4111-8111-111111111111", organization_id: ORG, contact_id: CONTATO,
    kind: "inbound_turn", payload: {}, attempts: 1, claimed_by: "w", claimed_at: new Date(CLAIM_EM),
    locked_by: "w", claim_acquired_at: CLAIM_EM,
  };
  try {
    await runAgentTurn(deps as never, job as never, pool as never, { workerId: "w" }, {
      ...(c.roteador ? {} : {
        resolvedAgent: {
          config: { ...AGENTE, ...c.agente },
          routerId: null, intentName: null, confidence: null, outcome: "fallback",
        },
      }),
      ...(c.conducao ? { conducao: c.conducao } : {}),
      channelSessionId: "44444444-4444-4444-8444-444444444444",
      conversationId: CONVERSA,
      inboundMessageId: "66666666-6666-4666-8666-666666666666",
      buildOpening: () => "",
    } as never);
    rastro.push("fim:ok");
  } catch (err) {
    rastro.push(`fim:lançou ${(err as Error).message.slice(0, 80)}`);
  }
  return rastro;
}

const CENARIOS: Record<string, Cenario> = {
  "portão: lead em handoff humano": { emHandoff: true },
  "portão: agente pausado": { agente: { pausedAt: "2026-10-01T00:00:00Z" } },
  // Desvio real do assistido (`inbound-turn.ts:2172-2216`): sem `agent_turn`, o
  // turno vira rascunho (`fn_reply_begin`, preview, `update ai_reply_drafts`).
  "assistido: vira rascunho, nada sai": {
    agente: { operationMode: "assisted", versionId: VERSAO },
    ferramentas: [{ nome: "send_message", args: { body: "Rascunho: posso te ajudar com o orçamento?" } }],
  },
  "responde: uma mensagem": {
    ferramentas: [{ nome: "send_message", args: { body: "Oi! Posso te ajudar com o orçamento." } }],
  },
  "responde: duas mensagens diferentes": {
    ferramentas: [
      { nome: "send_message", args: { body: "Oi! Tudo bem?" } },
      { nome: "send_message", args: { body: "O horário de amanhã às 10h está livre." } },
    ],
  },
  "responde: mesmo corpo duas vezes (trava de duplicata)": {
    ferramentas: [
      { nome: "send_message", args: { body: "Oi! Posso te ajudar com o orçamento." } },
      { nome: "send_message", args: { body: "Oi! Posso te ajudar com o orçamento." } },
    ],
  },
  "responde: corpo vazio": { ferramentas: [{ nome: "send_message", args: { body: "   " } }] },
  "responde: acima do teto de envios": {
    ferramentas: [1, 2, 3, 4].map((n) => ({ nome: "send_message", args: { body: `Mensagem número ${n} com conteúdo distinto ${"x".repeat(n * 7)}` } })),
  },
  "turno mudo: modelo não chama ferramenta": { ferramentas: [] },
  "passa para humano: ferramenta de handoff": {
    ferramentas: [{
      nome: "request_human_handoff",
      args: { por_que: "cliente pediu atendente", o_que_tentei: [{ o_que: "expliquei o orçamento", desfecho: "não bastou" }], cliente_quer: "falar com alguém" },
    }],
  },
  // Caracteriza o que existe hoje: o aviso ao lead sai ANTES de o payload ser recusado.
  "passa para humano: payload inválido": {
    ferramentas: [{ nome: "request_human_handoff", args: { reason: "cliente pediu atendente", summary: "quer falar com alguém" } }],
  },
  "ferramenta: nota do lead e resposta": {
    ferramentas: [
      { nome: "save_lead_note", args: { headline: "Prefere manhã", body: "Disse que só pode de manhã." } },
      { nome: "send_message", args: { body: "Anotado, vou te oferecer horários de manhã." } },
    ],
  },
  "ferramenta: lê o contexto do lead e responde": {
    ferramentas: [
      { nome: "get_lead_context", args: {} },
      { nome: "send_message", args: { body: "Vi aqui seu histórico, já te respondo." } },
    ],
  },
  "erro do modelo: provedor fora": { modeloFalha: new Error("upstream 503") },
  // F3 (ADR-0006, S4), gravados contra o código de antes da extração.
  "roteamento: fora do horário avisa e adia": {
    agente: { janelaDeAtendimento: { timezone: "America/Sao_Paulo", start: "20:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } },
  },
  "roteamento: condução encerrada no meio-tempo": {
    conducao: { id: "77777777-7777-4777-8777-777777777777" },
  },
  "roteamento: roteador decide e grava a decisão (destino do card cai no catch)": {
    roteador: {
      routerId: "88888888-8888-4888-8888-888888888888", intentName: "orcamento", confidence: 0.9,
      outcome: "matched", destinationPipelineId: "99999999-9999-4999-8999-999999999999", destinationStageId: null,
    },
    ferramentas: [{ nome: "send_message", args: { body: "Oi! Posso te ajudar com o orçamento." } }],
  },
  // F13 com os ramos ligados (ADR-0006, S3): Operador enfileirado, checkpoint que muda
  // (emissão), negócio ativo (nota), divergência classificador×modelo (golden).
  "pós-turno: tentativa do Operador, emissão e golden (nota fora do rastro)": {
    agente: { operatorEnabled: true },
    knobs: { goldenCandidates: true, stageClassifier: {} },
    comNegocio: true,
    checkpoint: JSON.stringify({
      commitments: ["enviar o orçamento amanhã"], objections: [], next_action: "enviar orçamento", rolling_summary: "pediu orçamento",
    }),
    ferramentas: [
      { nome: "update_lead_state", args: { stage: "contacted", reason: "respondeu" } },
      { nome: "send_message", args: { body: "Amanhã te mando o orçamento." } },
    ],
  },
};

beforeEach(() => {
  vi.mocked(runModelCall).mockReset();
});

describe("rastro de efeitos do turno (ADR-0006, S0)", () => {
  for (const [nome, cenario] of Object.entries(CENARIOS)) {
    it(nome, async () => {
      const rastro = await rodarCenario(cenario);
      // Rastro vazio passaria em qualquer refatoração que matasse o turno cedo.
      expect(rastro.length).toBeGreaterThan(0);
      expect(rastro).toMatchSnapshot();
    });
  }

  it("é determinístico: o mesmo cenário duas vezes dá o mesmo rastro", async () => {
    const c = CENARIOS["ferramenta: nota do lead e resposta"]!;
    expect(await rodarCenario(c)).toEqual(await rodarCenario(c));
  });

  // #470: payload recusado não pode virar "já estou chamando a equipe" sem passagem.
  // Asserção explícita para um snapshot regravado em massa não engolir a regressão.
  it("handoff com payload inválido não avisa o lead", async () => {
    const rastro = await rodarCenario(CENARIOS["passa para humano: payload inválido"]!);
    expect(rastro).toContain("tool:request_human_handoff recusou invalid_payload");
    expect(rastro.filter((e) => e.startsWith("send:"))).toEqual([]);
  });
});

describe("controle negativo: o snapshot versionado reprova ordem trocada", () => {
  const CENARIO = "ferramenta: nota do lead e resposta";
  /** O bloco do cenário, lido do `.snap` em disco (o que o CI compara), não da memória. */
  const blocoNoDisco = (): string => {
    const snap = readFileSync(join(__dirname, "__snapshots__", "turno-rastro-de-efeitos.test.ts.snap"), "utf8");
    const i = snap.indexOf(`> ${CENARIO} 1\``);
    expect(i).toBeGreaterThan(-1);
    return snap.slice(i, snap.indexOf("`;", i));
  };
  const linhas = (a: string, b: string): string => `"${a}",\n  "${b}",`;

  it("o .snap tem a ordem original e NÃO a trocada de dois efeitos vizinhos", async () => {
    const rastro = await rodarCenario(CENARIOS[CENARIO]!);
    const i = rastro.findIndex((e, k) => k + 1 < rastro.length && e !== rastro[k + 1]);
    expect(i).toBeGreaterThanOrEqual(0);
    const [a, b] = [rastro[i]!, rastro[i + 1]!];
    const bloco = blocoNoDisco();
    expect(bloco).toContain(linhas(a, b));
    expect(bloco).not.toContain(linhas(b, a));
    // E o comparador do snapshot reprova o rastro trocado (mesmo conjunto, outra ordem).
    const trocado = [...rastro];
    [trocado[i], trocado[i + 1]] = [b, a];
    expect([...trocado].sort()).toEqual([...rastro].sort());
    expect(() => expect(trocado).toEqual(rastro)).toThrow();
  });
});
