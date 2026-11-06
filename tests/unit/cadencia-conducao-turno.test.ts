/**
 * O TURNO SOB CONDUÇÃO DA CADÊNCIA — agente fixado, rascunho no assistido,
 * teto de turnos e agente indisponível viram passagem para uma pessoa.
 *
 * Mesmo harness de `assistido-respeita-o-gate.test.ts`; o módulo da condução
 * (`lib/cadencia/conducao/turno`) é mockado só nas funções que falam com o banco.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(), handoff: vi.fn(), elegibilidade: vi.fn(),
  conducao: vi.fn(), contar: vi.fn(), encerrar: vi.fn(), avisarEquipe: vi.fn(), resolve: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/resolve-turn-agent', () => ({ resolveConversationTurn: mocks.resolve }));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation,
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  lerCamadasDaOrg: vi.fn(async () => ({})), camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegibilidade }));
vi.mock('@/lib/agent-engine/pacing/store', () => ({ loadChannelKnobs: vi.fn(async () => ({ knobs: {} })) }));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({ janelaDeEnvioAberta: () => true, proximaAberturaDaJanela: vi.fn() }));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0), avisarJanelaFechada: vi.fn(),
}));
vi.mock('@/lib/cadencia/conducao/turno', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  conducaoVivaDaConversa: mocks.conducao,
  contarTurno: mocks.contar,
  encerrarConducaoEPassarParaHumano: mocks.encerrar,
  avisarEquipeDoRascunho: mocks.avisarEquipe,
  nomeDaEtapa: vi.fn(async () => 'Qualificado'),
}));

// v1.90: o teto da condução é contado em `entrada-do-agente`, DEPOIS do contexto; o contexto (playbook
// por ponteiro) não é o assunto deste arquivo, então entra como dublê mínimo.
vi.mock('@/lib/agent-engine/agent/turno/contexto', () => ({
  carregarContextoDoTurno: vi.fn(async () => ({
    maxSteps: 1, argsAux: {}, turnContextKnobs: {}, skills: [], currentInboundText: 'oi',
    currentInboundSender: null, previous: [], leadState: null, system: '', openingContext: {},
  })),
}));

vi.mock('@/lib/agent-engine/agent/turno/desvios-deterministicos', () => ({
  tratarDesviosDeterministicos: vi.fn(async () => ({
    seguir: true,
    valor: { channel: null, liveChannel: null, optedOutThisTurn: false, lgpd: null, avisoDaEscalacao: null,
      mensagemDoJob: null, inboundsPendentes: [], passarComercialParaEquipe: false },
  })),
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import type { ConducaoViva } from '@/lib/cadencia/conducao/turno';

const ids = {
  org: '11000000-0000-4000-8000-000000000001', contact: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003', channel: '11000000-0000-4000-8000-000000000004',
  job: '11000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '11000000-0000-4000-8000-000000000006', crm_event_id: '11000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;

function agente(over: Partial<PublishedAgentConfig> = {}): PublishedAgentConfig {
  return {
    agentId: 'agente-da-cadencia', versionId: 'v-1', operationRevision: '1', operationMode: 'automatic', pausedAt: null,
    toolIds: ['crm_move_lead_stage', 'crm_list_leads', 'crm_get_lead'], pipelineIds: ['pipe-cad', 'pipe-outro'],
    ...over,
  } as PublishedAgentConfig;
}

function conducao(over: Partial<ConducaoViva> = {}): ConducaoViva {
  return {
    id: 'cond-1', organization_id: ids.org, conversation_id: ids.conversation, contact_id: ids.contact,
    lead_id: 'lead-1', pointer_id: 'ptr-1', agent_id: 'agente-da-cadencia', pipeline_id: 'pipe-cad',
    modo: 'assistido', preset: 'qualificar', etapa_alvo_id: 'etapa-1', instrucao: null, turnos: 0,
    aberta_em: new Date('2026-09-28T10:00:00Z'), expira_em: new Date('2026-10-12T10:00:00Z'),
    ...over,
  };
}

const pool = () => ({ query: vi.fn(async () => ({ rows: [] })) });
const rodar = (p = pool()) => createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'w' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
  mocks.contar.mockResolvedValue(1);
  mocks.draft.mockResolvedValue({ status: 'pending' });
  mocks.byId.mockResolvedValue(agente());
});

describe('condução ASSISTIDA', () => {
  it('rascunho 1x com a condução e o agente restrito, turno contado, equipe avisada, sem roteador', async () => {
    mocks.conducao.mockResolvedValue(conducao());
    await rodar();
    expect(mocks.resolve, 'a condução fixa o agente: o roteador nem é consultado').not.toHaveBeenCalled();
    expect(mocks.router).not.toHaveBeenCalled();
    expect(mocks.byId).toHaveBeenCalledWith(expect.anything(), ids.org, 'agente-da-cadencia');
    expect(mocks.contar).toHaveBeenCalledOnce();
    expect(mocks.draft).toHaveBeenCalledOnce();
    const input = mocks.draft.mock.calls[0]![2];
    expect(input.conducao.id).toBe('cond-1');
    expect([...input.agent.toolIds].sort()).toEqual(['crm_get_lead', 'crm_move_lead_stage']);
    expect(input.agent.pipelineIds).toEqual(['pipe-cad']);
    expect(mocks.avisarEquipe).toHaveBeenCalledOnce();
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it('rascunho que não saiu pending não avisa a equipe', async () => {
    mocks.conducao.mockResolvedValue(conducao());
    mocks.draft.mockResolvedValue({ status: 'failed' });
    await rodar();
    expect(mocks.avisarEquipe).not.toHaveBeenCalled();
  });

  it('passou do teto → encerra (teto_de_turnos) e passa para humano, sem rascunho', async () => {
    mocks.conducao.mockResolvedValue(conducao());
    mocks.contar.mockResolvedValue(31);
    await rodar();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.encerrar).toHaveBeenCalledOnce();
    expect(mocks.encerrar.mock.calls[0]![2]).toBe('teto_de_turnos');
  });

  it('lead em handoff → sem rascunho e sem gastar turno', async () => {
    mocks.conducao.mockResolvedValue(conducao());
    mocks.handoff.mockResolvedValue(true);
    await rodar();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.contar).not.toHaveBeenCalled();
    expect(mocks.encerrar).not.toHaveBeenCalled();
  });

  it('gate de elegibilidade fechado → sem rascunho', async () => {
    mocks.conducao.mockResolvedValue(conducao());
    mocks.elegibilidade.mockResolvedValue({ permite: false, motivo: 'dono_humano' });
    await rodar();
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});

describe('agente indisponível → nunca o genérico', () => {
  it.each([
    ['despublicado', null],
    ['pausado', agente({ pausedAt: '2026-09-27T00:00:00Z' } as never)],
  ])('%s → encerra (agente_indisponivel) e passa para humano', async (_n, cfg) => {
    mocks.conducao.mockResolvedValue(conducao({ modo: 'automatico' }));
    mocks.byId.mockResolvedValue(cfg);
    await rodar();
    expect(mocks.encerrar.mock.calls[0]![2]).toBe('agente_indisponivel');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('automático com agente que virou assistido → agente_indisponivel', async () => {
    mocks.conducao.mockResolvedValue(conducao({ modo: 'automatico' }));
    mocks.byId.mockResolvedValue(agente({ operationMode: 'assisted' }));
    await rodar();
    expect(mocks.encerrar.mock.calls[0]![2]).toBe('agente_indisponivel');
  });

  it('assistido aceita agente assistido (controle)', async () => {
    mocks.conducao.mockResolvedValue(conducao({ modo: 'assistido' }));
    mocks.byId.mockResolvedValue(agente({ operationMode: 'assisted' }));
    await rodar();
    expect(mocks.encerrar).not.toHaveBeenCalled();
    expect(mocks.draft).toHaveBeenCalledOnce();
  });
});

describe('condução AUTOMÁTICA', () => {
  it('passou do teto de 30 → encerra (teto_de_turnos), sem roteador e sem sticky', async () => {
    mocks.conducao.mockResolvedValue(conducao({ modo: 'automatico' }));
    mocks.contar.mockResolvedValue(31);
    const p = pool();
    await rodar(p);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.encerrar).toHaveBeenCalledOnce();
    expect(mocks.encerrar.mock.calls[0]![2]).toBe('teto_de_turnos');
    const sqls = (p.query.mock.calls as unknown as Array<[string]>).map(([sql]) => sql);
    expect(sqls.some((s) => s.includes('set active_ai_agent_id'))).toBe(false);
    expect(sqls.some((s) => s.includes('ai_router_decisions'))).toBe(false);
  });

  it('sem condução: o caminho de sempre (resolveConversationTurn) — controle', async () => {
    mocks.conducao.mockResolvedValue(null);
    mocks.resolve.mockResolvedValue({
      config: agente({ operationMode: 'assisted' }), routerId: null, intentName: null, confidence: null, outcome: 'no_router',
    });
    await rodar();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.contar).not.toHaveBeenCalled();
    expect(mocks.draft.mock.calls[0]![2].conducao).toBeUndefined();
  });
});
