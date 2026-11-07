"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { VistaDoFunil } from "@/hooks/kanban/usePreferenciasDoFunil";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import { Clock, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { SeletorDeDensidade, SeletorDeVista } from "../SeletorDeDensidade";

export interface ResumoDoTitulo {
  abertos: number;
  centavos: number;
  moeda: string | null;
  atrasados: number;
}

/**
 * Linha 1 da barra do Funil: título + resumo do RECORTE (abertos, soma, e
 * "N atrasados", que é botão e liga o atalho de mesmo nome); à direita, os
 * segmentados só com ícone e "Novo lead". No celular o título é o seletor de
 * funil (`FunilNoCelular`) e o "Novo lead" é o "+" da casca.
 */
export function CabecalhoDoFunil({
  titulo,
  resumo,
  atrasadosLigado,
  onAtrasados,
  vista,
  onVista,
  compacto,
  onCompacto,
  onNovo,
  carregado,
  celular = false,
}: {
  titulo: string;
  resumo: ResumoDoTitulo | null;
  atrasadosLigado: boolean;
  onAtrasados: () => void;
  vista: VistaDoFunil;
  onVista: (v: VistaDoFunil) => void;
  compacto: boolean;
  onCompacto: (c: boolean) => void;
  onNovo: () => void;
  carregado: boolean;
  celular?: boolean;
}) {
  const t = useT();
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        {!celular && <h1 className="min-w-0 truncate text-title-lg">{titulo}</h1>}
        {resumo && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted" aria-live="polite">
            <span className="font-semibold text-text tabular-nums">
              {resumo.abertos === 1 ? t("1 aberto") : `${resumo.abertos} ${t("abertos")}`}
            </span>
            {resumo.centavos > 0 && (
              <span className="tabular-nums">
                {formatValorDoNegocio(resumo.centavos, resumo.moeda ?? MOEDA_PADRAO, { semCentavos: true })}
              </span>
            )}
            {(resumo.atrasados > 0 || atrasadosLigado) && (
              <button
                type="button"
                aria-pressed={atrasadosLigado}
                onClick={onAtrasados}
                className={cn(
                  "inline-flex min-h-7 items-center gap-1 rounded-full px-2 font-semibold tabular-nums mb:min-h-11",
                  atrasadosLigado ? "bg-error-fg text-surface" : "bg-error-bg text-error-fg hover:brightness-95",
                )}
              >
                <Clock size={14} aria-hidden />
                {resumo.atrasados === 1 ? t("1 atrasado") : `${resumo.atrasados} ${t("atrasados")}`}
              </button>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SeletorDeVista vista={vista} onChange={onVista} />
        {vista === "kanban" && <SeletorDeDensidade compacto={compacto} onChange={onCompacto} />}
        {!celular && (
          <Button onClick={onNovo} disabled={!carregado} className="shrink-0">
            <Plus size={16} className="mr-2" /> {t("Novo negócio")}
          </Button>
        )}
      </div>
    </header>
  );
}
