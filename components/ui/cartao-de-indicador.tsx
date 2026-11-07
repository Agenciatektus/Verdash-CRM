import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * O cartão de indicador do quadro DS (`.kpi`): rótulo, número em Mono, a
 * explicação curta embaixo e, se houver, um slot (barra de progresso, pílula).
 * `valor` é ReactNode para a tela poder passar um esqueleto ou uma unidade.
 */
export function CartaoDeIndicador({
  rotulo,
  valor,
  explicacao,
  children,
  className,
}: {
  rotulo: ReactNode;
  valor: ReactNode;
  explicacao?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col gap-1 px-4 py-3.5", className)}>
      <p className="text-xs text-text-muted">{rotulo}</p>
      <p className="font-mono text-2xl font-semibold tracking-tight tabular-nums text-text">{valor}</p>
      {explicacao ? <p className="text-xs text-text-subtle">{explicacao}</p> : null}
      {children}
    </Card>
  );
}
