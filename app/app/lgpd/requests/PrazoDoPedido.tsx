"use client";

import { useT } from "@/hooks/i18n/useT";
import { diasAtePrazo, diasDeAtraso, progressoDoPrazo } from "@/lib/lgpd/sla";
import { cn } from "@/lib/utils";

export type TomDoPrazo = "ok" | "warn" | "crit";

const BARRA: Record<TomDoPrazo, string> = { ok: "bg-success", warn: "bg-warning", crit: "bg-error" };
const TEXTO: Record<TomDoPrazo, string> = {
  ok: "text-muted-foreground",
  warn: "text-warning-fg",
  crit: "text-error-fg",
};

/** O tom pela régua do SlaTimeline de sempre: atrasado = crit, 75% do prazo = warn. */
export function tomDoPrazo(receivedAt: string, dueAt: string | null, agora = new Date()): TomDoPrazo {
  if (diasDeAtraso(dueAt, agora) > 0) return "crit";
  return progressoDoPrazo(receivedAt, dueAt, agora) >= 0.75 ? "warn" : "ok";
}

/**
 * O PRAZO DO PEDIDO: barra com a fração do prazo já consumida e o texto abaixo
 * ("Vence hoje", "N dias", "N dias em atraso"). A conta é a de `lib/lgpd/sla`,
 * a mesma da linha do tempo do detalhe e do e-mail ao DPO.
 */
export function PrazoDoPedido({
  receivedAt,
  dueAt,
  tom,
  className,
}: {
  receivedAt: string;
  dueAt: string | null;
  /** Quem já tem o balde da API (a lista) passa o tom dele; sem ele, sai da conta. */
  tom?: TomDoPrazo;
  className?: string;
}) {
  const t = useT();
  if (!dueAt) return <span className="text-xs text-muted-foreground">—</span>;

  const agora = new Date();
  const tomFinal = tom ?? tomDoPrazo(receivedAt, dueAt, agora);
  const pct = Math.round(progressoDoPrazo(receivedAt, dueAt, agora) * 100);
  const atraso = diasDeAtraso(dueAt, agora);
  const dias = diasAtePrazo(dueAt, agora);
  const texto =
    atraso > 0
      ? `${atraso} ${t(atraso === 1 ? "dia em atraso" : "dias em atraso")}`
      : dias === 0
        ? t("Vence hoje")
        : `${dias} ${t(dias === 1 ? "dia" : "dias")}`;

  return (
    <div className={cn("flex min-w-32 flex-col gap-1.5", className)} data-tom={tomFinal}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", BARRA[tomFinal])}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("Prazo")}
        />
      </div>
      <span className={cn("text-xs", TEXTO[tomFinal])}>{texto}</span>
    </div>
  );
}
