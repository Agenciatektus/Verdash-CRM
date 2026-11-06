import { describe, expect, it, vi } from "vitest";

import { enviarAvisoNoWhatsApp, type DepsDoWhatsApp } from "@/lib/plataformas-de-anuncio/meta/alerta/whatsapp";
import { textoDoWhatsApp } from "@/lib/plataformas-de-anuncio/meta/alerta/texto";

function deps(sobrescreve: Partial<DepsDoWhatsApp> & { canal?: Record<string, unknown>; cfg?: Record<string, unknown> | null } = {}) {
  const envia = vi.fn(async () => ({ externalId: null }));
  const base: DepsDoWhatsApp = {
    carregaConfig: async () =>
      sobrescreve.cfg === null
        ? null
        : ({ organization_id: "o", channel_session_id: "c1", telefone_destino: "5511999999999", destino_jid: null, ligado: true, ...sobrescreve.cfg } as never),
    destinoEhDaPropriaOrganizacao: async () => false,
    carregaCanal: async () =>
      ({ id: "c1", status: "WORKING", archived_at: null, aceitaMensagemLivre: true, ...sobrescreve.canal }) as never,
    transporte: { configurado: async () => true, resolveDestino: async () => "5511999999999@s", envia },
    pacing: { decide: async () => ({ liberado: true }), registraEnvio: vi.fn(async () => undefined) },
    clock: () => new Date("2026-10-25T12:00:00Z"),
  };
  return { d: { ...base, ...sobrescreve, carregaConfig: sobrescreve.carregaConfig ?? base.carregaConfig } as DepsDoWhatsApp, envia };
}

describe("enviarAvisoNoWhatsApp", () => {
  it("configurado e ligado: envia", async () => {
    const { d, envia } = deps();
    expect(await enviarAvisoNoWhatsApp(d, "o", "oi")).toBe("enviado");
    expect(envia).toHaveBeenCalledWith("o", expect.anything(), "5511999999999@s", "oi");
  });

  it("não configurado ou desligado: ignora em silêncio, sem enviar", async () => {
    for (const cfg of [null, { ligado: false }, { channel_session_id: null }]) {
      const { d, envia } = deps({ cfg });
      expect(await enviarAvisoNoWhatsApp(d, "o", "oi")).toBe("ignorado");
      expect(envia).not.toHaveBeenCalled();
    }
  });

  it("conexão desabilitada, arquivada ou desconectada: não envia e diz o motivo", async () => {
    expect(await enviarAvisoNoWhatsApp(deps({ canal: { desativado: true } }).d, "o", "x")).toBe("falhou:canal_desativado");
    expect(await enviarAvisoNoWhatsApp(deps({ canal: { archived_at: "2026-01-01" } }).d, "o", "x")).toBe("falhou:canal_arquivado");
    expect(await enviarAvisoNoWhatsApp(deps({ canal: { status: "STOPPED" } }).d, "o", "x")).toBe("falhou:canal_desconectado");
  });

  it("destino é número de conexão ativa da própria organização: não envia", async () => {
    const { d, envia } = deps();
    d.destinoEhDaPropriaOrganizacao = async () => true;
    expect(await enviarAvisoNoWhatsApp(d, "o", "x")).toBe("falhou:destino_da_propria_organizacao");
    expect(envia).not.toHaveBeenCalled();
  });

  it("com a opção permiteDestinoDaPropriaOrganizacao: envia mesmo sendo conexão da organização", async () => {
    const { d, envia } = deps();
    d.destinoEhDaPropriaOrganizacao = async () => true;
    expect(await enviarAvisoNoWhatsApp(d, "o", "x", { permiteDestinoDaPropriaOrganizacao: true })).toBe("enviado");
    expect(envia).toHaveBeenCalledTimes(1);
  });

  it("número inválido: não envia", async () => {
    const { d, envia } = deps();
    d.transporte.resolveDestino = async () => null;
    expect(await enviarAvisoNoWhatsApp(d, "o", "x")).toBe("falhou:destino_invalido");
    expect(envia).not.toHaveBeenCalled();
  });

  it("pacing (custo de mensagem) não liberado: não envia", async () => {
    const { d, envia } = deps();
    d.pacing.decide = async () => ({ liberado: false, motivo: "teto_diario", liberaEm: new Date() });
    expect(await enviarAvisoNoWhatsApp(d, "o", "x")).toBe("falhou:pacing_teto_diario");
    expect(envia).not.toHaveBeenCalled();
  });

  it("falha do envio: devolve motivo, nunca lança", async () => {
    const { d } = deps();
    d.transporte.envia = async () => {
      throw new Error("TOKEN-SECRETO");
    };
    expect(await enviarAvisoNoWhatsApp(d, "o", "x")).toBe("falhou:erro_no_envio");
  });
});

describe("textoDoWhatsApp", () => {
  const p = { marco: "d3", janela: "j", diasRestantes: 3, recusada: false };
  it("curto, com a organização e o caminho, sem dado sensível", () => {
    expect(textoDoWhatsApp(p, "Clínica X", "pt-BR")).toBe(
      "A conexão com a Meta de Clínica X vence em 3 dias. Reconecte em Ajustes > Meta Ads.",
    );
    expect(textoDoWhatsApp({ ...p, recusada: true }, "Clínica X", "pt-BR")).toContain("foi recusada");
    expect(textoDoWhatsApp({ ...p, diasRestantes: 0 }, "Clínica X", "pt-BR")).toContain("venceu");
  });
});
