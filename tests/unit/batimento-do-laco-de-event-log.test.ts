// @vitest-environment node
/**
 * O batimento do laço de event_log: o worker é o dono dos handlers e o cron
 * `event-log-drain` só drena quando o batimento está velho ou ilegível.
 *
 * Toda dúvida tem de cair do lado de o cron DRENAR (o comportamento antigo,
 * seguro pelo claim CAS) — um batimento que cala o cron por engano para o
 * event_log inteiro, sem erro em lugar nenhum.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/lib/agent-engine/obs/logger';
import {
  BATIMENTO_VELHO_MS,
  CHAVE_DO_BATIMENTO,
  INTERVALO_DO_BATIMENTO_MS,
  batimentoEstaNaVez,
  criarArmazemDoBatimento,
  lerBatimento,
  registrarBatimento,
  workerEstaDrenando,
  type ArmazemDoBatimento,
} from '@/lib/event-log/batimento-do-laco';
import { runEventLogDrainLoop } from '@/lib/event-log/drain-loop';

afterEach(() => vi.useRealTimers());

describe('a regra: o worker está drenando?', () => {
  const agora = 10_000_000;

  it('batimento recente = sim', () => {
    expect(workerEstaDrenando(agora - 1_000, agora)).toBe(true);
    expect(workerEstaDrenando(agora - (BATIMENTO_VELHO_MS - 1), agora)).toBe(true);
  });

  it('batimento velho = não (o cron assume)', () => {
    expect(workerEstaDrenando(agora - BATIMENTO_VELHO_MS, agora)).toBe(false);
    expect(workerEstaDrenando(agora - 10 * 60_000, agora)).toBe(false);
  });

  it('sem batimento ou valor inválido = não', () => {
    expect(workerEstaDrenando(null, agora)).toBe(false);
    expect(workerEstaDrenando(Number.NaN, agora)).toBe(false);
  });

  it('batimento muito no futuro (relógio torto) não cala o cron', () => {
    expect(workerEstaDrenando(agora + BATIMENTO_VELHO_MS, agora)).toBe(false);
    expect(workerEstaDrenando(agora + 5_000, agora)).toBe(true);
  });

  it('o worker bate com folga de várias vezes dentro da janela do velho', () => {
    expect(BATIMENTO_VELHO_MS / INTERVALO_DO_BATIMENTO_MS).toBeGreaterThanOrEqual(4);
    expect(batimentoEstaNaVez(null, 0)).toBe(true);
    expect(batimentoEstaNaVez(0, INTERVALO_DO_BATIMENTO_MS - 1)).toBe(false);
    expect(batimentoEstaNaVez(0, INTERVALO_DO_BATIMENTO_MS)).toBe(true);
  });
});

describe('a ida ao Redis falha aberta', () => {
  it('grava timestamp na chave com TTL', async () => {
    const set = vi.fn(async () => 'OK');
    const ok = await registrarBatimento({ get: vi.fn(), set }, 123);
    expect(ok).toBe(true);
    expect(set).toHaveBeenCalledWith(CHAVE_DO_BATIMENTO, '123', { ex: expect.any(Number) });
  });

  it('lê número ou string numérica (o SDK desserializa)', async () => {
    expect(await lerBatimento({ get: async () => 456, set: vi.fn() })).toBe(456);
    expect(await lerBatimento({ get: async () => '789', set: vi.fn() })).toBe(789);
  });

  it('Redis que lança, devolve lixo ou não tem a chave → null (cron drena)', async () => {
    const lanca = { get: async () => Promise.reject(new Error('ECONNREFUSED')), set: vi.fn() };
    expect(await lerBatimento(lanca)).toBeNull();
    expect(await lerBatimento({ get: async () => 'abc', set: vi.fn() })).toBeNull();
    expect(await lerBatimento({ get: async () => null, set: vi.fn() })).toBeNull();
    const falha = { get: vi.fn(), set: async () => Promise.reject(new Error('x')) };
    expect(await registrarBatimento(falha, 1)).toBe(false);
  });

  it('Redis que não responde → null depois do teto, sem pendurar o cron', async () => {
    vi.useFakeTimers();
    const pendurado: ArmazemDoBatimento = { get: () => new Promise(() => {}), set: vi.fn() };
    const leitura = lerBatimento(pendurado);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await leitura).toBeNull();
  });

  it('sem configuração do Redis não há armazém', () => {
    expect(criarArmazemDoBatimento({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      criarArmazemDoBatimento({
        UPSTASH_REDIS_REST_URL: '"http://srh:80"',
        UPSTASH_REDIS_REST_TOKEN: 't',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('o laço do worker bate', () => {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const knobs = { intervalMs: 2_000, idleIntervalMs: 2_000, idleMaxMs: 2_000, staleSweepMs: 60_000, batchSize: 50 };
  const resumoVazio = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };

  it('no máximo 1 escrita por intervalo, ao longo de muitos ticks', async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => 'OK');
    const controller = new AbortController();
    const loop = runEventLogDrainLoop(knobs, log, controller.signal, { deps: {
      drainEventLog: vi.fn(async () => resumoVazio),
      admin: {} as never,
      batimento: { get: vi.fn(), set },
    } });
    // 60 s a 2 s por tick = 30 ticks; batidas em 0, 15, 30, 45 e 60 s.
    await vi.advanceTimersByTimeAsync(60_000);
    controller.abort();
    await loop;
    expect(set.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(set.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('tick que lança NÃO bate — o batimento afirma "estou drenando", não "estou vivo"', async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => 'OK');
    const controller = new AbortController();
    const loop = runEventLogDrainLoop(knobs, log, controller.signal, { deps: {
      drainEventLog: vi.fn(async () => {
        throw new Error('banco fora');
      }),
      admin: {} as never,
      batimento: { get: vi.fn(), set },
    } });
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    await loop;
    expect(set).not.toHaveBeenCalled();
  });
});
