// A EVOLUÇÃO DOS GANHOS NO DESEMPENHO SAI EM GRÁFICO E TABELA, NO MESMO CARD (#3024).
//
// A tela `/app/metrics` só tinha número e tabela. Esta fatia entrega a TENDÊNCIA:
// quantidade de ganhos por balde (dia/semana/mês) num gráfico de linha, com a
// tabela dos baldes logo abaixo — e sem mexer em nenhum número que já existia.
//
// O que este caso protege, e é o que a fatia promete:
//
//  - o gráfico E a tabela vivem no mesmo `Card` (não são dois blocos soltos);
//  - balde sem ganho aparece com zero, com a mesma contagem que a série traz;
//  - nenhuma frase nova escapa de `t()`.
//
// Remover o gráfico, ou tirar a tabela de dentro do `Card`, deixa vermelho.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SerieTemporal } from "@/hooks/metrics/useSerieTemporal";

// O idioma é trocável por caso: os casos do cartão no celular conferem que o
// rótulo de cada célula sai de `t()` também em espanhol.
const idioma = "pt-BR" as "pt-BR" | "es";
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (s: string) => (idioma === "es" ? traduzir(s, "es") : s) };
});
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

let serie: SerieTemporal;
vi.mock("@/hooks/metrics/useSerieTemporal", () => ({
  useSerieTemporal: () => ({ data: { data: serie }, isLoading: false, isError: false }),
}));

import { MetricsClient } from "@/app/app/metrics/_components/MetricsClient";
import { SeriePanel } from "@/app/app/metrics/_components/SeriePanel";
import { apiClient } from "@/lib/api/client";

function serieDeExemplo(): SerieTemporal {
  return {
    window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
    granularidade: "dia",
    baldes: [
      { balde: "2026-10-01", ganhos: 2 },
      { balde: "2026-10-02", ganhos: 0 },
      { balde: "2026-10-03", ganhos: 1 },
    ],
    total: 3,
    truncado: false,
  };
}

describe("a evolução dos ganhos no Desempenho", () => {
  it("a tabela conta exatamente o que a série traz, sem recalcular", () => {
    serie = serieDeExemplo();
    render(<SeriePanel />);

    const linhas = Array.from(document.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
    );
    expect(linhas).toEqual([
      ["01/10", "2"],
      ["02/10", "0"],
      ["03/10", "1"],
    ]);
  });

  it("série cortada no teto de leitura avisa, e a inteira não", () => {
    serie = serieDeExemplo();
    const { unmount } = render(<SeriePanel />);
    expect(screen.queryByText("Série cortada no teto de leitura.")).toBeNull();
    unmount();

    serie = { ...serieDeExemplo(), truncado: true };
    render(<SeriePanel />);
    expect(screen.getByText("Série cortada no teto de leitura.")).toBeTruthy();
  });
});

// ─── O RANKING E "POR CANAL" VIRAM CARTÃO NO CELULAR (ADR-0006, F4) ──────────
//
// Abaixo de `md` o cabeçalho da tabela some (`max-md:hidden`) e cada linha vira
// um cartão. O nome da coluna passa a viajar na própria célula, pelo
// `data-rotulo`, que o CSS desenha antes do número. O jsdom não aplica media
// query, então o que se prende aqui é o CONTRATO: cada célula numérica carrega o
// mesmo texto do cabeçalho da sua coluna, traduzido — sem isso o cartão do
// celular mostraria "3 1 7" sem dizer o que é cada número.

function responderPainel() {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/metrics/attendants")) {
      return {
        data: {
          window: { from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" },
          owner_user_id: null,
          excluded_tag: null,
          excluded_conversations: 0,
          funnel: [],
          attendants: [
            {
              user_id: "u-ana",
              won: 3,
              lost: 1,
              conversations_handled: 7,
              avg_first_response_seconds: 90,
              median_first_response_seconds: 60,
              name: "Ana Ranking",
              email: null,
            },
          ],
        },
      };
    }
    if (url.startsWith("/api/v1/metrics/channels")) {
      return {
        data: {
          window: { from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" },
          owner_user_id: null,
          channels: [
            {
              channel_session_id: "canal-loja",
              channel_name: "Loja Centro",
              channel: "whatsapp",
              is_archived: false,
              conversations_handled: 5,
              avg_first_response_seconds: 30,
              sem_resposta: 2,
            },
          ],
        },
      };
    }
    throw new Error(`sem resposta de teste para ${url}`);
  });
}

