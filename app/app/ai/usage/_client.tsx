"use client";
import { useSearchParams } from "next/navigation";
import { Aviso } from "@/components/ui/aviso";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CartaoDeIndicador } from "@/components/ui/cartao-de-indicador";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiUsage, type AiUsageFilters } from "@/hooks/ai/useAiUsage";
import { UsageFilters, type UsageFiltersAgent } from "@/components/ai/UsageFilters";
import { UsageChart } from "@/components/ai/UsageChart";
import { formatCentsUSD } from "@/lib/money";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  agents: UsageFiltersAgent[];
  initial: {
    agent_id?: string;
    invocation_kind?: string;
    from?: string;
    to?: string;
  };
}

/** Custo por turno costuma ficar abaixo de um centavo: duas casas mostrariam US$ 0,00. */
function formatCentsUSDFino(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
}

// Celular 2 colunas, tablet 3, desktop os seis numa fileira (board Aud_UsoIA).
const GRADE_DOS_INDICADORES = "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6";

function StatSkeletons() {
  return (
    <div className={GRADE_DOS_INDICADORES}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-8 w-32" />
        </Card>
      ))}
    </div>
  );
}

function ChartSkeletons() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </div>
      ))}
    </div>
  );
}

export function UsageDashboardClient({ agents, initial }: Props) {
  const t = useT();
  const searchParams = useSearchParams();

  const filters: AiUsageFilters = {
    agent_id: searchParams.get("agent_id") ?? undefined,
    invocation_kind: searchParams.get("invocation_kind") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };

  const q = useAiUsage(filters);
  // As opções de "Tipo de uso" vêm da mesma consulta SEM o filtro de tipo: o
  // `by_kind` da consulta filtrada só tem o tipo escolhido, e a lista encolheria
  // para ele. Sem filtro de tipo a chave é a mesma e o react-query não repete a ida.
  const semTipo = useAiUsage({ ...filters, invocation_kind: undefined });
  const kinds = Object.keys(semTipo.data?.by_kind ?? {});

  return (
    <div className="flex flex-col gap-6">
      <UsageFilters agents={agents} kinds={kinds} initial={initial} />

      {q.isError && !q.data ? (
        // Sem este ramo a consulta que falha deixava a tela nos esqueletos para sempre.
        <Aviso
          tom="crit"
          titulo={t("Não consegui carregar o uso de IA")}
          acao={
            <Button variant="outline" size="sm" loading={q.isFetching} onClick={() => void q.refetch()}>
              {t("Tentar de novo")}
            </Button>
          }
        />
      ) : q.isLoading || !q.data ? (
        <>
          <StatSkeletons />
          <ChartSkeletons />
        </>
      ) : (
        <>
          <div className={GRADE_DOS_INDICADORES}>
            <CartaoDeIndicador
              rotulo={t("Custo no período")}
              // DÓLAR: esta tela mostrava o MESMO número em duas moedas — o card de
              // orçamento logo acima em US$ e este CartaoDeIndicador em R$, dois centímetros abaixo.
              valor={formatCentsUSD(q.data.totals.cost_cents)}
            />
            {/*
              Este card se chamava "Atendimentos com IA" e contava linhas de
              `llm_calls` — CHAMADAS ao modelo. Um turno do agente faz várias
              (ferramentas, classificadores), então o número inflava o volume de
              atendimento. Os turnos têm o card ao lado.
            */}
            <CartaoDeIndicador
              rotulo={t("Chamadas de IA")}
              valor={q.data.totals.invocations.toLocaleString("pt-BR")}
              explicacao={t("cada resposta do agente pode fazer várias")}
            />
            {/*
              Turno = um job distinto com chamada `agent_turn` que deu certo, e
              o custo dele é o do job inteiro mesmo com filtro. `llm_calls.job_id`
              vira null quando a poda da fila apaga o job, então o turno antigo
              deixa de contar — o hint diz isso em vez de esconder.
            */}
            <CartaoDeIndicador
              rotulo={t("Turnos do agente")}
              valor={q.data.totals.agent_turns.toLocaleString("pt-BR")}
              explicacao={
                q.data.totals.avg_cost_per_turn_cents === null
                  ? t("sem turnos no período")
                  : `${t("custo médio por turno:")} ${formatCentsUSDFino(q.data.totals.avg_cost_per_turn_cents)} · ${t("conta só os turnos que a fila ainda guarda (padrão: 90 dias)")}`
              }
            />
            <CartaoDeIndicador
              rotulo={t("Taxa de cache")}
              valor={`${(q.data.totals.cache_hit_rate * 100).toLocaleString("pt-BR", {
                maximumFractionDigits: 1,
              })}%`}
              explicacao={t("do texto enviado à IA veio do cache, que custa bem menos")}
            />
            <CartaoDeIndicador
              rotulo={t("Passaram para uma pessoa")}
              valor={`${(q.data.totals.handoff_rate * 100).toFixed(2)}%`}
              explicacao={t("quanto mais alto, mais a IA precisou de ajuda")}
            />
            {/*
              "p95" quer dizer: em 95 das 100 chamadas o tempo foi ATÉ isso. É a
              medida honesta (a média esconde os casos ruins), mas o rótulo não
              pode ser a sigla. E é o tempo de UMA chamada ao modelo — um turno
              do agente encadeia várias, então isto não é o tempo que o cliente
              esperou pela resposta. O rótulo antigo, "Tempo de resposta",
              prometia o segundo e media o primeiro.
            */}
            <CartaoDeIndicador
              rotulo={t("Tempo de uma chamada à IA")}
              valor={`${(q.data.totals.p95_latency_ms / 1000).toLocaleString("pt-BR", {
                maximumFractionDigits: 1,
              })} s`}
              explicacao={`${t("a maioria responde em")} ${(
                q.data.totals.p50_latency_ms / 1000
              ).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s; ${t("este é o pior caso comum")}`}
            />
          </div>

          <UsageChart payload={q.data} />
        </>
      )}
    </div>
  );
}
