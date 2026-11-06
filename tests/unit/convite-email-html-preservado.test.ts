import { describe, expect, it } from "vitest";

import fixture from "@/tests/fixtures/convites-2649-html-main.json";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import { montarTemplateDeAcesso, type ModeloDeAcesso } from "@/lib/email/templates/acesso-gotrue";
import { buildInviteEmail } from "@/lib/email/templates/invite";

// Regravado na subida 1.95 com o NOSSO layout com a marca (o do upstream não entra), entradas sintéticas. A extração da
// moldura não autoriza trocar cor, fonte, texto ou idioma de quem já recebia.
const opcoes = {
  inviterName: "Ana",
  orgName: "Equipe sintética",
  role: "agent",
  acceptUrl: "https://crm.example.test/team/accept-invite/token",
  expiresAt: new Date("2026-11-01T12:00:00Z"),
};

describe("limpeza dos e-mails preserva a identidade distribuída", () => {
  it.each(fixture.casos)("$tipo, logo $marca.logoUrl: saída byte a byte da main", (caso) => {
    const marca = caso.marca as MarcaDeSaida;
    const atual =
      caso.tipo === "convite"
        ? buildInviteEmail({ ...opcoes, marca })
        : montarTemplateDeAcesso(caso.tipo as ModeloDeAcesso, marca);
    expect(atual).toEqual(caso.esperado);
  });

  it("a URL do convite não vira atributo nem elemento HTML, e continua copiável", () => {
    const acceptUrl = 'https://crm.example.test/aceitar?a=1&b="><img src=x onerror=alert(1)>';
    const caso = fixture.casos[0];
    if (!caso) throw new Error("Falta o caso sintético de convite no fixture da main.");
    const marca = caso.marca as MarcaDeSaida;
    const { html, text } = buildInviteEmail({ ...opcoes, marca, acceptUrl });
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Nosso layout com a marca (decisão da subida 1.95) põe aviso e botão antes do
    // link copiável: a cerca procura pelo conteúdo, não pela posição.
    // (o rodapé da marca também tem link, para a casa do app)
    expect([...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(acceptUrl);
    expect(doc.querySelector("img[onerror]")).toBeNull();
    expect([...doc.querySelectorAll("body *")].some((el) => el.textContent === acceptUrl)).toBe(true);
    expect(text).toContain(acceptUrl);
    expect(html).toContain("&amp;b=&quot;&gt;&lt;img");
  });
});
