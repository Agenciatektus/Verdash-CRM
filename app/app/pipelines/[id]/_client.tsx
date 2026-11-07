"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { usePedidoDeCriar } from "@/lib/mobile/usePedidoDeCriar";
import { FunilNoCelular } from "@/components/mobile/telas/Funil";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import { usePodeCriar } from "@/lib/mobile/usePodeCriar";
import { useT } from "@/hooks/i18n/useT";
import { useBoard } from "@/hooks/kanban/useBoard";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { CabecalhoDoFunil } from "@/components/kanban/barra/CabecalhoDoFunil";
import { BarraDeBusca } from "@/components/kanban/barra/BarraDeBusca";
import { PainelDeFiltros } from "@/components/kanban/barra/PainelDeFiltros";
import { ListaDoFunil } from "@/components/kanban/ListaDoFunil";
import { ListaDoFunilCelular } from "@/components/kanban/ListaDoFunilCelular";
import { useFunilCompacto } from "@/hooks/kanban/useFunilCompacto";
import { useOrdemDoFunil, useVistaDoFunil } from "@/hooks/kanban/usePreferenciasDoFunil";
import { useRecorteDoFunil } from "@/hooks/kanban/useRecorteDoFunil";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { LeadDossier } from "@/components/kanban/LeadDossier";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { selecaoRestaurada } from "@/lib/kanban/selecao-restaurada";
import { ROLE_RANK, type Role } from "@/lib/auth/types";

function formatError(err: unknown, t: (texto: string) => string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return t("Erro desconhecido");
    }
  }
  return String(err);
}
import { CalendarioDoFunil } from "@/components/kanban/CalendarioDoFunil";

/**
 * A página do Funil com a barra aprovada pelo Peterson (board "Barra do
 * Funil", 13/10/2026): resumo do recorte no título, Kanban × Lista e
 * densidade só com ícone, busca por gente, atalhos, painel de filtros e
 * Ordenar. Filtros na URL (e lembrados por pessoa); vista, ordem e densidade
 * por pessoa neste navegador.
 *
 * A cadência saiu do produto: a campanha absorveu as sete capacidades dela.
 * `?modo=cadencias` cai no Kanban, e a tela não existe mais no código — o que
 * sobrou de `lib/cadencia` é o MOTOR compartilhado pela campanha, pelo agente
 * de IA e pelo follow-up.
 */
