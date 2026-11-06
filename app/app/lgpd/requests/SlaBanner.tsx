"use client";
import { Aviso } from "@/components/ui/aviso";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { LgpdRequest } from "@/hooks/useLgpdRequests";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

interface SlaBannerProps {
  requests: LgpdRequest[];
  /** Presente = oferece "Ver só as urgentes". Ausente quando o filtro já está ligado. */
  onVerUrgentes?: () => void;
}

export function SlaBanner({ requests, onVerUrgentes }: SlaBannerProps) {
  const t = useT();
  const active = requests.filter((r) => !TERMINAL_STATUSES.has(r.status));

  const critical = active.filter(
    (r) => r.sla_bucket === "overdue" || r.sla_bucket === "critical",
  );
  const warning = active.filter((r) => r.sla_bucket === "warning");

  if (critical.length > 0) {
    return (
      <Aviso
        tom="crit"
        titulo={`${critical.length} ${t(critical.length === 1 ? "solicitação crítica" : "solicitações críticas")}`}
        acao={
          onVerUrgentes ? (
            <Button size="sm" variant="outline" onClick={onVerUrgentes}>
              {t("Ver só as urgentes")}
            </Button>
          ) : undefined
        }
      >
        {t("SLA vencido ou inferior a 2 dias. Ação imediata requerida.")}
      </Aviso>
    );
  }

  if (warning.length > 0) {
    return (
      <Aviso
        tom="warn"
        titulo={`${warning.length} ${t(warning.length === 1 ? "solicitação em alerta" : "solicitações em alerta")}`}
      >
        {t("mais de 50% do prazo consumido.")}
      </Aviso>
    );
  }

  return null;
}
