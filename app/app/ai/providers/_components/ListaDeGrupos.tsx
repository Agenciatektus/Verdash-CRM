"use client";

import { useState, type ComponentType } from "react";

import { FolhaInferior } from "@/components/mobile/FolhaInferior";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import { Brain, CaretRight, ChatsCircle, Eye, Gauge, MagnifyingGlass, Robot, ShieldCheck } from "@/lib/ui/icons";

import type { DadosDoJev } from "./CartaoDoJev";
import { CartaoDoPonto } from "./CartaoDoPonto";
import type { Dados, Ponto } from "./tipos";

const ICONE_DO_PAPEL: Record<string, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  atender: ChatsCircle,
  melhorar: Gauge,
  entender: Brain,
  proteger: ShieldCheck,
  lembrar: MagnifyingGlass,
  perceber: Eye,
};

interface Grupo {
  papel: string;
  info: { rotulo: string; explicacao: string };
  pontos: Ponto[];
}

/**
 * Os grupos de tarefa numa lista só: nome, para que serve, modelo em uso e quantos
 * pontos. "Configuração avançada" abre os pontos do grupo numa folha lateral
 * (desktop e tablet) ou numa folha de baixo (celular), com o mesmo conteúdo de
 * antes: um cartão por ponto.
 */
export function ListaDeGrupos({
  grupos,
  dados,
  jev,
  aoSalvar,
}: {
  grupos: Grupo[];
  dados: Dados;
  jev: DadosDoJev | null;
  aoSalvar: () => Promise<void>;
}) {
  const t = useT();
  const celular = useEhCelular();
  const [aberto, setAberto] = useState<string | null>(null);
  const grupo = grupos.find((g) => g.papel === aberto) ?? null;

  const pontos = grupo ? (
    <div className="space-y-3">
      <ResumoDoGrupo pontos={grupo.pontos} />
      {grupo.pontos.map((ponto) => (
        <CartaoDoPonto key={ponto.id} ponto={ponto} dados={dados} jev={jev} aoSalvar={aoSalvar} />
      ))}
    </div>
  ) : null;

  return (
    <>
      <Card className="overflow-hidden" data-testid="lista-de-grupos">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold">
          {t("Qual IA faz cada tarefa")}
          <span className="font-normal text-muted-foreground">
            {dados.pontos.length} {t("pontos")}
          </span>
        </div>
        <ul className="divide-y divide-border">
          {grupos.map(({ papel, info, pontos: doGrupo }) => {
            const Icone = ICONE_DO_PAPEL[papel] ?? Robot;
            const modelos = [...new Set(doGrupo.map((p) => p.efetivo.modelId ?? t("não definido")))];
            const comAviso = doGrupo.filter((p) => p.avisos.length > 0).length;
            return (
              <li key={papel} data-testid={`papel-${papel}`}>
                <button
                  type="button"
                  data-testid={`avancado-${papel}`}
                  aria-label={`${t("Configuração avançada")}: ${t(info.rotulo)}`}
                  onClick={() => setAberto(papel)}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-elevated text-text-muted">
                    <Icone size={18} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(info.rotulo)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t(info.explicacao)}</span>
                    {comAviso > 0 && (
                      <span className="block text-xs text-warning-fg" data-testid="grupo-com-aviso">
                        {comAviso === 1
                          ? t("1 ponto deste grupo precisa da sua atenção.")
                          : `${comAviso} ${t("pontos deste grupo precisam da sua atenção.")}`}
                      </span>
                    )}
                  </span>
                  <span className="max-w-48 truncate rounded-md bg-surface-elevated px-2 py-0.5 font-mono text-xs mb:hidden">
                    {modelos.join(" · ")}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {doGrupo.length} {doGrupo.length === 1 ? t("ponto") : t("pontos")}
                  </span>
                  <CaretRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {celular ? (
        <FolhaInferior
          aberto={grupo !== null}
          aoMudar={(a) => !a && setAberto(null)}
          titulo={grupo ? t(grupo.info.rotulo) : ""}
          subtitulo={grupo ? `${grupo.pontos.length} ${t("pontos")}` : undefined}
        >
          <div className="px-2 pb-2">{pontos}</div>
        </FolhaInferior>
      ) : (
        <Sheet open={grupo !== null} onOpenChange={(a) => !a && setAberto(null)}>
          <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>{grupo ? t(grupo.info.rotulo) : ""}</SheetTitle>
              <SheetDescription>
                {grupo ? `${t("Configuração avançada")} (${grupo.pontos.length} ${t("pontos")})` : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4">{pontos}</div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** O que o grupo usa hoje, sem obrigar a abrir ponto a ponto. */
function ResumoDoGrupo({ pontos }: { pontos: Ponto[] }) {
  const t = useT();
  const modelos = [...new Set(pontos.map((p) => p.efetivo.modelId ?? t("não definido")))];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t("Usando:")}</span>
      {modelos.map((m) => (
        <Badge key={m} variant="secondary" className="font-mono text-xs">
          {m}
        </Badge>
      ))}
    </div>
  );
}
