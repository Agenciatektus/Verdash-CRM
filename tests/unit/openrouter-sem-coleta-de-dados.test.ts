import { describe, expect, it } from 'vitest';
import { comPrivacidadeDoOpenRouter } from '@/lib/agent-engine/edge/llm/providers';

function espiao() {
  const vistos: Array<{ body: unknown }> = [];
  const f = (async (_i: unknown, init?: RequestInit) => {
    vistos.push({ body: init?.body });
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { f, vistos };
}

describe('OpenRouter sem coleta de dados', () => {
  it('injeta data_collection=deny no endereço canônico', async () => {
    const { f, vistos } = espiao();
    await comPrivacidadeDoOpenRouter(f, 'https://openrouter.ai/api/v1')('https://x', { body: JSON.stringify({ model: 'm' }) });
    expect(JSON.parse(vistos[0]!.body as string)).toEqual({ model: 'm', provider: { data_collection: 'deny' } });
  });

  it('preserva o provider que já veio no corpo', async () => {
    const { f, vistos } = espiao();
    await comPrivacidadeDoOpenRouter(f, 'https://openrouter.ai/api/v1')('https://x', {
      body: JSON.stringify({ provider: { order: ['openai'], data_collection: 'allow' } }),
    });
    expect(JSON.parse(vistos[0]!.body as string).provider).toEqual({ order: ['openai'], data_collection: 'allow' });
  });

  it('não toca em gateway próprio nem em corpo não-JSON', async () => {
    const a = espiao();
    await comPrivacidadeDoOpenRouter(a.f, 'https://gateway.interno/v1')('https://x', { body: '{"a":1}' });
    expect(a.vistos[0]!.body).toBe('{"a":1}');
    const b = espiao();
    await comPrivacidadeDoOpenRouter(b.f, 'https://openrouter.ai/api/v1')('https://x', { body: 'não é json' });
    expect(b.vistos[0]!.body).toBe('não é json');
  });
});
