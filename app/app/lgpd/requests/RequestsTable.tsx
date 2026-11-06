"use client";
import { TABELA_EMPILHADA } from "@/components/pagina";
import { useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ShieldCheck, Warning } from "@/lib/ui/icons";
import {
  useLgpdRequests,
  type LgpdRequestStatus,
  type LgpdRequestType,
  type SlaBucket,
} from "@/hooks/useLgpdRequests";
import { PrazoDoPedido, type TomDoPrazo } from "./PrazoDoPedido";
import { SlaBanner } from "./SlaBanner";

// ── Label helpers ─────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  redact: "Anonimização cliente",
  data_request: "Solicitação dados",
  store_redact: "Anonimização tenant",
};

const STATUS_LABELS: Record<LgpdRequestStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  pending_review: "Revisão pendente",
};

const STATUS_VARIANT: Record<
  LgpdRequestStatus,
  "neutral" | "info" | "success" | "warning" | "error"
> = {
  received: "neutral",
  processing: "info",
  completed: "success",
  failed: "error",
  pending_review: "warning",
};

// O balde que a API calcula pinta a barra do prazo.
const TOM_DO_BUCKET: Record<SlaBucket, TomDoPrazo> = {
  overdue: "crit",
  critical: "crit",
  warning: "warn",
  ok: "ok",
};

