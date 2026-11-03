import { describe, expect, it } from "vitest";
import type { EtapaDoFunil, MensagemDaConversa } from "@/lib/organizador/decidir";
import { atalhoDaLoja, ehAutomatica, ehTrocaOuDevolucao, lerRegras, pedeTroca, perdidoPorSilencio, semAutomaticas } from "@/lib/organizador/regras-da-loja";

const etapa = (id: string, name: string, position: number, extra: Partial<EtapaDoFunil> = {}): EtapaDoFunil => ({
  id, name, position, is_won: false, is_lost: false, is_archived: false, ...extra,
});
const ETAPAS = [
  etapa("novo", "Novo Contato", 1000),
  etapa("camp", "Campanha enviada", 1500),
  etapa("atend", "Em atendimento", 2000),
  etapa("pos", "Pós-venda", 7000),
  etapa("perdido", "Não Comprou", 7000, { is_lost: true }),
];
const msg = (direction: "inbound" | "outbound", body: string, sent_at = "2026-11-01T10:00:00Z"): MensagemDaConversa => ({ direction, body, sent_at });
const REGRAS = lerRegras({ etapa_disparo: "Campanha enviada", funil_posvenda: "Pós-Vendas", dias_para_perda: 7, motivo_perda: "Sem resposta" });

describe("resposta automática", () => {
  it("reconhece robô e não confunde com cliente de verdade", () => {
    expect(ehAutomatica("Boa tarde! Como posso te ajudar hoje?")).toBe(true);
    expect(ehAutomatica("Recebi seu aviso. Passei sua oferta para a nossa equipe")).toBe(true);
    expect(ehAutomatica("Quanto tá o Mizuno?")).toBe(false);
  });
  it("só tira robô do lado do cliente", () => {
    const h = [msg("outbound", "como posso te ajudar hoje?"), msg("inbound", "Como posso te ajudar hoje?")];
    expect(semAutomaticas(h)).toHaveLength(1);
  });
});

describe("atalhos da loja", () => {
  it("disparo sem resposta vai para Campanha enviada", () => {
    const a = atalhoDaLoja(REGRAS, ETAPAS, "novo", [msg("outbound", "Bom dia, tudo bem?"), msg("outbound", "link do grupo")]);
    expect(a).toMatchObject({ mover: true, etapa: { id: "camp" } });
  });
  it("disparo respondido SÓ por robô continua sendo disparo", () => {
    const h = semAutomaticas([msg("outbound", "promoção"), msg("inbound", "Como posso te ajudar hoje?")]);
    expect(atalhoDaLoja(REGRAS, ETAPAS, "novo", h).mover).toBe(true);
  });
  it("cliente que respondeu (até por áudio) não é disparo", () => {
    expect(atalhoDaLoja(REGRAS, ETAPAS, "novo", [msg("outbound", "oi"), msg("inbound", "")]).mover).toBe(false);
  });
  it("nunca recua: quem já está além da campanha fica", () => {
    expect(atalhoDaLoja(REGRAS, ETAPAS, "atend", [msg("outbound", "oi")]).mover).toBe(false);
  });
  it("troca com compra anterior pede o funil de pós-venda", () => {
    const h = [msg("outbound", "seu pedido chegou?"), msg("inbound", "recebi mas quero trocar o tamanho")];
    expect(ehTrocaOuDevolucao(h)).toBe(true);
    expect(pedeTroca(h)).toBe(true);
    expect(REGRAS.funil_posvenda).toBe("Pós-Vendas");
  });
  it("pedir troca ANTES de comprar é venda, não pós-venda", () => {
    expect(ehTrocaOuDevolucao([msg("inbound", "dá pra trocar o tamanho depois?")])).toBe(false);
  });
  it("sem regras configuradas nada acontece", () => {
    expect(atalhoDaLoja({}, ETAPAS, "novo", [msg("outbound", "oi")]).mover).toBe(false);
  });
});

describe("perda por silêncio", () => {
  const agora = new Date("2026-11-10T12:00:00Z");
  it("respondeu e a loja ficou 7+ dias sem retorno do cliente: perdido", () => {
    const h = [msg("inbound", "quanto?", "2026-11-01T10:00:00Z"), msg("outbound", "299", "2026-11-02T10:00:00Z")];
    expect(perdidoPorSilencio(REGRAS, h, agora)).toBe(true);
  });
  it("antes do prazo não perde", () => {
    const h = [msg("inbound", "quanto?", "2026-11-08T10:00:00Z"), msg("outbound", "299", "2026-11-09T10:00:00Z")];
    expect(perdidoPorSilencio(REGRAS, h, agora)).toBe(false);
  });
  it("quem nunca respondeu é campanha, não perda", () => {
    expect(perdidoPorSilencio(REGRAS, [msg("outbound", "promo", "2026-10-01T10:00:00Z")], agora)).toBe(false);
  });
  it("última fala do cliente: a bola é da loja, não perde", () => {
    const h = [msg("outbound", "299", "2026-10-01T10:00:00Z"), msg("inbound", "ok", "2026-10-02T10:00:00Z")];
    expect(perdidoPorSilencio(REGRAS, h, agora)).toBe(false);
  });
  it("sem dias_para_perda a regra está desligada", () => {
    const h = [msg("inbound", "x", "2026-10-01T10:00:00Z"), msg("outbound", "y", "2026-10-02T10:00:00Z")];
    expect(perdidoPorSilencio({}, h, agora)).toBe(false);
  });
});

describe("P1 do Cassio: troca e silêncio sem falso positivo", () => {
  it("garantia/troca perguntadas ANTES de comprar, com disparo da loja, não são pós-venda", () => {
    const a = [msg("outbound", "Chegou a coleção nova!"), msg("inbound", "qual a garantia?")];
    const b = [msg("outbound", "fazemos entrega na cidade"), msg("inbound", "se não servir dá pra trocar?")];
    expect(pedeTroca(a)).toBe(false);
    expect(pedeTroca(b)).toBe(false);
    expect(pedeTroca([msg("inbound", "comprei um em outra loja e veio com defeito, vocês consertam?")])).toBe(false);
  });
  it("troca depois de a LOJA confirmar a venda é pós-venda", () => {
    const h = [msg("outbound", "Pix recebido, seu pedido sai amanhã"), msg("inbound", "quero trocar o tamanho")];
    expect(pedeTroca(h)).toBe(true);
  });
  it("venda confirmada pela loja e cliente calado não vira perdido", () => {
    const h = [msg("inbound", "fechado", "2026-10-01T10:00:00Z"), msg("outbound", "Pix recebido, seu pedido sai amanhã", "2026-10-02T10:00:00Z")];
    expect(perdidoPorSilencio(REGRAS, h, new Date("2026-11-10T12:00:00Z"))).toBe(false);
  });
  it("fala humana com 'em breve' não é robô", () => {
    expect(ehAutomatica("passo aí em breve uma hora dessas")).toBe(false);
    expect(ehAutomatica("Em breve um de nossos atendentes falará com você")).toBe(true);
  });
});
