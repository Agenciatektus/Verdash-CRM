"use client";

import { format } from "date-fns";

import { useT } from "@/hooks/i18n/useT";

import { corDaTrilha } from "@/components/agenda/paleta";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { Chip } from "@/components/ui/chip";
import { dataDeParede, diaLocalISO } from "@/lib/agenda/fuso";

/**
 * "Próximos hoje" do tablet: os dois que ainda vêm hoje, embaixo da grade, com
 * "Ver todos" levando à lista completa. No desktop o painel "Próximos" já está
 * ao lado, então só existe abaixo de `lg`.
 */
export function ProximosHoje({
  agendamentos,
  pessoas,
  agora,
  fuso,
  onVerTodos,
}: {
  agendamentos: Agendamento[];
  pessoas: Pessoa[];
  agora: Date;
  fuso: string;
  onVerTodos: () => void;
}) {
  const t = useT();
  const futuros = agendamentos
    .filter((a) => a.situacao !== "cancelled" && new Date(a.comeca) >= agora)
    .sort((a, b) => a.comeca.localeCompare(b.comeca));
  const hoje = futuros.filter(
    (a) => diaLocalISO(new Date(a.comeca), fuso) === diaLocalISO(agora, fuso),
  );
  return (
    <section
      data-testid="proximos-hoje"
      className="shrink-0 rounded-lg border border-border bg-surface lg:hidden"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{t("Próximos hoje")}</h2>
        <Chip data-testid="ver-todos" onClick={onVerTodos}>
          {t("Ver todos")}
          <span className="tabular-nums opacity-70">{futuros.length}</span>
        </Chip>
      </div>
      {hoje.length === 0 ? (
        <p className="px-3 py-3 text-sm text-text-muted">{t("Nada mais marcado para hoje.")}</p>
      ) : (
        <ul>
          {hoje.slice(0, 2).map((a) => {
            const pessoa = pessoas.find((p) => p.id === a.responsavelId);
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <span
                  aria-hidden
                  className="h-8 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: corDaTrilha(pessoa?.trilha ?? 1) }}
                />
                <span className="w-12 shrink-0 text-sm tabular-nums text-text-muted">
                  {format(dataDeParede(new Date(a.comeca), fuso), "HH:mm")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {a.quemSeraAtendido ?? a.titulo}
                  </span>
                  <span className="block truncate text-xs text-text-muted">
                    {a.tipo || t("Agendamento")}
                    {pessoa ? ` · ${t("com")} ${pessoa.nome}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