export function PipelinePageClient({
  pipelineId,
  initialName,
  role,
  funis,
}: {
  pipelineId: string;
  initialName: string;
  role: Role;
  /**
   * Os funis vivos da organização (`id` + `name`, na ordem da lista) — a MESMA
   * partição da tela de Funis. É o que alimenta o seletor de troca rápida do
   * cabeçalho; sem ele o quadro não sabe que existem outros funis.
   */
  funis: Array<{ id: string; name: string }>;
}) {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // #2995: o negócio de `?lead=` fica no quadro mesmo com o recorte de encerrados.
  const { data, isLoading, error, pulses, realtimeStatus, seguranca } = useBoard(pipelineId, searchParams.get("lead"));
  const celular = useEhCelular();
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const [compacto, setCompacto] = useFunilCompacto(user?.id);
  const [vista, setVista] = useVistaDoFunil(user?.id);
  const [ordem, setOrdem] = useOrdemDoFunil(user?.id);
  const { filters, setFilters, recorte, ordenados, resumo, contagens } = useRecorteDoFunil(pipelineId, data, user?.id, ordem);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  // Na Lista, clicar na linha abre o MESMO dossiê (detalhes + conversa) do quadro;
  // no quadro quem cuida disso é o KanbanBoard.
  const [dossieDaLista, setDossieDaLista] = useState<string | null>(null);
  // O "+" do celular chega com `?criar=1`.
  const podeCriar = usePodeCriar();
  usePedidoDeCriar(() => setNewOpen(true), podeCriar);
  const { data: membros } = useAssignableMembers(true);
  const ownerNames = useMemo(() => new Map((membros ?? []).map((m) => [m.user_id, m.full_name])), [membros]);

  // A lista da tag em lote é só `lead.tags` (é lá que a ação em lote grava, #852),
  // não as três caixas do painel de filtros.
  const tagsDoQuadro = useMemo(
    () => [...new Set((data?.leads ?? []).flatMap((l) => l.tags))].sort(),
    [data?.leads],
  );
  // O Desfazer do lote roda 5 s depois de agendado, com a página já em outro
  // render: o quadro de AGORA vem por ref, e a seleção de agora pelo updater.
  // Só volta o que ainda está no quadro, e nunca por cima de uma seleção nova.
  const idsDoQuadro = useMemo(() => new Set((data?.leads ?? []).map((l) => l.id)), [data?.leads]);
  const idsDoQuadroRef = useRef(idsDoQuadro);
  useEffect(() => {
    idsDoQuadroRef.current = idsDoQuadro;
  }, [idsDoQuadro]);
  const restaurarSelecao = useCallback(
    (ids: string[]) => setSelectedIds((atual) => selecaoRestaurada(atual, ids, idsDoQuadroRef.current)),
    [],
  );
  const nomeAtual = data?.pipeline.name ?? initialName;
  // Funil ARQUIVADO (#1298) abre para OLHAR: quadro em leitura, sem criar, lote nem renomear.
  const arquivado = (data?.pipeline as { is_archived?: boolean } | undefined)?.is_archived === true;
  // Um funil só = nada para trocar: o seletor seria ruído permanente.
  const podeTrocar = funis.length > 1;

  const cabecalho = (
    <CabecalhoDoFunil
      titulo={data?.pipeline.name ?? initialName}
      resumo={resumo}
      atrasadosLigado={!!filters.overdueOnly}
      onAtrasados={() => setFilters({ ...filters, overdueOnly: filters.overdueOnly ? undefined : true })}
      vista={vista}
      onVista={setVista}
      compacto={compacto}
      onCompacto={setCompacto}
      onNovo={() => setNewOpen(true)}
      carregado={!!data && !arquivado}
      celular={celular}
    />
  );
  const barra = (
    <BarraDeBusca
      filters={filters}
      onChange={setFilters}
      contagens={contagens}
      totalDoRecorte={recorte.length}
      ordem={ordem}
      onOrdem={setOrdem}
      userId={userId}
      celular={celular}
      painel={
        <PainelDeFiltros
          filters={filters}
          onChange={setFilters}
          leads={data?.leads ?? []}
          settings={data?.pipeline.settings}
          userId={userId}
        />
      }
    />
  );
  const lote = (
    <BulkActionBar
      selectedIds={selectedIds}
      stages={data?.stages ?? []}
      pipelineId={pipelineId}
      vocabulary={data?.pipeline.vocabulary ?? null}
      tagsExistentes={tagsDoQuadro}
      leads={ordenados}
      funis={funis}
      ownerNames={ownerNames}
      onClear={() => setSelectedIds([])}
      onRestaurar={restaurarSelecao}
    />
  );
  // #1751 (upstream): o quadro é a lista que o diálogo confere ANTES de criar —
  // é ela que faz o aviso de negócio duplicado existir sem rede.
  const novo = data && (
    <NewLeadDialog
      open={newOpen}
      onOpenChange={setNewOpen}
      pipelineId={pipelineId}
      stages={data.stages}
      leads={data.leads}
    />
  );
  const lista = (Lista: typeof ListaDoFunil) =>
    data && (
      <Lista
        leads={ordenados}
        stages={data.stages}
        ownerNames={ownerNames}
        ordem={ordem}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onAbrir={setDossieDaLista}
      />
    );
  // `/app/leads/:id` redireciona para cá com `?lead=`: no celular quem abre é a página.
  const leadDaUrl = searchParams.get("lead");
  // No celular o dossiê é desta página nas duas vistas (lá não há KanbanBoard).
  // O lead da URL vale mesmo fora do recorte: o filtro lembrado não esconde o link.
  const leadDaLista =
    (vista === "lista" || celular) && dossieDaLista
      ? (ordenados.find((l) => l.id === dossieDaLista) ??
        (dossieDaLista === leadDaUrl ? data?.leads.find((l) => l.id === dossieDaLista) : undefined) ??
        null)
      : null;
  useEffect(() => {
    if (celular && leadDaUrl) setDossieDaLista(leadDaUrl);
  }, [celular, leadDaUrl]);
  // Trocou de vista ou o lead saiu do recorte: o dossiê fecha de vez, em vez de
  // reabrir sozinho quando a pessoa volta para a Lista. Com o quadro ainda
  // carregando, o `?lead=` não fecha antes de existir.
  useEffect(() => {
    if (data && dossieDaLista && !leadDaLista) setDossieDaLista(null);
  }, [data, dossieDaLista, leadDaLista]);
  const dossie = data && leadDaLista && (
    <LeadDossier
      open
      onOpenChange={(v: boolean) => !v && setDossieDaLista(null)}
      lead={leadDaLista}
      pipelineId={pipelineId}
      fieldDefs={camposDoFunil(data.pipeline.settings ?? null)}
      stageName={data.stages.find((s) => s.id === leadDaLista.stage_id)?.name ?? "—"}
      etapas={data.stages.filter((s) => !s.is_archived)}
      ownerNames={ownerNames}
    />
  );

  // Celular (M3.1): abas de etapa e cartões (as colunas arrastáveis brigam com o
  // dedo), com a MESMA barra empilhada em cima; a Lista vira cards com toque longo.
  if (celular) {
    return (
      <>
        <FunilNoCelular
          pipelineId={pipelineId}
          aoTrocarFunil={(id) => router.push(`/app/pipelines/${id}`)}
          leadsDoRecorte={data ? ordenados : undefined}
          barra={<div className="flex flex-col gap-2 px-4 py-2">{cabecalho}{barra}</div>}
          conteudo={vista === "lista" ? lista(ListaDoFunilCelular) : undefined}
          aoAbrir={setDossieDaLista}
        />
        {vista === "lista" && lote}
        {novo}
        {dossie}
      </>
    );
  }

  return (
    <div
      // O QUADRO CABE NA TELA. A página rolava com a janela: o quadro media o
      // que media a coluna mais comprida, e a barra de rolagem horizontal ficava
      // no pé dele — com uma etapa cheia, era preciso descer até o fim para
      // conseguir andar para o lado, e no caminho o nome da etapa sumia do alto.
      // Com a altura da área visível (100dvh menos a barra do topo, h-14, e o
      // padding do <main>), quem rola é o quadro: a barra horizontal fica sempre
      // no pé da tela e o cabeçalho de cada etapa fica preso em cima. O piso de
      // 28rem é para tela baixa demais, onde a página volta a rolar.
      //
      // ⚠️ A PARCELA DE BAIXO VEM DO CONTRATO, e era um `3rem` literal.
      //
      // Aquele literal era a segunda metade do `p-6` do `<main>` escrita à mão,
      // e ela não sabia de nenhuma peça fixa no rodapé. Com a barra de abas do
      // celular (`components/shell/BarraInferior.tsx`, 56px mais a área segura),
      // o quadro media 48px a mais do que tinha e o fim dele — justamente onde
      // mora a barra de rolagem horizontal, a razão desta linha existir —
      // passava a correr POR BAIXO das abas.
      //
      // `max(var(--space-6), var(--rodape-ocupado, 0px))` é a mesma fórmula do
      // `components/inbox/InboxLayout.tsx`, e é o que o gate
      // `tests/unit/altura-fixa-le-a-reserva-do-rodape.test.ts` cobra: altura
      // fixa não desconta número próprio, lê a reserva.
      className="flex h-[calc(100dvh-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] min-h-[28rem] flex-col gap-3"
      // OBSERVÁVEL de propósito, e é a razão de existir desta linha: "a
      // assinatura morreu" e "nada aconteceu" produzem o MESMO silêncio na
      // tela, e sem este valor nem o produto nem o teste conseguem separar as
      // duas famílias de causa. Com ele, quem investiga olha DURANTE a rodada
      // que falha: `subscribed` manda procurar a montante (entrega, filtro, ou
      // o evento nunca saiu); `channel_error`/`timed_out`/`closed` já é a
      // resposta.
      //
      // Ainda NÃO religa — religar é desenho e merece bloco próprio. Isto aqui
      // é só parar de descartar o que já era calculado.
      data-realtime-status={realtimeStatus.toLowerCase()}
      data-refetch-divergencias={seguranca.divergencias}
      data-refetch-em={seguranca.ultimaVerificacao ?? ""}
    >
      {cabecalho}
      {arquivado && (
        <p
          className="rounded-md border border-border bg-surface-elevated/40 p-3 text-sm leading-relaxed text-text-muted"
          data-testid="funil-arquivado-aviso"
        >
          {t("Este funil está arquivado: o quadro abre em leitura, e nada aqui grava até você tirá-lo do arquivo em Funis.")}
        </p>
      )}
      {novo}
      {barra}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Não consegui carregar este funil:")} {formatError(error, t)}
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : vista === "lista" ? (
        <>
          {lista(ListaDoFunil)}
          {dossie}
        </>
      ) : vista === "calendario" ? (
        // Visão Calendário (#2770, upstream), terceira opção do nosso seletor de
        // vista: o MESMO recorte filtrado do quadro e da lista.
        <CalendarioDoFunil
          pipelineId={pipelineId}
          pipeline={data.pipeline}
          stages={data.stages}
          leads={recorte}
        />
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={recorte}
          pulses={pulses}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          leadInicial={searchParams.get("lead")}
          podeRenomearEtapa={!arquivado && ROLE_RANK[role] >= ROLE_RANK.manager}
          compacto={compacto}
          somenteLeitura={arquivado}
          ordenar={ordem}
        />
      )}
      {!arquivado && lote}
    </div>
  );
}
