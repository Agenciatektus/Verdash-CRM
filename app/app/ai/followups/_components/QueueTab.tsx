"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format, formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/empty";
import { BarraDeFiltros, CartaoEmpilhado, EstadoDaLista, TabelaOuCartoes } from "@/components/pagina";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Clock, Trash } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import { statusCancelavel } from "@/lib/followup/vocabulario";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import {
  useCancelFollowupEnrollment,
  useCancelFollowupPromise,
  useFollowupQueue,
  type FollowupEnrollmentStatus,
  type FollowupQueueRow,
} from "@/hooks/followup/useFollowupQueue";

interface Props {
  canWrite: boolean;
}

/**
 * Os status filtráveis, na ordem em que fazem sentido para quem opera: primeiro
 * o que está andando, depois o que parou, depois o que terminou. O RÓTULO vem de
 * `rotuloDoStatus` — a tabela morava aqui, e a segunda tela que mostrasse status
 * (o dossiê) nasceria com a segunda cópia.
 */
const STATUS_OPTIONS: FollowupEnrollmentStatus[] = [
  "active",
  "waiting_reply",
  "dormente",
  "paused_manual",
  "paused_handoff",
  // O roteiro de atendimento em andamento (0394). Só aparece como opção com o
  // módulo ligado — desligado, a fila fica como era.
  "coletando",
  "completed",
  "cancelled",
  "dead",
];

// Aqui "vivo" INCLUI o dormente, e é o oposto de LIVE_STATUSES da reatividade:
// quem espera a data do retorno tem de aparecer na fila. Um acompanhamento que
// some da tela por 28 dias é uma ilha — ninguém sabe que ele existe nem o
// cancela quando a cliente já voltou por outro caminho. A lista em si mora em
// `STATUS_CANCELAVEIS` (lib/followup/vocabulario.ts), a mesma que o dossiê e a
// rota leem desde o #3434: três cópias à mão foi o que deixou o dossiê de fora.

/**
 * O que ainda dá para desmarcar.
 *
 * A fila mostrava promessa e enrollment lado a lado e só oferecia o botão para o
 * segundo: o agente prometia voltar, a pessoa via na tela e não tinha o que
 * fazer. As duas famílias são canceláveis agora, por rotas diferentes — o
 * significado do cancelamento não é o mesmo, e um comando único atingiria a
 * linha errada em silêncio.
 */
function podeCancelar(row: FollowupQueueRow): boolean {
  return row.source === "enrollment" ? statusCancelavel(row.status) : row.status === "agendada";
}

function QueueStatusBadge({ status }: { status: string }) {
  const t = useT();
  return (
    <Badge variant={tomDoStatus(status)} aria-label={`${t("status")}: ${rotuloDoStatus(status, t)}`}>
      {rotuloDoStatus(status, t)}
    </Badge>
  );
}

function NextFireCell({ iso }: { iso: string | null }) {
  const localeDaData = useLocaleDeData();
  if (!iso) return <span className="text-text-muted">—</span>;
  const d = new Date(iso);
  const relative = formatDistanceToNowStrict(d, { addSuffix: true, locale: localeDaData });
  const absolute = format(d, "dd/MM/yyyy HH:mm", { locale: localeDaData });
  return (
    <div title={absolute} className="flex flex-col">
      <span className="text-sm">{relative}</span>
      <span className="text-xs text-text-muted">{absolute}</span>
    </div>
  );
}

