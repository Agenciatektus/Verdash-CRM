// lib/grupos/servico.test.ts
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelGroup } from "@/lib/channels/types";
import { logger } from "@/lib/logger";

import {
  alternarGrupo,
  definirIaDoGrupo,
  GrupoError,
  listarGruposDoNumero,
  type DepsDeGrupos,
  type LinhaDoDiretorio,
} from "./servico";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const G1 = "1@g.us";
const G2 = "2@g.us";
const G3_ORFAO = "3@g.us"; // ligado no banco, mas fora da resposta fixa de listGroups (G1/G2)

function deps(
  opts: {
    ligados?: string[];
    capability?: "full" | "none";
    confirma?: boolean;
    /** Grupos com a chave da IA ligada (`ia_responde = true`). */
    iaLiberado?: string[];
    diretorio?: LinhaDoDiretorio[];
    agora?: string;
    falhaAoVivo?: boolean;
  } = {},
) {
  const linhas = new Map<
    string,
    {
      group_chat_id: string;
      subject: string | null;
      enabled: boolean;
      enabled_at: string | null;
      ia_responde: boolean;
    }
  >();
  for (const g of opts.ligados ?? []) {
    linhas.set(g, {
      group_chat_id: g,
      subject: null,
      enabled: true,
      enabled_at: "2026-09-23T00:00:00.000Z",
      ia_responde: (opts.iaLiberado ?? []).includes(g),
    });
  }
  // Diretório em memória: começa vazio (ou com `opts.diretorio`), `gravarDiretorio` o enche como o banco.
  let diretorio: LinhaDoDiretorio[] = opts.diretorio ?? [];
  const d: DepsDeGrupos & { setGroupIntake: ReturnType<typeof vi.fn>; audit: ReturnType<typeof vi.fn> } = {
    db: {
      lerSessao: vi.fn(async () => ({
        provider: DEFAULT_CHANNEL_PROVIDER,
        sessionRef: "s1",
        groupsCapability: opts.capability ?? "full",
      })),
      listarLinhas: vi.fn(async () => [...linhas.values()]),
      lerDiretorio: vi.fn(async () => diretorio),
      gravarDiretorio: vi.fn(async (_o: string, _s: string, grupos: ChannelGroup[], agoraIso: string) => {
        const antigos = new Map(diretorio.map((l) => [l.group_chat_id, l]));
        diretorio = grupos.map((g) => ({
          group_chat_id: g.chatId,
          subject: g.subject,
          participant_count: g.participantCount ?? null,
          admin_count: g.adminCount ?? 0,
          papel: g.papel ?? null,
          is_announce: g.isAnnounce ?? false,
          tipo: g.tipo ?? "grupo",
          // archived/pinned sobrevivem ao refresh, como no upsert que não os envia.
          archived: antigos.get(g.chatId)?.archived ?? null,
          pinned: antigos.get(g.chatId)?.pinned ?? null,
          refreshed_at: agoraIso,
        }));
      }),
      contarLigados: vi.fn(async () => [...linhas.values()].filter((l) => l.enabled).length),
      gravarLinha: vi.fn(async (_o, _s, row) => {
        // Como no banco: linha NOVA nasce com a chave da IA no default
        // (desligada); upsert de linha existente não toca nela.
        const anterior = linhas.get(row.group_chat_id);
        linhas.set(row.group_chat_id, { ...row, ia_responde: anterior?.ia_responde ?? false });
        return { id: "row-" + row.group_chat_id };
      }),
      definirIa: vi.fn(async (_o, _s, chatId, valor) => {
        const l = linhas.get(chatId);
        // Mesma régua do banco: a atualização só alcança linha LIGADA. Grupo
        // sem linha (nunca ligado) ou desligado → null.
        if (!l || !l.enabled) return null;
        linhas.set(chatId, { ...l, ia_responde: valor });
        return { id: "row-" + chatId };
      }),
    },
    listGroups: vi.fn(async () => {
      if (opts.falhaAoVivo) throw new Error("fzap_fora");
      return [
        { chatId: G1, subject: "Cliente A", participantCount: 10, adminCount: 2, papel: "admin" as const, isAnnounce: true, tipo: "grupo" as const },
        { chatId: G2, subject: "Família" },
      ];
    }),
    setGroupIntake: vi.fn(async () => opts.confirma ?? true),
    audit: vi.fn(async () => {}),
    agora: () => new Date(opts.agora ?? "2026-09-23T12:00:00.000Z"),
  };
  return d;
}
const base = { organizationId: ORG, channelSessionId: SESS, subject: "Cliente A", actorUserId: "u1", requestId: "r1" };

