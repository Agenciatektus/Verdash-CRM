import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CartaoDaConexaoGoogle } from "@/app/app/agenda/_components/CartaoDaConexaoGoogle";
import { recorteDaGrade } from "@/lib/agenda/recorte-da-grade";
import { visaoPadraoDaLargura } from "@/lib/agenda/visao-padrao";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const ate = (max: number) => (q: string) => Number(/max-width: (\d+)px/.exec(q)?.[1]) >= max;

describe("visão padrão da Agenda pela largura", () => {
  it("iPad 820 abre em 3 dias; celular no dia; desktop na semana", () => {
    expect(visaoPadraoDaLargura(ate(820))).toBe("tres");
    expect(visaoPadraoDaLargura(ate(390))).toBe("dia");
    expect(visaoPadraoDaLargura(ate(1440))).toBe("semana");
  });
  it("a visão de 3 dias busca exatamente 3 dias", () => {
    const { de, ate: fim } = recorteDaGrade("tres", new Date(2026, 10, 5, 12));
    expect((fim.getTime() - de.getTime()) / 86_400_000).toBeCloseTo(3, 0);
  });
});

describe("aviso do Google na faixa fina", () => {
  it("Dispensar esconde o aviso e a escolha fica guardada", () => {
    const { unmount } = render(<CartaoDaConexaoGoogle chaveDoAviso="agenda:aviso-teste" configurado falta={[]} contaConectada={null} />);
    expect(screen.getByTestId("conectar-google")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dispensar"));
    expect(screen.queryByTestId("conectar-google")).toBeNull();
    unmount();
    render(<CartaoDaConexaoGoogle chaveDoAviso="agenda:aviso-teste" configurado falta={[]} contaConectada={null} />);
    expect(screen.queryByTestId("conectar-google")).toBeNull();
  });
});
