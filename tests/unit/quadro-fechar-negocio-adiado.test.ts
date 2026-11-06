/**
 * Follow-up do Cassio na #180: soltar o card na coluna de GANHO ou de PERDA do quadro
 * fecha o negócio (`/move` emite `lead.won`/`lead.lost`, com efeito fora do CRM). O
 * arraste usa a mesma ação adiada (5 s com Desfazer) e a trava por negócio do painel.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const QUADRO = readFileSync("components/kanban/KanbanBoard.tsx", "utf8");

describe("arrastar para ganho ou perda no quadro", () => {
  it("adia com Desfazer e trava por negócio, nas duas colunas", () => {
    // Só ao ENTRAR na coluna fechada: reordenar dentro dela não fecha nada (subida 1.90).
    expect(QUADRO).toMatch(
      /if \(\(destino\?\.is_won \|\| destino\?\.is_lost\) && source\.droppableId !== destination\.droppableId\)/,
    );
    // `adiarFechamento` agenda com a chave do tipo e recusa com qualquer fechamento
    // (ganho, perda, troca) do mesmo negócio segurado (ver fechar-negocio-trava).
    expect(QUADRO).toMatch(/adiarFechamento\(\s*destino\.is_won \? "ganho" : "perda",\s*lead\.id,/);
  });

  it("etapa aberta continua movendo na hora (só o fechamento é adiado)", () => {
    const corpo = QUADRO.slice(QUADRO.indexOf("const handleDragEnd"), QUADRO.indexOf("if (isLoading)"));
    expect(corpo.trim().length).toBeGreaterThan(0);
    // Depois do ramo de ganho/perda, o resto chama `mover()` direto.
    expect(corpo).toMatch(/return;\n {6}\}\n {6}mover\(\);/);
  });
});
