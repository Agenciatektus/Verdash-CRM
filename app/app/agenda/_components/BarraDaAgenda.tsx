"use client";

import { useT } from "@/hooks/i18n/useT";

import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import { HorariosLivresPorServico } from "@/components/agenda/HorariosLivresPorServico";
import type { Pessoa, VisaoDaAgenda } from "@/components/agenda/tipos";
import { Button } from "@/components/ui/button";
import { CLASSES_DA_OPCAO_DO_SEGMENTO, CLASSES_DO_SEGMENTO } from "@/components/ui/tabs";
import { CaretLeft, CaretRight, GoogleLogo } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * As opções do seletor. `Lista` só abaixo de `lg` (no desktop a lista é o painel
 * "Próximos" ao lado da grade); no celular só Lista e Dia (a grade de 3 dias, de
 * semana e de mês não cabe em 390px).
 */
const OPCOES: Array<{ id: "lista" | VisaoDaAgenda; rotulo: string; classe?: string }> = [
  { id: "lista", rotulo: "Lista", classe: "lg:hidden" },
  { id: "dia", rotulo: "Dia" },
  { id: "tres", rotulo: "3 dias", classe: "mb:hidden" },
  { id: "semana", rotulo: "Semana", classe: "mb:hidden" },
  { id: "mes", rotulo: "Mês", classe: "mb:hidden" },
];

/** Período, "Horários livres", seletor de visão e filtro por profissional. */
export function BarraDaAgenda({
  periodo,
  visao,
  lista,
  onVisao,
  onLista,
  onAnterior,
  onSeguinte,
  pessoas,
  isolada,
  onIsolar,
  tipos,
  tipoId,
  onEscolherTipo,
  conectarGoogle = false,
}: {
  periodo: string;
  visao: VisaoDaAgenda;
  lista: boolean;
  onVisao: (v: VisaoDaAgenda) => void;
  onLista: () => void;
  onAnterior: () => void;
  onSeguinte: () => void;
  pessoas: Pessoa[];
  isolada: string | null;
  onIsolar: (id: string | null) => void;
  tipos: Array<{ id: string; nome: string; duracaoMin: number }>;
  tipoId: string | null;
  onEscolherTipo: (id: string) => void;
  conectarGoogle?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Período anterior")}
              data-testid="periodo-anterior"
              onClick={onAnterior}
            >
              <CaretLeft size={16} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Próximo período")}
              data-testid="periodo-seguinte"
              onClick={onSeguinte}
            >
              <CaretRight size={16} weight="bold" aria-hidden />
            </Button>
          </div>
          {/* `first-letter:uppercase` e NÃO `capitalize`: o `capitalize` do CSS poria
              maiúscula em "De" ("23 De Ago"). Duas linhas no celular em vez de
              cortar o mês; `lg:truncate` onde a largura sobra. */}
          <span
            data-testid="periodo"
            className="text-sm font-semibold text-balance first-letter:uppercase lg:truncate"
          >
            {periodo}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {conectarGoogle && (
            <Button variant="outline" size="sm" data-testid="conectar-google-compacto" asChild>
              <a href="/api/v1/agenda/google/connect">
                <GoogleLogo size={16} weight="bold" aria-hidden />
                <span>{t("Conectar Google")}</span>
              </a>
            </Button>
          )}
          <HorariosLivresPorServico tipos={tipos} tipoId={tipoId} onEscolher={onEscolherTipo} />
          <div data-testid="alternador-de-visao" className={cn(CLASSES_DO_SEGMENTO, "w-fit")}>
            {OPCOES.map((o) => {
              const ativa = o.id === "lista" ? lista : !lista && visao === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  data-testid={`visao-${o.id}`}
                  data-ativa={ativa}
                  aria-pressed={ativa}
                  onClick={() => (o.id === "lista" ? onLista() : onVisao(o.id))}
                  className={cn(CLASSES_DA_OPCAO_DO_SEGMENTO, "max-lg:h-9 max-lg:px-3", o.classe)}
                >
                  {t(o.rotulo)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <FiltroDePessoas pessoas={pessoas} isolada={isolada} onIsolar={onIsolar} />
    </>
  );
}