// Chips de SLA. "urgent" junta vencido e crítico, em aberto; a API filtra no banco.
type FiltroDeSla = SlaBucket | "urgent";
const CHIPS_DE_SLA: { valor: FiltroDeSla; rotulo: string }[] = [
  { valor: "urgent", rotulo: "Urgentes" },
  { valor: "warning", rotulo: "Em alerta" },
  { valor: "ok", rotulo: "No prazo" },
];
const STATUS_DOS_CHIPS: LgpdRequestStatus[] = [
  "received",
  "processing",
  "pending_review",
  "completed",
  "failed",
];

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtRelative(iso: string, t: (texto: string) => string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return t("agora");
    if (diffMin < 60) return `${diffMin}${t("min atrás")}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}${t("h atrás")}`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}${t("d atrás")}`;
  } catch {
    return iso;
  }
}

// O texto e a barra da coluna "Prazo" vêm de `PrazoDoPedido`, que lê a conta de
// `lib/lgpd/sla.ts` (a mesma do detalhe e do e-mail ao DPO). Aqui ficava
// `fmtDistance`, que media até o INÍCIO do dia do prazo e dizia "atrasado hoje"
// com o prazo ainda por vencer.

const ALL = "__ALL__";

/** A contagem vem do `meta.total` (consulta só de count, sem linhas): total da organização. */
function ChipComContagem({
  status,
  ligado,
  rotulo,
  onClick,
}: {
  status?: LgpdRequestStatus;
  ligado: boolean;
  rotulo: string;
  onClick: () => void;
}) {
  const total = useLgpdRequests({ status, onlyCount: true }).data?.meta.total;
  return (
    <Chip ligado={ligado} onClick={onClick}>
      {rotulo}
      {total !== undefined && <span className="tabular-nums opacity-80">{total}</span>}
    </Chip>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RequestsTable({
  baseDoPedido = "/app/lgpd/requests/",
}: {
  /**
   * Prefixo do "Ver". O hub de `/account-suspended` passa o próprio endereço:
   * o detalhe em `/app/lgpd/requests/[id]` mora sob o layout de `/app`, que
   * devolve a empresa suspensa ao hub. String e não função, porque o hub é
   * Server Component e função não atravessa para o cliente.
   */
  baseDoPedido?: string;
} = {}) {
  const t = useT();
  const [status, setStatus] = useState<LgpdRequestStatus | undefined>();
  const [type, setType] = useState<LgpdRequestType | undefined>();
  const [slaFiltro, setSlaFiltro] = useState<FiltroDeSla | undefined>();
  const [page, setPage] = useState(1);

  const q = useLgpdRequests({
    status,
    type,
    sla_bucket: slaFiltro,
    page,
    limit: 25,
  });
  const rows = q.data?.data ?? [];
  const filtrado = Boolean(status || type || slaFiltro);
  const meta = q.data?.meta;

  return (
    <div className="flex flex-col gap-4">
      {/* SLA Banner — shown based on full current page data */}
      {!q.isLoading && rows.length > 0 && (
        <SlaBanner
          requests={rows}
          onVerUrgentes={
            slaFiltro === "urgent"
              ? undefined
              : () => {
                  setSlaFiltro("urgent");
                  setPage(1);
                }
          }
        />
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <ChipComContagem
          ligado={!status && !slaFiltro}
          rotulo={t("Todas")}
          onClick={() => {
            setStatus(undefined);
            setSlaFiltro(undefined);
            setPage(1);
          }}
        />
        {CHIPS_DE_SLA.map((c) => (
          <Chip
            key={c.valor}
            ligado={slaFiltro === c.valor}
            onClick={() => {
              setSlaFiltro(slaFiltro === c.valor ? undefined : c.valor);
              setPage(1);
            }}
          >
            {t(c.rotulo)}
          </Chip>
        ))}
        {STATUS_DOS_CHIPS.map((st) => (
          <ChipComContagem
            key={st}
            status={st}
            ligado={status === st}
            rotulo={t(STATUS_LABELS[st])}
            onClick={() => {
              setStatus(status === st ? undefined : st);
              setPage(1);
            }}
          />
        ))}
        <Select
          value={type ?? ALL}
          onValueChange={(v) => {
            setType(v === ALL ? undefined : (v as LgpdRequestType));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-48" aria-label={t("Tipo")}>
            <SelectValue placeholder={t("Tipo: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Tipo: todos")}</SelectItem>
            <SelectItem value="redact">{t(TYPE_LABELS.redact)}</SelectItem>
            <SelectItem value="data_request">{t(TYPE_LABELS.data_request)}</SelectItem>
            <SelectItem value="store_redact">{t(TYPE_LABELS.store_redact)}</SelectItem>
          </SelectContent>
        </Select>

        {(status || type || slaFiltro) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(undefined);
              setType(undefined);
              setSlaFiltro(undefined);
              setPage(1);
            }}
          >
            {t("Limpar filtros")}
          </Button>
        )}

        {meta && (
          <span className="text-xs text-muted-foreground largo:ml-auto">
            {meta.total} {t(meta.total === 1 ? "solicitação" : "solicitações")}
          </span>
        )}
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table className={TABELA_EMPILHADA}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">ID</TableHead>
              <TableHead>{t("Tipo")}</TableHead>
              <TableHead>{t("Sujeito")}</TableHead>
              <TableHead>{t("Recebido")}</TableHead>
              <TableHead>{t("Prazo")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : q.isError ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Warning size={24} weight="fill" className="text-error-fg" aria-hidden />
                    <p>{t("Erro ao carregar solicitações.")}</p>
                    <Button size="sm" variant="outline" onClick={() => q.refetch()}>
                      {t("Tentar novamente")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  {filtrado ? (
                    <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                      <p className="font-medium">{t("Nenhuma solicitação neste filtro")}</p>
                      {meta?.has_more && <p className="text-xs">{t("Há mais resultados na próxima página.")}</p>}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                      <ShieldCheck size={32} weight="thin" aria-hidden />
                      <p className="font-medium">{t("Nenhuma solicitação LGPD")}</p>
                      <p className="text-xs">
                        {t("Solicitações de dados e anonimizações aparecerão aqui.")}
                      </p>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const terminal = r.status === "completed" || r.status === "failed";
                const subject = r.external_customer_id
                  ? r.external_customer_id.slice(0, 16)
                  : r.contact_id
                    ? `ctt:${r.contact_id.slice(0, 8)}`
                    : "—";

                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="tag" className="text-xs">
                        {t(TYPE_LABELS[r.request_type] ?? r.request_type)}
                      </Badge>
                    </TableCell>
                    <TableCell data-rotulo={t("Sujeito")} className="max-w-36 truncate font-mono text-xs">
                      {subject}
                    </TableCell>
                    <TableCell data-rotulo={t("Recebido")} className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtRelative(r.received_at, t)}
                    </TableCell>
                    <TableCell data-rotulo={t("Prazo")} className="mb:basis-full">
                      {terminal ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <PrazoDoPedido
                          receivedAt={r.received_at}
                          dueAt={r.due_at}
                          tom={TOM_DO_BUCKET[r.sla_bucket]}
                        />
                      )}
                    </TableCell>
                    <TableCell data-rotulo={t("Status")}>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {t(STATUS_LABELS[r.status] ?? r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <Link href={`${baseDoPedido}${r.id}`}>{t("Ver")}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Pagination */}
      {meta && (meta.page > 1 || meta.has_more) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || q.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("Anterior")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Página")} {meta.page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!meta.has_more || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("Próxima")}
          </Button>
        </div>
      )}
    </div>
  );
}
