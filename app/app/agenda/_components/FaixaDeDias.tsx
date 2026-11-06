"use client";

import { addDays, format, isSameDay, startOfWeek } from "date-fns";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A faixa de dias do CELULAR: a semana da âncora em fichas de um toque, com um
 * ponto nos dias que têm compromisso. Só abaixo de 760px (`largo:hidden`).
 */
export function FaixaDeDias({
  ancora,
  comCompromisso,
  onEscolher,
}: {
  ancora: Date;
  /** `yyyy-MM-dd` dos dias com compromisso, no fuso da organização. */
  comCompromisso: ReadonlySet<string>;
  onEscolher: (dia: Date) => void;
}) {
  const localeDaData = useLocaleDeData();
  const inicio = startOfWeek(ancora, { weekStartsOn: 0 });
  return (
    <div data-testid="faixa-de-dias" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 largo:hidden">
      {Array.from({ length: 7 }, (_, i) => addDays(inicio, i)).map((d) => {
        const ativo = isSameDay(d, ancora);
        return (
          <Button
            key={d.toISOString()}
            variant={ativo ? "primary" : "outline"}
            aria-pressed={ativo}
            onClick={() => onEscolher(d)}
            className="h-14 w-12 shrink-0 flex-col gap-0 px-0"
          >
            <span className="text-[11px] font-medium capitalize">
              {format(d, "EEE", { locale: localeDaData }).replace(".", "")}
            </span>
            <span className="text-base tabular-nums">{format(d, "d")}</span>
            <span
              aria-hidden
              className={cn(
                "mt-0.5 size-1 rounded-full",
                comCompromisso.has(format(d, "yyyy-MM-dd")) ? "bg-current" : "bg-transparent",
              )}
            />
          </Button>
        );
      })}
    </div>
  );
}
