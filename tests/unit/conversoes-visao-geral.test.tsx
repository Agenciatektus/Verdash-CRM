import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { AbaVisaoGeral, type ResumoDosDestinos } from "@/app/app/settings/conversoes/_abaVisaoGeral";
import { RegrasDeConversaoGoogle } from "@/app/app/settings/conversoes/_regrasGoogle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/actions/settings/salvarRegrasDeConversaoGoogle", () => ({
  salvarRegrasDeConversaoGoogle: vi.fn(),
}));
vi.mock("@/app/actions/settings/acoesDeConversaoGoogle", () => ({ criarAcaoDeConversaoGoogle: vi.fn() }));

afterEach(cleanup);

const RESUMO: ResumoDosDestinos = {
  meta: { conectada: false, habilitada: false, peloCanal: false },
  google: { conectada: true, habilitada: false, etapas: { ligadas: 0, total: 16 } },
  site: { capturaLigada: true },
};

const pendencia = {
  plataforma: "google_ads",
  leadId: "l1",
  evento: "purchase",
  status: "failed",
  motivo: "desabilitada",
  detalhe: null,
  valorCentavos: 150000,
  tentadoEm: "2026-10-31T14:10:00Z",
  tituloDoLead: "Ana Souza",
};

function abrir(pendencias: unknown[]) {
  return render(
    <AbaVisaoGeral
      resumo={RESUMO}
      pendencias={pendencias as never}
      enviadas={0}
      rotulosDeEtapa={[]}
      idioma="pt-BR"
    />,
  );
}

describe("aba Visão geral de Conversões", () => {
  it("com pendência: avisa com a contagem e leva à lista", () => {
    const { container } = abrir([pendencia]);
    // O alvo da âncora existe na mesma aba.
    expect(container.querySelector("#pendencias")).not.toBeNull();
    const aviso = screen.getByRole("status");
    expect(aviso.textContent).toContain("1");
    expect(within(aviso).getByRole("link", { name: "Ver pendência" }).getAttribute("href")).toBe("#pendencias");
  });

  it("sem pendência: não há aviso", () => {
    abrir([]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cada destino mostra o estado e leva à aba certa", () => {
    abrir([]);
    const destino = (aba: string) => within(screen.getByTestId(`destino-${aba}`));
    expect(destino("meta").getByText("Não conectada")).toBeTruthy();
    expect(destino("meta").getByRole("link").getAttribute("href")).toBe("?aba=meta");
    expect(destino("google").getByText("Envio desligado")).toBeTruthy();
    expect(destino("google").getByText("0 de 16")).toBeTruthy();
    expect(destino("google").getByRole("link").getAttribute("href")).toBe("?aba=google");
    expect(destino("site").getByText("Captura ligada")).toBeTruthy();
    expect(destino("site").getByRole("link").getAttribute("href")).toBe("?aba=site");
  });
});

describe("etapas do Google agrupadas por funil", () => {
  it("conta N de M por funil e deixa recolhido o grupo sem etapa ligada", () => {
    const etapas = [
      { id: "a", nome: "Novo", funil: "Tráfego", primeira: true },
      { id: "b", nome: "Qualificado", funil: "Tráfego", primeira: false },
      { id: "c", nome: "Novo", funil: "Disparo", primeira: true },
    ];
    const regra = {
      id: "r1", stageId: "a", eventName: "e", label: "Novo lead", googleActionId: "1",
      category: "CONTACT", includedInConversions: true, channel: "todos", enabled: true,
    };
    const { container } = render(
      <RegrasDeConversaoGoogle etapas={etapas} regras={[regra] as never} idioma="pt-BR" podeCriarAcao={false} />,
    );
    const grupos = [...container.querySelectorAll("details")];
    expect(grupos.map((g) => g.querySelector("summary")?.textContent)).toEqual([
      "Tráfego1 de 2",
      "Disparo0 de 1",
    ]);
    expect(grupos.map((g) => g.open)).toEqual([true, false]);
  });
});
