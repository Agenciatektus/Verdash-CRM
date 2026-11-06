"use client";

import type { ReactNode } from "react";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { CabecalhoDaPagina, LinkDeVolta } from "@/components/pagina";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLgpdRequest } from "@/hooks/useLgpdRequest";
import { prazoEmBr } from "@/lib/lgpd/sla";
import { PrazoDoPedido } from "../PrazoDoPedido";
import { SlaTimeline } from "./SlaTimeline";
import { PreviewPanel } from "./PreviewPanel";
import { ApproveButton } from "./ApproveButton";
import { AuditTrail } from "./AuditTrail";
import type { LgpdRequestStatus, LgpdRequestType } from "@/hooks/useLgpdRequests";

interface Props {
  id: string;
  /** Volta para a lista. O hub de `/account-suspended` passa o próprio endereço (ver `RequestsTable`). */
  hrefDaLista?: string;
  /** Nível do título quando embutido sob outro (o hub de `/account-suspended` já tem h1 e h2). */
  titulo?: "h1" | "h2" | "h3";
}

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  redact: "Anonimização cliente",
  data_request: "Solicitação de dados",
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

export function LgpdRequestDetail({ id, hrefDaLista = "/app/lgpd/requests", titulo }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading, error } = useLgpdRequest(id);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5 mb:px-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-md border border-error-fg/30 bg-error-bg px-4 py-3 text-sm text-error-fg mb:mx-4">
        {t("Falha ao carregar solicitação.")}
      </div>
    );
  }

  const { request, audit_trail, signed_pdf_url, signed_json_url, titular } = data.data;

  const shortId = request.id.slice(0, 8);
  const typeLabel = t(TYPE_LABELS[request.request_type] ?? request.request_type);
  const statusLabel = t(STATUS_LABELS[request.status] ?? request.status);
  const terminal = request.status === "completed" || request.status === "failed";

  return (
    <>
      <CabecalhoDaPagina
        como={titulo}
        tituloNoCelular
        antes={<LinkDeVolta href={hrefDaLista}>{t("Solicitações")}</LinkDeVolta>}
        titulo={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-words">
              {typeLabel} · {!terminal && titular.nome ? titular.nome : `#${shortId}`}
            </span>
            <Badge variant={STATUS_VARIANT[request.status] ?? "neutral"}>{statusLabel}</Badge>
            {request.emergency && <Badge variant="error">{t("Urgente")}</Badge>}
          </span>
        }
        descricao={
          <>
            {t("Recebido em")}{" "}
            {format(new Date(request.received_at), `dd/MM/yyyy '${t("às")}' HH:mm`, { locale: localeDaData })}
            {request.due_at && (
              <>
                {" · "}
                {t("Vence em")} {prazoEmBr(request.due_at)}
              </>
            )}
          </>
        }
      />

      {/* Export download: delivered (completed) or for the operator to deliver by
          hand (pending_review). São DOIS arquivos: o PDF e a cópia que ele resume
          (issue #2341) — o manual entregava só o primeiro. */}
      {(signed_pdf_url || signed_json_url) && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border bg-muted/30 px-4 py-3 text-sm mb:mx-4">
          <div className="flex flex-wrap items-center gap-2">
            {signed_pdf_url && (
              <Button size="sm" variant="outline" asChild className="shrink-0">
                <a href={signed_pdf_url} download>
                  {t("Baixar PDF")}
                </a>
              </Button>
            )}
            {signed_json_url && (
              <Button size="sm" variant="outline" asChild className="shrink-0">
                <a href={signed_json_url} download>
                  {t("Baixar arquivo de dados (data.json)")}
                </a>
              </Button>
            )}
          </div>
        </div>
      )}

      <Bloco titulo={t("Prazo")}>
        {request.due_at ? (
          <div className="flex flex-col gap-4">
            {!terminal && (
              <PrazoDoPedido receivedAt={request.received_at} dueAt={request.due_at} className="min-w-0" />
            )}
            <SlaTimeline
              received_at={request.received_at}
              due_at={request.due_at}
              request_type={request.request_type}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("SLA não definido.")}</p>
        )}
      </Bloco>

      <Bloco titulo={t("Titular")}>
        {/* Minimização: depois de concluído ou falho, nome e e-mail do titular não voltam à tela. */}
        {terminal ? (
          <p className="text-muted-foreground">{t("Titular anonimizado")}</p>
        ) : (
          <>
            <Row label={t("Nome")} value={titular.nome ?? t("Sem nome no cadastro")} />
            <Row label={t("Envio para")} value={titular.email_destino ?? "—"} />
          </>
        )}
        {request.contact_id && <Row label="Contact ID" value={request.contact_id} mono />}
        {request.external_customer_id && (
          <Row label="External customer ID" value={request.external_customer_id} />
        )}
      </Bloco>

      <Bloco titulo={t("Dados que serão afetados")} acao={<PreviewPanel requestId={request.id} />} />

      <Bloco titulo={t("Detalhes")}>
        <Row label={t("ID completo")} value={request.id} mono />
        <Row label={t("Tipo")} value={typeLabel} />
        <Row label={t("Status")} value={statusLabel} />
        <Row label={t("Origem")} value={request.source ?? "—"} />
        <Row label={t("Escopo")} value={request.scope} />
        <Row label={t("Tentativas")} value={String(request.attempts)} />
        {request.completed_at && (
          <Row
            label={t("Concluído em")}
            value={format(new Date(request.completed_at), "dd/MM/yyyy HH:mm", { locale: localeDaData })}
          />
        )}
        {request.error_message && (
          <div className="rounded-md border border-error-fg/30 bg-error-bg px-2 py-1">
            <p className="text-xs text-muted-foreground">{t("Erro")}</p>
            <p className="text-xs text-error-fg">{request.error_message}</p>
          </div>
        )}
      </Bloco>

      <Bloco titulo={`${t("Trilha de auditoria")} (${audit_trail.length})`}>
        <AuditTrail entries={audit_trail} />
      </Bloco>

      {/* Aprovar fica à mão: o botão só existe com o pedido em "Recebido". */}
      {request.status === "received" && (
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-chrome px-4 py-3 mb:px-4">
          <ApproveButton
            requestId={request.id}
            requestType={request.request_type}
            status={request.status}
            titular={titular}
          />
        </div>
      )}
    </>
  );
}

function Bloco({ titulo, acao, children }: { titulo: string; acao?: ReactNode; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 mb:mx-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        {acao}
      </div>
      {children ? <div className="flex flex-col gap-2 text-sm">{children}</div> : null}
    </section>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {/* `title` dá o valor completo em hover — sem isso um uuid truncado
          (id do contato, id externo) virava informação irrecuperável na
          tela, justo num relatório que existe pra ser conferido. */}
      <span
        className={`text-right truncate ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
