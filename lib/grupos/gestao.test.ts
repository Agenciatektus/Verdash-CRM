import { describe, expect, it, vi } from "vitest";

import { montarChamada } from "./acoes";
import { executarAcaoDeGrupo, type DepsDeGestao } from "./gestao";
import { GrupoError } from "./servico";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const G = "120363025407046714@g.us";

function montar(opts: { provider?: string; pertence?: boolean; ligado?: boolean } = {}) {
  const d = {
    db: {
      lerSessao: vi.fn(async () => ({ provider: opts.provider ?? "verdash", sessionRef: "inst", groupsCapability: "full" })),
      listarLinhas: vi.fn(async () => [{ group_chat_id: G, enabled: opts.ligado === true }]),
      contarLigados: vi.fn(async () => 1),
      gravarLinha: vi.fn(async () => ({ id: "l1" })),
    },
    setGroupIntake: vi.fn(async () => true),
    audit: vi.fn(async (_e: unknown) => {}),
    agora: () => new Date(),
    grupoDaSessao: vi.fn(async () => opts.pertence !== false),
    ajustarDiretorio: vi.fn(async () => {}),
    apagarDoDiretorio: vi.fn(async () => {}),
    acao: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true })),
  };
  return d as unknown as DepsDeGestao & typeof d;
}
const rodar = (d: DepsDeGestao, corpo: Record<string, unknown>) => {
  const entrada = { groupChatId: G, ...corpo };
  return executarAcaoDeGrupo(d, {
    organizationId: ORG, channelSessionId: SESS, entrada,
    chamada: montarChamada(entrada) as never, actorUserId: "u1", requestId: "r1",
  });
};

describe("executarAcaoDeGrupo", () => {
  it("grupo de outra sessão: nao encontrado e nada é chamado", async () => {
    const d = montar({ pertence: false });
    await expect(rodar(d, { acao: "nome", nome: "x" })).rejects.toMatchObject({ code: "grupo_nao_encontrado" });
    expect(d.acao).not.toHaveBeenCalled();
  });
  it("canal que não é verdash não gere grupo", async () => {
    await expect(rodar(montar({ provider: "waha" }), { acao: "info" })).rejects.toBeInstanceOf(GrupoError);
  });
  it("info não audita nem mexe no diretório", async () => {
    const d = montar();
    await rodar(d, { acao: "info" });
    expect(d.audit).not.toHaveBeenCalled();
    expect(d.ajustarDiretorio).not.toHaveBeenCalled();
  });
  it("participantes: auditoria só com a contagem, sem telefones; diretório soma", async () => {
    const d = montar();
    await rodar(d, { acao: "participantes", operacao: "add", telefones: ["5521999990000", "5511888887777"] });
    const e = d.audit.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(e.action).toBe("channel.group_participantes");
    expect(e.metadata).toMatchObject({ operacao: "add", quantidade: 2 });
    expect(JSON.stringify(e)).not.toContain("5521999990000");
    expect(d.ajustarDiretorio).toHaveBeenCalledWith(ORG, SESS, G, { participantDelta: 2 });
  });
  it("nome e so_admins_enviam atualizam o diretório", async () => {
    const d = montar();
    await rodar(d, { acao: "nome", nome: " Novo " });
    expect(d.ajustarDiretorio).toHaveBeenCalledWith(ORG, SESS, G, { subject: "Novo" });
    await rodar(d, { acao: "so_admins_enviam", ligado: true });
    expect(d.ajustarDiretorio).toHaveBeenCalledWith(ORG, SESS, G, { is_announce: true });
  });
  it("link só audita com reset", async () => {
    const d = montar();
    await rodar(d, { acao: "link" });
    expect(d.audit).not.toHaveBeenCalled();
    await rodar(d, { acao: "link", reset: true });
    expect(d.audit).toHaveBeenCalledTimes(1);
  });
  it("sair apaga do diretório e desliga o grupo se estava ligado", async () => {
    const d = montar({ ligado: true });
    await rodar(d, { acao: "sair" });
    expect(d.apagarDoDiretorio).toHaveBeenCalledWith(ORG, SESS, G);
    expect(d.db.gravarLinha).toHaveBeenCalledWith(ORG, SESS, expect.objectContaining({ enabled: false }));
  });
  it("erro do transporte: nada é auditado", async () => {
    const d = montar();
    d.acao.mockRejectedValue(new Error("x"));
    await expect(rodar(d, { acao: "sair" })).rejects.toThrow();
    expect(d.audit).not.toHaveBeenCalled();
  });
});
