import { describe, expect, it } from "vitest";

import { detalheAindaMuda } from "@/components/agenda/DetalheDoCompromisso";
import { intervaloDasConexoes } from "@/hooks/channels/useConexoes";

type Detalhe = Parameters<typeof detalheAindaMuda>[0];
const compromisso = (status: string, enrollment_status: string | null = null) =>
  ({ status, recovery: enrollment_status ? { enrollment_status } : null }) as unknown as Detalhe;

describe("polling só enquanto há pendência", () => {
  it("agenda: pendente, confirmado ou recuperação viva seguem atualizando", () => {
    expect(detalheAindaMuda(compromisso("pending"))).toBe(true);
    expect(detalheAindaMuda(compromisso("confirmed"))).toBe(true);
    expect(detalheAindaMuda(compromisso("no_show", "active"))).toBe(true);
  });

  it("agenda: concluído, cancelado ou recuperação encerrada param", () => {
    expect(detalheAindaMuda(undefined)).toBe(false);
    expect(detalheAindaMuda(compromisso("completed"))).toBe(false);
    expect(detalheAindaMuda(compromisso("cancelled"))).toBe(false);
    expect(detalheAindaMuda(compromisso("no_show", "dead"))).toBe(false);
  });

  it("conexões: 10 s só com canal subindo ou no QR; senão 60 s", () => {
    expect(intervaloDasConexoes([{ status: "WORKING" }, { status: "SCAN_QR_CODE" }])).toBe(10_000);
    expect(intervaloDasConexoes([{ status: "STARTING" }])).toBe(10_000);
    expect(intervaloDasConexoes([{ status: "WORKING" }, { status: "FAILED" }])).toBe(60_000);
    expect(intervaloDasConexoes(undefined)).toBe(60_000);
  });
});
