/**
 * DESCONECTAR A ASSINATURA DO CHATGPT COM VERSÃO PUBLICADA APONTANDO PARA ELA.
 *
 * O defeito: `desconectarLoginCodex` fazia DELETE em `ai_provider_credentials`,
 * mas `ai_agent_versions.credential_id` é `ON DELETE RESTRICT` e a versão
 * não-rascunho não pode trocar de credencial. Depois que QUALQUER versão
 * publicada usava a assinatura, o DELETE devolvia `23503`, a função engolia o
 * erro (`return !error`) e a tela dizia "O banco recusou a gravação", para sempre.
 *
 * O conserto: desconectar = desativar e APAGAR O SEGREDO da linha. Os casos:
 *
 *  1. Com a FK bloqueando DELETE, desconectar funciona: a linha fica, inativa,
 *     sem envelope cifrado, sem `last4` e sem `validated_at`; o leitor não a vê.
 *  2. Reconectar depois reaproveita a MESMA linha (a unicidade org+provider+label
 *     barraria um INSERT novo) e o par novo volta a ser lido.
 *  3. A renovação automática não toca a linha desconectada.
 *  4. A action registra o erro real em log e devolve um código que a tela traduz.
 *
 * Controle negativo: no código anterior (DELETE), os casos 1, 2 e 4-sucesso ficam
 * vermelhos: o DELETE devolve 23503 e a reconexão bate em `label_em_uso`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

const estado = vi.hoisted(() => ({ fake: null as unknown }));
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CRED = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => estado.fake,
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(async () => ({ id: USER, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, role: "admin" })),
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { desconectarLoginCodexAgora } from "@/app/actions/settings/conectarLoginCodex";
import {
  desconectarLoginCodex,
  guardarLoginCodex,
  lerLoginCodex,
  lerLoginCodexRenovandoSeProxima,
  renovarComTravaDeBanco,
  ROTULO_DO_LOGIN_CODEX,
} from "@/lib/ai/credenciais/login-codex";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { audit } from "@/lib/audit";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

const tokens: TokensDoCodex = {
  access_token: "at-original-1234",
  refresh_token: "rt-original-5678",
  client_id: "siwc-client-test",
  subject: "conta-chatgpt-a",
  scopes: ["chatgpt.tokens.use.direct"],
  expires_at: null,
};

/** A linha de produção: ativa, validada, usada por uma versão PUBLICADA (FK RESTRICT). */
function fakeComVersaoPublicada(): FakeSupabase {
  const c = encryptKey(JSON.stringify(tokens));
  const fake = new FakeSupabase();
  fake.linha = {
    id: CRED,
    organization_id: ORG,
    provider: PROVEDOR_POR_ASSINATURA,
    label: ROTULO_DO_LOGIN_CODEX,
    is_active: true,
    validated_at: new Date().toISOString(),
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
    api_key_last4: "1234",
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  };
  fake.versaoPublicadaApontaParaALinha = true;
  estado.fake = fake;
  return fake;
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe("desconectar com versão publicada referenciando a credencial", () => {
  it("funciona: desativa a linha, apaga o segredo e o leitor deixa de vê-la", async () => {
    const fake = fakeComVersaoPublicada();
    expect(await lerLoginCodex({ admin: fake as never, orgId: ORG })).toEqual(tokens);

    const r = await desconectarLoginCodex({ admin: fake as never, orgId: ORG });

    expect(r).toEqual({ ok: true, id: CRED });
    // A linha FICA (a versão publicada continua apontando para ela) ...
    const linha = fake.linha!;
    expect(linha.id).toBe(CRED);
    expect(linha.is_active).toBe(false);
    // ... mas sem nada que abra ou identifique a sessão.
    expect(linha.api_key_encrypted).toBe("\\x");
    expect(linha.api_key_iv).toBe("\\x");
    expect(linha.api_key_tag).toBe("\\x");
    expect(linha.api_key_last4).toBe("");
    expect(linha.validated_at).toBeNull();
    expect(fake.operacoes.some((o) => o.tipo === "delete")).toBe(false);
    // O runtime (worker/scheduler/edge) lê por aqui: sem par, cai na reserva.
    expect(await lerLoginCodex({ admin: fake as never, orgId: ORG })).toBeNull();
    expect(await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG })).toBeNull();
  });

  it("a action devolve ok e audita a desconexão com o id da linha", async () => {
    fakeComVersaoPublicada();
    expect(await desconectarLoginCodexAgora()).toEqual({ ok: true });
    expect(vi.mocked(audit).mock.calls.map(([e]) => [e.action, e.resourceId])).toEqual([
      ["ai.login_codex_desconectado", CRED],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("falha do banco vira log com código e mensagem (sem segredo) e erro traduzível na tela", async () => {
    const fake = fakeComVersaoPublicada();
    fake.erroNoUpdate = { code: "42501", message: "permission denied for table ai_provider_credentials" };

    expect(await desconectarLoginCodexAgora()).toEqual({ ok: false, error: "desconexao_recusada" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, meta] = vi.mocked(logger.error).mock.calls[0]!;
    expect(meta).toEqual({
      organizationId: ORG,
      codigo: "42501",
      mensagem: "permission denied for table ai_provider_credentials",
    });
    expect(JSON.stringify(meta)).not.toContain("rt-original");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("reconectar depois de desconectar", () => {
  it("reaproveita a MESMA linha, reativa e o par novo volta a ser lido", async () => {
    const fake = fakeComVersaoPublicada();
    // O estado de uma linha desconectada, escrito à mão: o teste não depende de
    // `desconectarLoginCodex` para provar que reconectar acha a linha inativa.
    fake.linha = {
      ...fake.linha!,
      is_active: false,
      api_key_encrypted: "\\x",
      api_key_iv: "\\x",
      api_key_tag: "\\x",
      api_key_last4: "",
      validated_at: null,
    };

    const novos: TokensDoCodex = {
      ...tokens,
      access_token: "at-novo-9999",
      refresh_token: "rt-novo-0000",
      subject: "conta-chatgpt-b",
    };
    const r = await guardarLoginCodex({ admin: fake as never, orgId: ORG, userId: USER, tokens: novos });

    expect(r).toEqual({ ok: true, id: CRED });
    expect(fake.operacoes.some((o) => o.tipo === "insert")).toBe(false);
    const linha = fake.linha!;
    expect(linha.id).toBe(CRED);
    expect(linha.is_active).toBe(true);
    expect(linha.validated_at).not.toBeNull();
    expect(linha.api_key_last4).toBe("9999");
    expect(await lerLoginCodex({ admin: fake as never, orgId: ORG })).toEqual(novos);
  });
});

describe("a renovação não ressuscita a linha desconectada", () => {
  it("renovarComTravaDeBanco devolve nao_encontrada sem chamar o provedor", async () => {
    const fake = fakeComVersaoPublicada();
    await desconectarLoginCodex({ admin: fake as never, orgId: ORG });
    const renovar = vi.fn(async (t: TokensDoCodex) => t);

    const r = await renovarComTravaDeBanco({
      admin: fake as never,
      orgId: ORG,
      credentialId: CRED,
      userId: null,
      renovar,
    });

    expect(r).toEqual({ ok: false, motivo: "nao_encontrada" });
    expect(renovar).not.toHaveBeenCalled();
    expect(fake.linha!.is_active).toBe(false);
    expect(fake.linha!.api_key_encrypted).toBe("\\x");
  });

  it("desconectar DURANTE a renovação: o par renovado não volta para a linha", async () => {
    const fake = fakeComVersaoPublicada();
    const r = await renovarComTravaDeBanco({
      admin: fake as never,
      orgId: ORG,
      credentialId: CRED,
      userId: null,
      renovar: async (t) => {
        await desconectarLoginCodex({ admin: fake as never, orgId: ORG });
        return { ...t, access_token: "at-renovado", refresh_token: "rt-renovado" };
      },
    });

    // #3371: a recusa agora carrega `motivoDetalhe`; o desfecho continua `falha`.
    expect(r).toMatchObject({ ok: false, motivo: "falha" });
    expect(fake.linha!.is_active).toBe(false);
    expect(fake.linha!.api_key_encrypted).toBe("\\x");
  });
});