describe("listarGruposDoNumero", () => {
  it("junta a lista do WhatsApp com o estado gravado; o padrão é desligado", async () => {
    const { grupos } = await listarGruposDoNumero(deps({ ligados: [G1] }), { organizationId: ORG, channelSessionId: SESS });
    expect(grupos).toEqual([
      {
        chatId: G1, subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00.000Z", presente: true, iaResponde: false,
        participantCount: 10, adminCount: 2, papel: "admin", isAnnounce: true, tipo: "grupo", archived: null, pinned: null,
      },
      {
        chatId: G2, subject: "Família", enabled: false, enabledAt: null, presente: true, iaResponde: false,
        participantCount: null, adminCount: 0, papel: null, isAnnounce: false, tipo: "grupo", archived: null, pinned: null,
      },
    ]);
  });
  it("#2729: a chave da IA vem junto de cada grupo, e o padrão é DESLIGADO", async () => {
    const { grupos: r } = await listarGruposDoNumero(deps({ ligados: [G1], iaLiberado: [G1] }), {
      organizationId: ORG,
      channelSessionId: SESS,
    });
    expect(r.map((g) => [g.chatId, g.iaResponde])).toEqual([
      [G1, true],
      [G2, false],
    ]);
  });
  it("canal sem capacidade de grupos é recusado", async () => {
    await expect(listarGruposDoNumero(deps({ capability: "none" }), { organizationId: ORG, channelSessionId: SESS }))
      .rejects.toMatchObject({ code: "canal_sem_grupos" });
  });
  it("grupo ligado que o número já deixou continua na lista, marcado presente=false, para poder ser desligado", async () => {
    const { grupos: r } = await listarGruposDoNumero(deps({ ligados: [G1, G3_ORFAO] }), {
      organizationId: ORG,
      channelSessionId: SESS,
    });
    expect(r).toContainEqual({
      chatId: G3_ORFAO,
      subject: null,
      enabled: true,
      enabledAt: "2026-09-23T00:00:00.000Z",
      presente: false,
      iaResponde: false,
      participantCount: null, adminCount: 0, papel: null, isAnnounce: false, tipo: "grupo", archived: null, pinned: null,
    });
  });
  it("grupo DESLIGADO que o número já deixou não aparece — não há nada para desligar", async () => {
    // deps() só devolve G1/G2 no listGroups; um G3 desligado e nunca ligado não
    // aparece no `listarLinhas` também (nenhuma linha foi criada), então este
    // caso é o default: nada extra na lista além de G1/G2.
    const r = await listarGruposDoNumero(deps(), { organizationId: ORG, channelSessionId: SESS });
    expect(r.grupos).toHaveLength(2);
  });
});

describe("listarGruposDoNumero: cache do diretório", () => {
  const linha = (id: string, refreshed_at: string, extra: Partial<LinhaDoDiretorio> = {}): LinhaDoDiretorio => ({
    group_chat_id: id, subject: "Do cache", participant_count: 5, admin_count: 1, papel: null, is_announce: false,
    tipo: "grupo", archived: null, pinned: null, refreshed_at, ...extra,
  });
  const e = { organizationId: ORG, channelSessionId: SESS };

  it("cache com menos de 10 min: devolve sem chamar o WhatsApp", async () => {
    const d = deps({ diretorio: [linha(G1, "2026-09-23T11:55:00.000Z", { archived: true })] });
    const r = await listarGruposDoNumero(d, e);
    expect(d.listGroups).not.toHaveBeenCalled();
    expect(r).toMatchObject({ atualizadoEm: "2026-09-23T11:55:00.000Z", desatualizado: false });
    expect(r.grupos[0]).toMatchObject({ chatId: G1, subject: "Do cache", archived: true });
  });
  it("cache velho com `agendar`: responde na hora e atualiza depois", async () => {
    const d = deps({ diretorio: [linha(G1, "2026-09-23T11:00:00.000Z")] });
    const tarefas: Array<() => Promise<void>> = [];
    const r = await listarGruposDoNumero(d, { ...e, agendar: (t) => tarefas.push(t) });
    expect(d.listGroups).not.toHaveBeenCalled();
    expect(r.grupos[0]?.subject).toBe("Do cache");
    await tarefas[0]!();
    expect(d.listGroups).toHaveBeenCalledTimes(1);
    expect(d.db.gravarDiretorio).toHaveBeenCalled();
  });
  it("cache velho sem `agendar`: atualiza e espera; archived/pinned sobrevivem; quem sumiu sai", async () => {
    const d = deps({ diretorio: [linha(G1, "2026-09-23T11:00:00.000Z", { archived: true, pinned: true }), linha(G3_ORFAO, "2026-09-23T11:00:00.000Z")] });
    const r = await listarGruposDoNumero(d, e);
    expect(r.grupos.map((g) => g.chatId)).toEqual([G1, G2]);
    expect(r.grupos[0]).toMatchObject({ subject: "Cliente A", archived: true, pinned: true });
    expect(r.atualizadoEm).toBe("2026-09-23T12:00:00.000Z");
  });
  it("sem cache: busca ao vivo e grava", async () => {
    const d = deps();
    await listarGruposDoNumero(d, e);
    expect(d.listGroups).toHaveBeenCalledTimes(1);
    expect(d.db.gravarDiretorio).toHaveBeenCalledTimes(1);
  });
  it("refresh força ao vivo mesmo com cache novo", async () => {
    const d = deps({ diretorio: [linha(G1, "2026-09-23T11:59:00.000Z")] });
    await listarGruposDoNumero(d, { ...e, refresh: true });
    expect(d.listGroups).toHaveBeenCalledTimes(1);
  });
  it("falha ao vivo com cache: devolve o cache marcado desatualizado; sem cache: erro", async () => {
    const d = deps({ falhaAoVivo: true, diretorio: [linha(G1, "2026-09-23T11:00:00.000Z")] });
    const r = await listarGruposDoNumero(d, { ...e, refresh: true });
    expect(r).toMatchObject({ desatualizado: true, atualizadoEm: "2026-09-23T11:00:00.000Z" });
    await expect(listarGruposDoNumero(deps({ falhaAoVivo: true }), e)).rejects.toThrow("fzap_fora");
  });
});

