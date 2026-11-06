import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  cabecalhoServerTiming,
  diagnosticoDoQuadro,
  enriquecerEmParalelo,
  LIMIAR_DO_LOG_DO_QUADRO_MS,
  fundirEnriquecimentos,
} from "@/lib/kanban/fundir-enriquecimentos";
import type { Lead } from "@/lib/types/leads";

/**
 * O quadro do Funil estourava os 10 s do cliente ("A requisição não respondeu
 * em 10000ms") com o banco tranquilo: sete famílias de enriquecimento em série.
 * Agora rodam em paralelo e a fusão confere o `id` (sem a guarda, o card do
 * lead A pode receber a conversa do lead B).
 */

type LeadFalso = { id: string; contact_id: string | null; position_in_stage: number; [k: string]: unknown };

function base(n: number): LeadFalso[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `lead-${i}`,
    contact_id: `contato-${i}`,
    position_in_stage: i,
  }));
}

/** Imita cada `with*`: `base.map(...)` acrescentando um campo. */
function enriquece(
  leads: LeadFalso[],
  campo: string,
  valor: (l: LeadFalso) => unknown,
  aplicaEm: (l: LeadFalso) => boolean = () => true,
): LeadFalso[] {
  return leads.map((l) => (aplicaEm(l) ? { ...l, [campo]: valor(l) } : l));
}

const comoLeads = (x: LeadFalso[]) => x as unknown as Lead[];

/** A fusão SEM a guarda — o controle negativo: é o que a guarda impede. */
function fusaoIngenua(b: Lead[], enriquecidos: Lead[][]): Lead[] {
  return b.map((l, i) => enriquecidos.reduce<Lead>((acc, v) => ({ ...acc, ...v[i] }), l));
}

describe("fusão por id", () => {
  it("dá o mesmo resultado que a cadeia em série", () => {
    const quadro = base(50);
    const cadeia = enriquece(
      enriquece(enriquece(quadro, "next_action", (l) => `acao-${l.id}`), "score", (l) => ({
        p: l.position_in_stage,
      })),
      "conversa",
      (l) => ({ ultima: `msg-${l.id}` }),
    );
    const fundido = fundirEnriquecimentos(comoLeads(quadro), [
      comoLeads(enriquece(quadro, "next_action", (l) => `acao-${l.id}`)),
      comoLeads(enriquece(quadro, "score", (l) => ({ p: l.position_in_stage }))),
      comoLeads(enriquece(quadro, "conversa", (l) => ({ ultima: `msg-${l.id}` }))),
    ]);
    expect(fundido).toEqual(cadeia);
  });

  it("família que só toca alguns leads não apaga o que a irmã pôs", () => {
    const quadro = base(6);
    const par = (l: LeadFalso) => l.position_in_stage % 2 === 0;
    const fundido = fundirEnriquecimentos(comoLeads(quadro), [
      comoLeads(enriquece(quadro, "score", () => 1, par)),
      comoLeads(enriquece(quadro, "conversa", () => "oi", (l) => !par(l))),
    ]) as unknown as LeadFalso[];
    expect(fundido[0]).toMatchObject({ score: 1, contact_id: "contato-0" });
    expect(fundido[0]!.conversa).toBeUndefined();
    expect(fundido[1]).toMatchObject({ conversa: "oi", contact_id: "contato-1" });
    expect(fundido[1]!.score).toBeUndefined();
  });

  it("CONTROLE: família fora de ordem PARA ALTO; sem a guarda, o card de A leva a conversa de B", () => {
    const quadro = base(10);
    const trocado = enriquece(quadro, "conversa", (l) => `conversa-de-${l.id}`);
    [trocado[7], trocado[8]] = [trocado[8]!, trocado[7]!];

    // Controle negativo: a fusão sem guarda NÃO reclama e entrega o dado do vizinho.
    const semGuarda = fusaoIngenua(comoLeads(quadro), [comoLeads(trocado)]) as unknown as LeadFalso[];
    expect(semGuarda[7]!.conversa).toBe("conversa-de-lead-8");

    // Com a guarda, para alto na posição exata.
    expect(() => fundirEnriquecimentos(comoLeads(quadro), [comoLeads(trocado)])).toThrow(/posição 7/);
  });

  it("CONTROLE: família que filtrou um lead (tamanho diferente) para alto", () => {
    const quadro = base(4);
    const menor = enriquece(quadro, "score", () => 1).slice(1);
    expect(() => fundirEnriquecimentos(comoLeads(quadro), [comoLeads(menor)])).toThrow(/tamanho/);
  });

  it("quadro vazio não quebra", () => {
    expect(fundirEnriquecimentos([], [[], []])).toEqual([]);
  });
});