export function QueueTab({ canWrite }: Props) {
  const t = useT();
  const [status, setStatus] = useState<FollowupEnrollmentStatus | "all">("all");
  const [pointerId, setPointerId] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [pendingCancel, setPendingCancel] = useState<FollowupQueueRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: flows } = useFollowupFlows();
  const { activeOrg } = useAuth();
  const roteirosLigados = activeOrg?.modulos_ligados?.includes("fluxos_atendimento") === true;
  const filters = useMemo(
    () => ({
      status: status === "all" ? undefined : status,
      pointer_id: pointerId === "all" ? undefined : pointerId,
      q: q || undefined,
    }),
    [status, pointerId, q],
  );
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useFollowupQueue(filters);
  const cancelEnrollment = useCancelFollowupEnrollment();
  const cancelPromise = useCancelFollowupPromise();

  const rows: FollowupQueueRow[] = data?.pages.flatMap((p) => p.data) ?? [];

  const ativos = (status !== "all" ? 1 : 0) + (pointerId !== "all" ? 1 : 0);
  const limpar = () => {
    setStatus("all");
    setPointerId("all");
    setSearchInput("");
  };
  const botaoCancelar = (row: FollowupQueueRow) =>
    canWrite && podeCancelar(row) ? (
      <Button
        variant="ghost"
        size="sm"
        data-testid="cancelar-item-da-fila"
        aria-label={row.source === "promise" ? t("Cancelar retorno") : t("Cancelar follow-up")}
        onClick={() => setPendingCancel(row)}
      >
        <Trash size={14} aria-hidden className="mr-1 text-error" /> {t("Cancelar")}
      </Button>
    ) : null;
  // A porta do dossiê. Só enrollment tem história para contar: a promessa
  // (`cron_jobs`) é uma linha só — um horário e um motivo — e um link que abrisse
  // uma tela vazia ensinaria que o dossiê às vezes não funciona.
  const dossie = (row: FollowupQueueRow) =>
    row.source === "enrollment" ? `/app/ai/followups/enrollments/${row.id}` : undefined;
  const fluxo = (row: FollowupQueueRow) => row.flow_name ?? t("Promessa");

  const tabela = (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Contato")}</TableHead>
          <TableHead>{t("Fluxo / Promessa")}</TableHead>
          <TableHead>{t("Nó atual / Motivo")}</TableHead>
          <TableHead>{t("Próximo disparo")}</TableHead>
          <TableHead>{t("Status")}</TableHead>
          {canWrite && <TableHead className="w-[100px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.source}:${row.id}`} data-testid="queue-row">
            <TableCell className="font-medium">
              {dossie(row) ? (
                <Link href={dossie(row)!} className="underline-offset-2 hover:underline" data-testid="queue-abrir-dossie">
                  {row.contact.name}
                </Link>
              ) : (
                row.contact.name
              )}
            </TableCell>
            <TableCell>
              <div className="flex flex-col">
                <span>{row.flow_name ?? <span className="text-text-muted">{t("Promessa")}</span>}</span>
                {row.agent_name && <span className="text-xs text-text-muted">{t("agente")} {row.agent_name}</span>}
              </div>
            </TableCell>
            <TableCell className="max-w-[280px] truncate text-sm" title={row.node_or_reason}>
              {row.node_or_reason}
            </TableCell>
            <TableCell>
              <NextFireCell iso={row.next_fire_at} />
            </TableCell>
            <TableCell>
              <QueueStatusBadge status={row.status} />
            </TableCell>
            {canWrite && <TableCell>{botaoCancelar(row)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <div className="flex flex-col gap-4 mb:gap-3">
      <BarraDeFiltros
        busca={{ valor: searchInput, aoMudar: setSearchInput, placeholder: t("Buscar contato…") }}
        ativos={ativos}
        aoLimpar={limpar}
      >
        <Select value={status} onValueChange={(v) => setStatus(v as FollowupEnrollmentStatus | "all")}>
          <SelectTrigger className="h-9 w-48 text-sm" aria-label={t("Filtrar por status")}>
            <SelectValue placeholder={t("Todos os status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todos os status")}</SelectItem>
            {STATUS_OPTIONS.filter((s) => s !== "coletando" || roteirosLigados).map((s) => (
              <SelectItem key={s} value={s}>
                {rotuloDoStatus(s, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={pointerId} onValueChange={setPointerId}>
          <SelectTrigger className="h-9 w-48 text-sm" aria-label={t("Filtrar por fluxo")}>
            <SelectValue placeholder={t("Todos os fluxos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todos os fluxos")}</SelectItem>
            {(flows ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </BarraDeFiltros>

      <EstadoDaLista
        carregando={isLoading}
        quantidade={rows.length}
        vazio={
          <EmptyState
            icon={Clock}
            headline={t("Nenhum item na fila")}
            subcopy={t("Enrollments ativos e promessas de retorno agendadas pela IA aparecem aqui.")}
          />
        }
      >
        <TabelaOuCartoes
          itens={rows}
          chave={(row) => `${row.source}:${row.id}`}
          rotulo={t("Fila")}
          tabela={tabela}
          cartao={(row) => (
            <div className="flex items-center">
              <div className="min-w-0 flex-1">
                <CartaoEmpilhado
                  href={dossie(row)}
                  titulo={row.contact.name}
                  apoio={row.agent_name ? `${fluxo(row)} · ${t("agente")} ${row.agent_name}` : fluxo(row)}
                  selo={<QueueStatusBadge status={row.status} />}
                  campos={[
                    { rotulo: t("Nó atual / Motivo"), valor: row.node_or_reason },
                    { rotulo: t("Próximo disparo"), valor: <NextFireCell iso={row.next_fire_at} /> },
                  ]}
                />
              </div>
              {botaoCancelar(row) ? <div className="shrink-0 pr-2">{botaoCancelar(row)}</div> : null}
            </div>
          )}
        />
      </EstadoDaLista>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
          </Button>
        </div>
      )}

      <AlertDialog open={pendingCancel !== null} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCancel?.source === "promise"
                ? t("Cancelar este retorno?")
                : t("Cancelar este follow-up?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCancel?.source === "promise"
                ? t("O agente não voltará a falar com esta pessoa no horário combinado, e vai saber que você desmarcou.")
                : t("O lead não receberá mais mensagens deste fluxo. Essa ação não pode ser desfeita.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (pendingCancel?.source === "promise") cancelPromise.mutate(pendingCancel.id);
                else if (pendingCancel) cancelEnrollment.mutate(pendingCancel.id);
                setPendingCancel(null);
              }}
            >
              {pendingCancel?.source === "promise" ? t("Cancelar retorno") : t("Cancelar follow-up")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