describe("alternarGrupo", () => {
  it("ligar o PRIMEIRO grupo liga o recebimento no WhatsApp, grava e audita", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).resolves.toEqual({ enabled: true });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", true);
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.group_enabled", organizationId: ORG, actorUserId: "u1" }),
    );
  });
  it("I1: ligar um SEGUNDO grupo TAMBÉM confere o filtro — cura o filtro que derivou (sessão recriada)", async () => {
    const d = deps({ ligados: [G2] });
    await alternarGrupo(d, { ...base, groupChatId: G1, ligar: true });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", true);
  });
  it("I1: com grupos já ligados e o filtro sem confirmar, o novo grupo NÃO fica ligado", async () => {
    const d = deps({ ligados: [G2], confirma: false });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toMatchObject({
      code: "filtro_nao_confirmado",
    });
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
  });
  it("desligar o ÚLTIMO grupo volta a ignorar grupos", async () => {
    const d = deps({ ligados: [G1] });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: false })).resolves.toEqual({ enabled: false });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", false);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_disabled" }));
  });
  it("sem confirmação do WhatsApp, o grupo NÃO fica ligado e nada é gravado", async () => {
    const d = deps({ confirma: false });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toBeInstanceOf(GrupoError);
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
  it("id que não é de grupo é recusado antes de qualquer efeito", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: "5521999990000@c.us", ligar: true })).rejects.toThrow();
    expect(d.setGroupIntake).not.toHaveBeenCalled();
  });
  it("aceita chat id de grupo no formato legado com hífen (medido no servidor real)", async () => {
    const d = deps();
    const comHifen = "123-456@g.us";
    await expect(alternarGrupo(d, { ...base, groupChatId: comHifen, ligar: true })).resolves.toEqual({
      enabled: true,
    });
  });
  it("se setGroupIntake LANÇA (timeout/rede), trata como recusa: nada fica ligado nem gravado", async () => {
    const d = deps();
    d.setGroupIntake = vi.fn(async () => {
      throw new Error("timeout de rede");
    });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toBeInstanceOf(GrupoError);
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toMatchObject({
      code: "filtro_nao_confirmado",
    });
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("I1: religar grupo já ligado reconfere o filtro (o no-op, se houver, é do transporte, sem escrita)", async () => {
    const d = deps({ ligados: [G1] });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).resolves.toEqual({ enabled: true });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", true);
  });

  it("C1: desligar grupo já desligado, com outro grupo ligado, não mexe no filtro", async () => {
    // G1 nunca teve linha (nunca foi ligado); G2 está ligado. Desligar G1 tem
    // que ser um no-op para o filtro — antes do fix, a contagem TOTAL de
    // ligados (1, de G2) casava com `ligados === 1` e derrubava o filtro,
    // deixando G2 preso ligado no banco sem receber nada do WhatsApp.
    const d = deps({ ligados: [G2] });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: false })).resolves.toEqual({ enabled: false });
    expect(d.setGroupIntake).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ filtro_trocado: false }) }),
    );
  });

  it("I1: desligar grava a linha ANTES de mexer no filtro — escrita falhando não desliga o WhatsApp", async () => {
    const d = deps({ ligados: [G1] });
    d.db.gravarLinha = vi.fn(async () => {
      throw new Error("banco fora do ar");
    });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: false })).rejects.toThrow("banco fora do ar");
    expect(d.setGroupIntake).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("I1: falha ao desligar o filtro DEPOIS da escrita não lança ao chamador; vira log e entra na auditoria", async () => {
    const d = deps({ ligados: [G1] });
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    d.setGroupIntake = vi.fn(async () => false);
    const r = await alternarGrupo(d, { ...base, groupChatId: G1, ligar: false });
    expect(r).toEqual({ enabled: false });
    // A linha JÁ FOI gravada como desligada — é o estado correto, mesmo com o
    // filtro do WhatsApp ainda ligado.
    expect(d.db.gravarLinha).toHaveBeenCalledWith(
      ORG,
      SESS,
      expect.objectContaining({ group_chat_id: G1, enabled: false }),
    );
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.group_disabled",
        metadata: expect.objectContaining({ filtro_trocado: true, filtro_desligado: false }),
      }),
    );
    expect(aviso).toHaveBeenCalled();
    aviso.mockRestore();
  });

  it("I1: exceção ao desligar o filtro DEPOIS da escrita também não lança, e a causa vai para o log/auditoria", async () => {
    const d = deps({ ligados: [G1] });
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    d.setGroupIntake = vi.fn(async () => {
      throw new Error("transporte reiniciando");
    });
    const r = await alternarGrupo(d, { ...base, groupChatId: G1, ligar: false });
    expect(r).toEqual({ enabled: false });
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ filtro_desligado: false, motivo_falha_do_filtro: "transporte reiniciando" }),
      }),
    );
    expect(aviso).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ causa: "transporte reiniciando" }));
    aviso.mockRestore();
  });
});