describe("as famílias rodam em paralelo", () => {
  const espera = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  it("com atrasos simulados, o total ≈ a maior família, não a soma", async () => {
    const inicio = performance.now();
    const { resultados, tempos } = await enriquecerEmParalelo({
      a: () => espera(150, "A"),
      b: () => espera(150, "B"),
      c: () => espera(150, "C"),
      d: () => espera(150, "D"),
    });
    const total = performance.now() - inicio;

    expect(resultados).toEqual({ a: "A", b: "B", c: "C", d: "D" });
    // Em série seriam ≥ 600 ms.
    expect(total).toBeLessThan(400);
    for (const nome of ["a", "b", "c", "d"]) expect(tempos[nome]).toBeGreaterThanOrEqual(140);
  });

  it("erro de uma família sobe, como antes (vira 500 no handler)", async () => {
    await expect(
      enriquecerEmParalelo({ ok: () => espera(5, 1), quebra: () => Promise.reject(new Error("x")) }),
    ).rejects.toThrow("x");
  });

  it("Server-Timing só com nomes e números", () => {
    expect(cabecalhoServerTiming({ score: 12.3, total: 40 })).toBe("score;dur=12.3, total;dur=40");
  });
});

describe("diagnóstico do quadro: log só na abertura lenta, Server-Timing só para o staff", () => {
  const rapido = { score: 40, total: 300 };
  const lento = { score: 2_400, total: LIMIAR_DO_LOG_DO_QUADRO_MS + 1 };

  it("abertura normal não vai para o log; a lenta vai", () => {
    expect(diagnosticoDoQuadro(rapido, false).logar).toBe(false);
    // Controle negativo: o mesmo cálculo, acima do limiar, loga.
    expect(diagnosticoDoQuadro(lento, false).logar).toBe(true);
    // Exatamente no limiar não loga (é "passar de").
    expect(diagnosticoDoQuadro({ total: LIMIAR_DO_LOG_DO_QUADRO_MS }, false).logar).toBe(false);
  });

  it("cliente comum não recebe Server-Timing; staff da plataforma recebe", () => {
    expect(diagnosticoDoQuadro(lento, false).headers).toBeUndefined();
    expect(diagnosticoDoQuadro(rapido, true).headers).toEqual({ "Server-Timing": "score;dur=40, total;dur=300" });
  });

  it("a rota usa o diagnóstico: o header e o log não saem por fora dele", () => {
    const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");
    expect(fonte).toMatch(/diagnosticoDoQuadro\(tempos, authUser\?\.is_platform_admin === true\)/);
    expect(fonte).toMatch(/if \(diagnostico\.logar\)/);
    expect(fonte).not.toMatch(/"Server-Timing"/);
  });
});

describe("a rota não pode voltar a encadear as famílias", () => {
  // Cerca sobre a fonte: a cadeia de volta não erra o resultado, só fica lenta,
  // então nenhuma asserção de saída pegaria a regressão.
  const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");
  const inicio = fonte.indexOf("enriquecerEmParalelo({");
  const fim = fonte.indexOf("});", inicio);
  const bloco = fonte.slice(inicio, fim);

  it("a cerca enxerga o bloco paralelo (senão é cerca cega)", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(bloco.length).toBeGreaterThan(100);
  });

  const FAMILIAS = [
    "withOwnerAgents",
    "withNextActions",
    "withScores",
    "withProximosPassos",
    "withTarefas",
    "withConversas",
    "withMarcadoresDoContato",
  ];

  it.each(FAMILIAS)("%s roda dentro do bloco paralelo, sobre o quadro base", (familia) => {
    expect(bloco).toMatch(new RegExp(`${familia}\\(\\s*supabase,\\s*organizationId,\\s*leadsDoQuadro`));
  });

  it.each(FAMILIAS)("%s não é mais aguardada em série no GET", (familia) => {
    const get = fonte.slice(fonte.indexOf("export async function GET"));
    expect(get).not.toMatch(new RegExp(`=\\s*await\\s+${familia}\\(`));
  });

  it("a resposta sai da fusão por id e carrega o Server-Timing", () => {
    expect(fonte).toMatch(/leads:\s*leadsEnriquecidos/);
    expect(fonte).toMatch(/const leadsEnriquecidos = fundirEnriquecimentos\(leadsDoQuadro,/);
    expect(fonte).toMatch(/return ok\(board, \{ requestId, headers \}\)/);
  });
});
