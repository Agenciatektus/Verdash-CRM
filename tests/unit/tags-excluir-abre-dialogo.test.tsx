/**
 * "EXCLUIR NÃO FUNCIONA" NA TELA DE TAGS (20/10/2026) — o clique precisa abrir a
 * confirmação ONDE o operador está.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O botão Excluir de cada linha só trocava o estado de um cartão que mora
 * DEPOIS da tabela inteira. Numa organização com dezenas de etiquetas, clicar
 * em Excluir numa linha do alto (`ddd-11` estava entre as primeiras) abria o
 * cartão lá embaixo, fora da tela. Nada mudava à vista e o pedido nunca saía:
 * o log de auditoria da organização tinha a cor de outra etiqueta e NENHUM
 * excluir. A função de banco não tinha culpa (ela tira a etiqueta de contatos,
 * leads e conversas mesmo quando a etiqueta está "fora do vocabulário").
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * Que o Excluir abre um `alertdialog` modal com os números de quem perde a
 * etiqueta, e que confirmar ali manda o `excluir` certo. CONTROLE NEGATIVO
 * feito ao escrever: com o `_painel.tsx` de antes do conserto, o primeiro caso
 * reprova (não há `alertdialog` nenhum; a confirmação era um `<p>` no fim da
 * página).
 *
 *     npx vitest run tests/unit/tags-excluir-abre-dialogo.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { escolherNaLinha } from "./helpers/menu-da-linha-de-tags";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PainelDeTags } from "@/app/app/settings/tags/_painel";

/** A linha do relato: em uso, fora do vocabulário, só em contatos. */
const FORA: LinhaDeVocabulario = {
  tag: "ddd-11",
  uso_em_contatos: 332,
  uso_em_leads: 0,
  uso_em_conversas: 0,
  em_regras: 0,
  cor: null,
  descricao: null,
  no_vocabulario: false,
};
const VIP: LinhaDeVocabulario = { ...FORA, tag: "vip", uso_em_contatos: 3, uso_em_leads: 2, uso_em_conversas: 1, em_regras: 2, no_vocabulario: true };

function montar(tags: LinhaDeVocabulario[] = [FORA, VIP]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PainelDeTags tags={tags} idioma="pt-BR" />
    </QueryClientProvider>,
  );
}

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: { contatos: 332, leads: 0, conversas: 0, regras: 0 } }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Excluir na tela de Tags", () => {
  it("⭐ abre um diálogo modal com quantos registros perdem a etiqueta", async () => {
    montar();
    await escolherNaLinha(0, "Excluir");

    const dialogo = screen.getByRole("alertdialog");
    expect(within(dialogo).getByText("Excluir etiqueta?")).toBeTruthy();
    expect(dialogo.textContent).toContain("Excluir ddd-11 de 332 contato(s), 0 lead(s) e 0 conversa(s).");
    expect(dialogo.textContent).toContain("332 registro(s) perdem a etiqueta");
    // Etiqueta sem regra de agente: o aviso de regra não aparece.
    expect(dialogo.textContent).not.toContain("regra(s) de agente");
  });

  it("⭐ confirmar no diálogo manda `excluir` da etiqueta FORA do vocabulário e avisa quantos saíram", async () => {
    montar();
    await escolherNaLinha(0, "Excluir");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Etiqueta removida de 332 registro(s)."));
    const [url, init] = fetchMock().mock.calls.at(-1) as [string, { body: string }];
    expect(url).toBe("/api/v1/tags/vocabulario");
    expect(JSON.parse(init.body)).toEqual({ acao: "excluir", tag: "ddd-11", destino: null });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("o aviso das regras de agente continua no diálogo", async () => {
    montar();
    await escolherNaLinha(1, "Excluir");
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Atenção: 2 regra(s) de agente continuam escrevendo esta etiqueta.",
    );
  });

  it("Cancelar fecha sem chamar o servidor", async () => {
    montar();
    await escolherNaLinha(0, "Excluir");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("recusa do servidor fecha o diálogo e diz o que fazer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "mfa_required" } }), { status: 403 })),
    );
    montar();
    await escolherNaLinha(0, "Excluir");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Confirme o segundo fator para mudar as etiquetas."),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
