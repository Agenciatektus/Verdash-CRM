/**
 * O DRENO DO AGENTE E A CADÊNCIA — adia, contorna o portão de capacidade, e
 * nunca deixa o lead no silêncio depois do teto.
 *
 * Pool fake roteado por trecho de SQL: cada consulta do `processEvent` responde
 * o mínimo para chegar até a decisão sob teste.
 */
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ passar: vi.fn(), elegib: vi.fn() }));
vi.mock('@/lib/cadencia/conducao/turno', () => ({ passarConversaDaCadenciaParaHumano: mocks.passar }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegib }));

import { drainTick, TETO_TRANSICAO_DA_CADENCIA_MS } from '@/lib/agent-engine/edge/crm/drain';

const ORG = '11000000-0000-4000-8000-000000000001';
const CONTATO = '11000000-0000-4000-8000-000000000002';
const CONVERSA = '11000000-0000-4000-8000-000000000003';
const CANAL = '11000000-0000-4000-8000-000000000004';
const MSG = '11000000-0000-4000-8000-000000000006';
const EVENTO = '11000000-0000-4000-8000-000000000007';

interface Cenario {
  conducaoId?: string | null;
  reguas?: string[];
  idadeMs?: number;
  temAgenteNaSessao?: boolean;
  respostaDaFn?: Record<string, unknown>;
}

function montar(c: Cenario) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes('returning e.id, e.organization_id')) {
      return {
        rows: [
          {
            id: EVENTO,
            organization_id: ORG,
            attempts: 1,
            created_at: new Date(Date.now() - (c.idadeMs ?? 1_000)).toISOString(),
            payload: { conversation_id: CONVERSA, contact_id: CONTATO, channel_session_id: CANAL, inbound_message_id: MSG },
          },
        ],
      };
    }
    // A mesma leitura traz o status da org: parada consome o evento sem job (0501).
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null, status: 'active' }] };
    if (sql.includes('select c.is_group')) return { rows: [{ is_group: false, ia_responde: null }] };
    if (sql.includes('from cadencia_conducoes c') && sql.includes('as reguas'))
      return { rows: [{ conducao_id: c.conducaoId ?? null, reguas: c.reguas ?? null }] };
    if (sql.includes('fn_cadencia_lead_respondeu')) return { rows: [{ r: c.respostaDaFn ?? { ja_encerrada: true } }] };
    if (sql.includes('as tem_agente')) return { rows: [{ tem_agente: c.temAgenteNaSessao ?? false, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) return { rows: [{ id: MSG }] };
    if (sql.includes('as available')) return { rows: [{ available: false }] };
    if (sql.includes('select type, media_derived_status')) return { rows: [{ type: 'text', media_derived_status: null }] };
    if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-1' }] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas };
}

const knobs = { batchSize: 10, intervalMs: 1, idleIntervalMs: 1, debounceMs: 0, reapTimeoutMs: 60_000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const enfileirou = (ch: Array<{ sql: string }>) => ch.some((x) => x.sql.includes('insert into job_queue'));
const adiou = (ch: Array<{ sql: string; params: unknown[] }>) =>
  ch.find((x) => x.sql.includes("status = 'pending', attempts = greatest"));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.elegib.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
});

describe('dreno do agente × cadência', () => {
  it('régua viva sem condução, dentro do teto: ADIA (15s), sem job', async () => {
    const { pool, chamadas } = montar({ reguas: ['enr-1'] });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(false);
    expect(adiou(chamadas)?.params).toEqual([EVENTO, 15_000]);
    expect(chamadas.some((x) => x.sql.includes('fn_cadencia_lead_respondeu'))).toBe(false);
  });

  it('condução viva + sessão SEM agente publicado: enfileira (portão de capacidade contornado)', async () => {
    const { pool, chamadas } = montar({ conducaoId: 'cond-1', temAgenteNaSessao: false });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(true);
  });

  it('CONTROLE: sem cadência e sem agente na sessão, o portão continua pulando', async () => {
    const { pool, chamadas } = montar({ temAgenteNaSessao: false });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(false);
    expect(adiou(chamadas)).toBeUndefined();
  });

  it('passou do teto e a cadência manda pessoa: chama a fn e passa para humano, sem job', async () => {
    const { pool, chamadas } = montar({
      reguas: ['enr-1'],
      idadeMs: TETO_TRANSICAO_DA_CADENCIA_MS + 1_000,
      respostaDaFn: { ja_encerrada: false, modo: 'atendente', conversation_id: CONVERSA },
    });
    await drainTick(pool, knobs, log);
    const fn = chamadas.find((x) => x.sql.includes('fn_cadencia_lead_respondeu'));
    expect(fn?.params).toEqual([ORG, 'enr-1', EVENTO]);
    expect(mocks.passar).toHaveBeenCalledTimes(1);
    expect(mocks.passar.mock.calls[0]?.[2]).toMatchObject({ codigo: 'cadencia_lead_respondeu' });
    expect(enfileirou(chamadas)).toBe(false);
  });

  it('passou do teto e a IA assume: enfileira o turno', async () => {
    const { pool, chamadas } = montar({
      reguas: ['enr-1'],
      idadeMs: TETO_TRANSICAO_DA_CADENCIA_MS + 1_000,
      respostaDaFn: { ja_encerrada: false, modo: 'ia', conversation_id: CONVERSA },
    });
    await drainTick(pool, knobs, log);
    expect(mocks.passar).not.toHaveBeenCalled();
    expect(enfileirou(chamadas)).toBe(true);
  });
});
