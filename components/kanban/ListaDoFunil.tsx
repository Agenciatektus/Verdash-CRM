"use client";
import Link from "next/link";
import { type MouseEvent, useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { canalDoCard, iniciaisDoCard, linhaDeBaixo, nomeDoCard } from "@/lib/kanban/identidade-do-card";
import { colunaDaOrdem, COLUNAS_DA_LISTA, ordenarPorColuna, type ColunaDaLista, type Sentido } from "@/lib/kanban/colunas-da-lista";
import type { OrdemDoFunil } from "@/lib/kanban/ordem-do-funil";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import { origemDoLead, rotuloDaOrigem } from "@/lib/kanban/recorte-do-funil";
import { tempoNaEtapa } from "@/lib/kanban/tempo-na-etapa";
import type { Stage } from "@/lib/kanban/types";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { Lead } from "@/lib/types/leads";
import { CaretDown, CaretUp } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AvatarDoLead } from "./AvatarDoLead";
import { EsperaDoLead, ProximoPassoDoCard, ResponsavelDoCard, TempoDoCard } from "./PartesDoCard";

export interface PropsDaLista {
  leads: Lead[];
  stages: Stage[];
  ownerNames: Map<string, string | null>;
  ordem: OrdemDoFunil;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /** Abre o dossiê do lead (detalhes + conversa). Sem ele, o nome leva à página do lead. */
  onAbrir?: (leadId: string) => void;
}

/**
 * A LISTA do Funil no desktop: uma linha por lead, para varrer e agir em lote.
 * Cabeçalho ordena (com `aria-sort`); sem clique, vale a ordem do menu.
 * Rola na horizontal em tela estreita. Marcar abre a barra em lote da página.
 */
