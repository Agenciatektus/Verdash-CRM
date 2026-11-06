import { describe, expect, it } from "vitest";

import { filtrarGrupos, type Grupo } from "./grupos-lista";

const g = (chatId: string, subject: string, extra: Partial<Grupo> = {}): Grupo => ({
  chatId, subject, enabled: false, enabledAt: null, presente: true, ...extra,
});
const o = { busca: "", tipo: "todos" as const, aba: "ativos" as const, semNome: "Grupo sem nome" };

describe("filtrarGrupos", () => {
  const lista = [
    g("1@g.us", "Zeta"),
    g("2@g.us", "Alfa", { enabled: true }),
    g("3@g.us", "Beta", { pinned: true }),
    g("4@g.us", "Arq", { archived: true }),
    g("5@g.us", "Comu", { tipo: "comunidade" }),
  ];
  it("ordem: fixados, ligados, nome; arquivados fora de Ativos", () => {
    expect(filtrarGrupos(lista, o).map((x) => x.subject)).toEqual(["Beta", "Alfa", "Comu", "Zeta"]);
  });
  it("aba Arquivados só traz archived === true", () => {
    expect(filtrarGrupos(lista, { ...o, aba: "arquivados" }).map((x) => x.subject)).toEqual(["Arq"]);
  });
  it("filtro de tipo; ausente conta como grupo", () => {
    expect(filtrarGrupos(lista, { ...o, tipo: "comunidade" }).map((x) => x.subject)).toEqual(["Comu"]);
    expect(filtrarGrupos(lista, { ...o, tipo: "grupo" })).toHaveLength(3);
  });
  it("busca ignora acento e caixa", () => {
    expect(filtrarGrupos([g("6@g.us", "Grupo São")], { ...o, busca: "sao" })).toHaveLength(1);
  });
});
