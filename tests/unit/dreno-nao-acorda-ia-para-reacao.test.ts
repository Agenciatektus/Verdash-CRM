/**
 * O dreno do agente não abre turno para REAÇÃO nem para mensagem SEM CONTEÚDO
 * (tipo não suportado, enquete cifrada), em qualquer canal.
 *
 * E o outro lado da moeda: a reação que chega DEPOIS da pergunta não pode
 * "superar" a pergunta no anti-backlog, senão ninguém responde.
 */
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ elegib: vi.fn() }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegib }));

import { drainTick } from '@/lib/agent-engine/edge/crm/drain';
import { SQL_MENSAGEM_PEDE_RESPOSTA } from '@/lib/ai/elegibilidade/mensagem-respondivel';

const ORG = '12000000-0000-4000-8000-000000000001';
const CONTATO = '12000000-0000-4000-8000-000000000002';
const CONVERSA = '12000000-0000-4000-8000-000000000003';
const CANAL = '12000000-0000-4000-8000-000000000004';
const MSG = '12000000-0000-4000-8000-000000000006';
const EVENTO = '12000000-0000-4000-8000-000000000007';

function montar(gatilho: Record<string, unknown> | null) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes('returning e.id, e.organization_id')) {
      return {
        rows: [{
          id: EVENTO, organization_id: ORG, attempts: 1, created_at: new Date(Date.now() - 1_000).toISOString(),
          payload: { conversation_id: CONVERSA, contact_id: CONTATO, channel_session_id: CANAL, inbound_message_id: MSG },
        }],
      };
    }
    // A mesma consulta traz o status da organização (org parada não gera turno,
    // upstream a05ac8fcd). Sem `status` o dreno consome o evento antes de olhar a
    // mensagem, e o controle negativo e o anti-backlog nem chegavam a rodar.
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null, status: 'active' }] };
    if (sql.includes('select c.is_group')) return { rows: [{ is_group: false, ia_responde: null }] };
    if (sql.includes('select type, body, media_url')) return { rows: gatilho ? [gatilho] : [] };
    if (sql.includes('as tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) return { rows: [{ id: MSG }] };
    if (sql.includes('as available')) return { rows: [{ available: false }] };
    if (sql.includes('select type, media_derived_status')) return { rows: [] };
    if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-1' }] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas };
}

const knobs = { batchSize: 10, intervalMs: 1, idleIntervalMs: 1, debounceMs: 0, reapTimeoutMs: 60_000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const enfileirou = (ch: Array<{ sql: string }>) => ch.some((x) => x.sql.includes('insert into job_queue'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.elegib.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
});

describe('dreno do agente: só abre turno para mensagem que pede resposta', () => {
  it('texto normal ABRE turno (controle negativo: a guarda não calou a IA)', async () => {
    const { pool, chamadas } = montar({ type: 'text', body: 'qual o preço?', media_url: null, media_storage_path: null });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(true);
  });

  it('reação NÃO abre turno', async () => {
    const { pool, chamadas } = montar({ type: 'reaction', body: '👍', media_url: null, media_storage_path: null });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(false);
  });

  it('tipo não suportado (sem corpo, sem mídia) NÃO abre turno', async () => {
    const { pool, chamadas } = montar({ type: 'text', body: null, media_url: null, media_storage_path: null });
    await drainTick(pool, knobs, log);
    expect(enfileirou(chamadas)).toBe(false);
  });

  it('o anti-backlog ignora reação e mensagem vazia ao eleger "a mais nova"', async () => {
    const { pool, chamadas } = montar({ type: 'text', body: 'oi', media_url: null, media_storage_path: null });
    await drainTick(pool, knobs, log);
    const recencia = chamadas.find((c) => c.sql.includes("direction = 'inbound'"));
    expect(recencia?.sql).toContain("type <> 'reaction'");
    // O predicado é o compartilhado com o TS (`mensagem-respondivel.test.ts`
    // prende os dois). Ele passou a tirar também tabulação, quebra de linha e NBSP
    // na P2-1 do Cassio (corpo só de quebra de linha ou NBSP passava no SQL);
    // casar o texto antigo prendia a forma, e não a regra.
    expect(recencia?.sql).toContain(SQL_MENSAGEM_PEDE_RESPOSTA);
  });
});