export function ListaDoFunil({ leads, stages, ownerNames, ordem, selectedIds, onSelectionChange, onAbrir }: PropsDaLista) {
  const t = useT();
  const [porColuna, setPorColuna] = useState<{ coluna: ColunaDaLista; sentido: Sentido } | null>(null);
  const agora = useMemo(() => new Date(), [leads]); // eslint-disable-line react-hooks/exhaustive-deps
  const etapa = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const nomeDoDono = (l: Lead) => resolveLeadOwner(l, ownerNames).name ?? "";
  const linhas = porColuna
    ? ordenarPorColuna(leads, porColuna.coluna, porColuna.sentido, {
        posicaoDaEtapa: (id) => etapa.get(id)?.position ?? 0,
        nomeDoDono,
      })
    : leads;
  const ativa = porColuna ?? colunaDaOrdem(ordem);
  const marcados = new Set(selectedIds);
  const todos = linhas.length > 0 && linhas.every((l) => marcados.has(l.id));
  const alterna = (id: string) =>
    onSelectionChange(marcados.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  const clicaColuna = (coluna: ColunaDaLista) =>
    setPorColuna((atual) =>
      atual?.coluna === coluna ? { coluna, sentido: atual.sentido === "asc" ? "desc" : "asc" } : { coluna, sentido: coluna === "nome" || coluna === "etapa" || coluna === "origem" ? "asc" : "desc" },
    );

  // Clique na linha abre o dossiê, menos quando cai num controle da própria linha
  // (marcar, próximo passo, link). No nome, Ctrl/⌘/clique do meio continuam abrindo
  // a página do lead em outra aba.
  const clicaLinha = (id: string) => (e: MouseEvent<HTMLTableRowElement>) => {
    // O clique do React sobe pela árvore de componentes, não pelo DOM: o que vem de
    // um portal aberto a partir da linha (popover, diálogo) não está DENTRO do <tr>.
    // Arrastar para selecionar texto também não é pedido para abrir.
    const alvo = e.target as Node;
    if (!onAbrir || !e.currentTarget.contains(alvo)) return;
    if ((alvo as HTMLElement).closest?.("a, button, input, label, [role=menuitem], [role=dialog]")) return;
    if (window.getSelection()?.toString()) return;
    onAbrir(id);
  };
  const clicaNome = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onAbrir || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onAbrir(id);
  };

  if (linhas.length === 0) {
    return <p className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-text-muted">{t("Nenhum lead neste recorte.")}</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface" data-lista-do-funil>
      <table className="w-full min-w-[60rem] border-collapse text-sm">
        <caption className="sr-only">{t("Leads do funil")}</caption>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th scope="col" className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label={t("Selecionar todos")}
                checked={todos}
                onChange={() => onSelectionChange(todos ? [] : linhas.map((l) => l.id))}
              />
            </th>
            {COLUNAS_DA_LISTA.map((c) => {
              const sentido = ativa?.coluna === c.id ? ativa.sentido : null;
              return (
                <th key={c.id} scope="col" aria-sort={sentido === "asc" ? "ascending" : sentido === "desc" ? "descending" : "none"} className="px-3 py-2 font-semibold">
                  <button type="button" onClick={() => clicaColuna(c.id)} className="inline-flex items-center gap-1 rounded-sm hover:text-text">
                    {t(c.rotulo)}
                    {sentido === "asc" ? <CaretUp size={12} aria-hidden /> : sentido === "desc" ? <CaretDown size={12} aria-hidden /> : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => {
            const { nome: bruto, origem } = nomeDoCard(l);
            const nome = bruto || t("Sem nome");
            const canal = canalDoCard(l);
            const sub = linhaDeBaixo(l, origem, canal);
            const st = etapa.get(l.stage_id);
            const horas = (agora.getTime() - new Date(l.stage_changed_at ?? l.created_at).getTime()) / 3_600_000;
            return (
              <tr key={l.id} onClick={clicaLinha(l.id)} className={cn("border-b border-border last:border-0 hover:bg-hover", onAbrir && "cursor-pointer", marcados.has(l.id) && "bg-accent/5")}>
                <td className="px-3 py-2">
                  <input type="checkbox" aria-label={`${t("Selecionar")} ${nome}`} checked={marcados.has(l.id)} onChange={() => alterna(l.id)} />
                </td>
                <td className="max-w-64 px-3 py-2">
                  <Link href={`/app/leads/${l.id}`} onClick={clicaNome(l.id)} className="flex min-w-0 items-center gap-2.5 hover:underline">
                    <AvatarDoLead
                      compacto
                      semente={l.contact_id ?? l.id}
                      iniciais={iniciaisDoCard(nome)}
                      foto={l.contact_tem_foto && l.contact_id ? `/api/v1/contacts/${l.contact_id}/avatar` : null}
                      canal={canal}
                    />
                    <span className="min-w-0">
                      <b className="block truncate text-text">{nome}</b>
                      {sub && <span className={cn("block truncate text-xs text-text-muted", sub.mono && "font-mono")}>{sub.chave ? t(sub.texto) : sub.texto}</span>}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{st?.name ?? "—"}</td>
                <td className="px-3 py-2 font-semibold whitespace-nowrap tabular-nums">
                  {l.value_cents && l.value_cents > 0 ? formatValorDoNegocio(l.value_cents, l.currency ?? MOEDA_PADRAO, { semCentavos: true }) : <span className="font-normal text-text-subtle">{t("Sem valor")}</span>}
                </td>
                <td className="px-3 py-2"><ResponsavelDoCard owner={resolveLeadOwner(l, ownerNames)} /></td>
                <td className="max-w-56 px-3 py-2">{l.proximo_passo !== undefined && <ProximoPassoDoCard passo={l.proximo_passo} agora={agora} />}</td>
                <td className="px-3 py-2 text-xs"><TempoDoCard tempo={tempoNaEtapa(horas, st?.expected_duration_hours)} /></td>
                <td className="px-3 py-2 text-xs"><EsperaDoLead lead={l} agora={agora} /></td>
                <td className="max-w-56 px-3 py-2 text-text-muted">
                  <span className="block whitespace-nowrap">{t(rotuloDaOrigem(origemDoLead(l)))}</span>
                  {l.contact_campanha && (
                    <span className="block truncate text-xs text-text-subtle" title={l.contact_anuncio ? `${l.contact_campanha} · ${l.contact_anuncio}` : l.contact_campanha}>
                      {l.contact_campanha}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
