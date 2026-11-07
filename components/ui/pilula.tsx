import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

/**
 * A pílula de ESTADO do quadro DS (`.pill`): quadrada, raio 6, 22px. É o
 * `Badge` com a API do quadro (tons neutro/info/ok/warn/crit, os mesmos do
 * `Aviso`), para as telas novas não escolherem entre `success` e `ok`.
 */
export type TomDaPilula = "neutro" | "info" | "ok" | "warn" | "crit";

const VARIANTE = {
  neutro: "neutral",
  info: "info",
  ok: "success",
  warn: "warning",
  crit: "error",
} as const;

export function Pilula({
  tom = "neutro",
  children,
  className,
}: {
  tom?: TomDaPilula;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge variant={VARIANTE[tom]} data-tom={tom} className={className}>
      {children}
    </Badge>
  );
}
