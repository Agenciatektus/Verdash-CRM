import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * O MOLDE DE PÁGINA do design system (quadro Inbox v2 + protótipo mobile), para as
 * telas de lista e de ficha fora da Inbox, do Funil e das Tarefas (que têm tela
 * própria no celular).
 *
 * Desktop: a largura toda da área de conteúdo, com o MESMO respiro do skeleton de
 * carregamento (`app/app/loading.tsx`: `p-6` somado ao `p-6` do `main` da AppShell),
 * então o conteúdo começa e termina onde o skeleton começa e termina; limite de
 * legibilidade (um formulário, um texto) fica DENTRO da página, nunca nela. Celular (`mb:`):
 * a página encosta nas bordas (desconta o `p-6` do `main`) e cada peça põe o próprio
 * respiro de 16px, como as telas do protótipo; o topo com voltar é da casca
 * (`BarraDeTela`), e por isso o título da página some no celular.
 *
 * Só CSS decide desktop x celular: nada lê o navegador no primeiro render.
 *
 * `largura="leitura"` é o molde de AJUSTES e FORMULÁRIOS: cada filho para em
 * 768px, alinhado à esquerda com o título (DS v2, board "Moldes de largura").
 * Substitui o `max-w-2xl`/`max-w-3xl` que cada tela punha num filho diferente.
 * Abaixo de 768px nada muda: a coluna já é a largura toda.
 */
export function Pagina({
  children,
  className,
  testId,
  largura = "total",
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  largura?: "total" | "leitura";
}) {
  return (
    <div
      data-testid={testId}
      data-largura={largura}
      className={cn(
        "flex w-full flex-col gap-5 p-6 mb:-mx-6 mb:-mt-6 mb:w-auto mb:gap-3 mb:p-0",
        largura === "leitura" && "*:w-full *:max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * O cabeçalho da página: título (`text-title-lg`), descrição e ações. No celular o
 * título fica só para leitor de tela (a barra da casca já diz onde se está), a não
 * ser numa ficha (`tituloNoCelular`), em que o título é o nome do registro. A
 * descrição continua visível: ela carrega avisos ("Nada é enviado antes de..."). As ações viram
 * uma faixa rolável; a ação principal da tela vai para o `BotaoDaTela` (o "+" do
 * protótipo), e quem a declara aqui marca o botão com `mb:hidden`.
 */
export function CabecalhoDaPagina({
  titulo,
  descricao,
  acoes,
  antes,
  tituloNoCelular = false,
  acoesSoNoDesktop = false,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  /** O que vem acima do título (o "voltar" de uma ficha no desktop, por exemplo). */
  antes?: ReactNode;
  tituloNoCelular?: boolean;
  /**
   * As ações só existem no desktop (a do celular é o `BotaoDaTela`): a faixa some
   * inteira abaixo de 760px, em vez de ficar vazia com o botão `mb:hidden` dentro.
   */
  acoesSoNoDesktop?: boolean;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb:px-4 mb:pt-3">
      <div className={cn("min-w-0", !tituloNoCelular && !descricao && "mb:sr-only")}>
        {antes ? <div className={cn(!tituloNoCelular && "mb:hidden")}>{antes}</div> : null}
        <h1 className={cn("break-words text-title-lg", !tituloNoCelular && "mb:sr-only")}>{titulo}</h1>
        {descricao ? <p className="mt-1 text-sm text-muted-foreground">{descricao}</p> : null}
      </div>
      {acoes ? (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 mb:-mx-4 mb:flex-nowrap mb:overflow-x-auto mb:px-4 mb:empty:hidden",
            acoesSoNoDesktop && "mb:hidden",
          )}
        >
          {acoes}
        </div>
      ) : null}
    </header>
  );
}

/** Um bloco da página com o respiro do celular (16px dos lados). */
export function SecaoDaPagina({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("flex flex-col gap-3 mb:px-4", className)}>{children}</section>;
}