/**
 * #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo".
 *
 * Ela é uma preferência LOCAL do CRM: não mexe no filtro do WhatsApp, não
 * confirma nada com o transporte e não pode existir para um grupo que nem
 * está na inbox (sem linha ligada não há mensagem para a IA responder).
 */
describe("definirIaDoGrupo", () => {
  const ia = { organizationId: ORG, channelSessionId: SESS, groupChatId: G1, actorUserId: "u1", requestId: "r1" };

  it("liga a chave num grupo LIGADO, sem tocar no filtro do WhatsApp, e audita", async () => {
    const d = deps({ ligados: [G1] });
    await expect(definirIaDoGrupo(d, { ...ia, iaResponde: true })).resolves.toEqual({ ia_responde: true });
    expect(d.db.definirIa).toHaveBeenCalledWith(ORG, SESS, G1, true);
    // A chave é local: o transporte não é perguntado nem reiniciado.
    expect(d.setGroupIntake).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.group_ai_enabled",
        organizationId: ORG,
        actorUserId: "u1",
        metadata: expect.objectContaining({ group_chat_id: G1, ia_responde: true }),
      }),
    );
  });

  it("desliga a chave e audita o desligar", async () => {
    const d = deps({ ligados: [G1], iaLiberado: [G1] });
    await expect(definirIaDoGrupo(d, { ...ia, iaResponde: false })).resolves.toEqual({ ia_responde: false });
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.group_ai_disabled", metadata: expect.objectContaining({ ia_responde: false }) }),
    );
    // A chave não muda quem está na inbox: o grupo continua ligado.
    const { grupos: lista } = await listarGruposDoNumero(d, { organizationId: ORG, channelSessionId: SESS });
    expect(lista.find((g) => g.chatId === G1)).toMatchObject({ enabled: true, iaResponde: false });
  });

  it("grupo DESLIGADO (ou nunca ligado) é recusado: nada a liberar, nada gravado", async () => {
    const d = deps({ ligados: [] });
    await expect(definirIaDoGrupo(d, { ...ia, iaResponde: true })).rejects.toMatchObject({ code: "grupo_desligado" });
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("id que não é de grupo é recusado antes de qualquer efeito", async () => {
    const d = deps({ ligados: [G1] });
    await expect(definirIaDoGrupo(d, { ...ia, groupChatId: "5521999990000@c.us", iaResponde: true })).rejects.toThrow();
    expect(d.db.definirIa).not.toHaveBeenCalled();
  });

  it("canal sem capacidade de grupos é recusado", async () => {
    const d = deps({ ligados: [G1], capability: "none" });
    await expect(definirIaDoGrupo(d, { ...ia, iaResponde: true })).rejects.toMatchObject({ code: "canal_sem_grupos" });
  });
});
