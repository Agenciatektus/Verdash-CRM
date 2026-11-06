import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * O MOLDE CHEIO (DS v2, board "Moldes de largura"): a página ocupa a altura útil
 * e a largura toda, e quem rola é a peça de dentro (uma grade, uma lista), não a
 * página. Some a rolagem dentro da rolagem. Para telas de trabalho (Agenda); o
 * `Pagina` segue para as de lista e formulário.
 *
 * Quem usa põe `min-h-0 flex-1` na peça que rola. Celular (`mb:`): encosta nas
 * bordas, como o `Pagina`.
 */
export function PaginaCheia({
  children,
  className,
  testId,
  ...dados
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      data-testid={testId}
      data-largura="cheia"
      {...dados}
      className={cn(
        "flex h-full min-h-0 w-full flex-col gap-4 p-6 mb:-mx-6 mb:-mt-6 mb:w-auto mb:gap-3 mb:p-0 mb:px-4 mb:pt-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
