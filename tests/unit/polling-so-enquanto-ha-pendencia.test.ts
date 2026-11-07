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

  it("agenda: falta com contato segue atualizando até o recibo da recuperação chegar", () => {
    const agora = Date.parse("2026-11-06T22:00:00Z");
    const falta = (marcadaEm: string | null) =>
      ({ status: "no_show", contact_id: "c1", recovery: null, outcome_recorded_at: marcadaEm }) as unknown as Detalhe;
    expect(detalheAindaMuda(falta("2026-11-06T21:59:30Z"), agora)).toBe(true);
    // Teto: recibo que nunca chega (drain parado) não consulta para sempre.
    expect(detalheAindaMuda(falta("2026-11-06T21:57:59Z"), agora)).toBe(false);
    expect(detalheAindaMuda(falta(null), agora)).toBe(false);
    // Controle: sem contato não há recuperação a esperar.
    const semContato = { status: "no_show", contact_id: null, recovery: null } as unknown as Detalhe;
    expect(detalheAindaMuda(semContato)).toBe(false);
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
