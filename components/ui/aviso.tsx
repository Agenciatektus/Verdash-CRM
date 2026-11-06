import type { ReactNode } from "react";

import { CheckCircle, Info, Warning, WarningCircle, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O AVISO DA PÁGINA (DS v2): uma faixa com tom de estado, ícone, texto e, se
 * houver, uma ação e o "Dispensar". Substitui o `⚠` escrito no texto e as cores
 * cruas (`amber-*`, `red-*`) que cada tela montava à mão.
 *
 * O tom vem dos tokens de estado do `globals.css` (`info`, `warning`, `error`,
 * `success`); a cor nunca é a única pista: o ícone muda junto e o `role` também
 * (`alert` só para crit, que interrompe o leitor de tela; o resto é `status`).
 */
export type TomDoAviso = "info" | "warn" | "crit" | "ok";

const TOM: Record<TomDoAviso, { classe: string; Icone: typeof Info }> = {
  info: { classe: "bg-info-bg text-info-fg", Icone: Info },
  warn: { classe: "bg-warning-bg text-warning-fg", Icone: Warning },
  crit: { classe: "bg-error-bg text-error-fg", Icone: WarningCircle },
  ok: { classe: "bg-success-bg text-success-fg", Icone: CheckCircle },
};

export function Aviso({
  tom = "info",
  titulo,
  children,
  acao,
  onDispensar,
  rotuloDispensar = "Dispensar",
  className,
}: {
  tom?: TomDoAviso;
  titulo?: ReactNode;
  children?: ReactNode;
  /** Um botão (ou link) que resolve o aviso. */
  acao?: ReactNode;
  /** Presente = mostra o "×". Quem chama guarda o estado de dispensado. */
  onDispensar?: () => void;
  rotuloDispensar?: string;
  className?: string;
}) {
  const { classe, Icone } = TOM[tom];
  return (
    <div
      role={tom === "crit" ? "alert" : "status"}
      data-tom={tom}
      className={cn("flex items-start gap-3 rounded-xl px-3.5 py-2.5 text-sm", classe, className)}
    >
      <Icone size={18} aria-hidden className="mt-px shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        {titulo ? <p className="font-semibold">{titulo}</p> : null}
        {children ? <div className={cn(titulo && "mt-0.5", "text-muted-foreground")}>{children}</div> : null}
      </div>
      {acao ? <div className="flex shrink-0 items-center gap-2 self-center">{acao}</div> : null}
      {onDispensar ? (
        <button
          type="button"
          onClick={onDispensar}
          aria-label={rotuloDispensar}
          className="-m-1 shrink-0 self-center rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          <X size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
