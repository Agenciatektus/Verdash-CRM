"use client";

import type { ReactNode } from "react";

import { Funnel } from "@/lib/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { channelLabel, type ChannelSession } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

import type { InboxFiltersValue } from "../InboxFilters";
import { FiltrosSalvos } from "./FiltrosSalvos";

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /** Quantos filtros do popover estão ligados (o número no botão). */
  ativos: number;
  channels: ChannelSession[] | undefined;
  showChannelSwitch: boolean;
  filtroForaDaLista: boolean;
  mostrarSeletorDeEntrada: boolean;
  /** O seletor de etiqueta já montado (ou `null` quando não há o que oferecer). */
  seletorDeEtiqueta: ReactNode;
  /** Funil, etapas, responsável, canal e período (9051), já montados. */
  atendimento?: ReactNode;
}

const GATILHO_DO_SELECT =
  "h-8 w-full min-w-0 rounded-md border-border bg-surface-elevated px-3 text-xs shadow-none";

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 border-t border-border px-1 pt-2.5">
      <p className="px-1 text-xs font-semibold text-text-subtle">{titulo}</p>
      {children}
    </div>
  );
}

/**
 * Todos os filtros da lista atrás de UM botão (visual v2).
 *
 * Eram até cinco controles empilhados numa coluna de 280 px, disputando lugar
 * com a busca e as abas. Nenhum foi removido: Só não lidas, Só grupos, número de
 * WhatsApp, etiquetas com E/OU e Direct/comentários continuam aqui, nas MESMAS
 * condições de aparecer (número com 2+ canais ou filtro órfão, etiqueta com
 * vocabulário ou filtro órfão, entrada com Instagram ou filtro ligado). O que
 * está ligado fica visível fora do popover, nos chips abaixo da busca.
 *
 * O `Popover` do Radix resolve as três exigências sem código próprio: portal (não
 * é cortado pela borda da coluna), fecha com clique fora e com Esc, e reposiciona
 * contra a borda da janela. Os menus de dentro (Select, etiqueta) são camadas
 * filhas na árvore do React, então clicar neles não conta como "fora", e o Esc
 * fecha primeiro o menu de cima.
 */
export function PopoverDeFiltros({
  value,
  onChange,
  ativos,
  channels,
  showChannelSwitch,
  filtroForaDaLista,
  mostrarSeletorDeEntrada,
  seletorDeEtiqueta,
  atendimento,
}: Props) {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Nome acessível explícito: sem ele o leitor de tela lia "Filtros2",
          // o número colado sem dizer o que conta.
          aria-label={ativos > 0 ? `${t("Filtros")}, ${ativos} ${t("ativos")}` : t("Filtros")}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold text-text-muted transition-colors hover:bg-surface-elevated hover:text-text",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            "data-[state=open]:bg-surface-elevated data-[state=open]:text-text",
          )}
        >
          <Funnel size={14} aria-hidden />
          {t("Filtros")}
          {ativos > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[11px] tabular-nums text-accent-foreground">
              {ativos}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent folhaNoCelular align="end" collisionPadding={12} className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-72 space-y-2.5 overflow-y-auto p-2">
        <div className="space-y-0.5">
          <label className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm hover:bg-surface-elevated">
            {t("Só não lidas")}
            <Switch
              checked={value.onlyUnread}
              onCheckedChange={(on) => onChange({ ...value, onlyUnread: on })}
            />
          </label>
          {/* "Sem próximo passo" (L4): o contato não tem tarefa aberta. Fechada,
              arquivada e grupo nunca entram (o banco devolve nulo nelas). */}
          <label className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm hover:bg-surface-elevated">
            {t("Sem próximo passo")}
            <Switch
              checked={value.semPasso ?? false}
              onCheckedChange={(on) => onChange({ ...value, semPasso: on })}
            />
          </label>
          {/* "Só grupos" manda `is_group=true`; desligado manda `false`: grupo
              nunca aparece misturado às conversas de atendimento. */}
          <label className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm hover:bg-surface-elevated">
            {t("Só grupos")}
            <Switch
              checked={value.onlyGroups ?? false}
              onCheckedChange={(on) => onChange({ ...value, onlyGroups: on })}
            />
          </label>
        </div>

        {showChannelSwitch && (
          <Secao titulo={t("Número de WhatsApp")}>
            <Select
              value={value.channel_session_id ?? "all"}
              onValueChange={(v) =>
                onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
              }
            >
              <SelectTrigger
                className={cn(
                  GATILHO_DO_SELECT,
                  value.channel_session_id != null && "border-accent bg-accent-soft text-accent",
                )}
                aria-label={t("Filtrar por número de WhatsApp")}
              >
                <SelectValue placeholder={t("Todos os números")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Todos os números")}</SelectItem>
                {filtroForaDaLista && value.channel_session_id != null && (
                  <SelectItem value={value.channel_session_id}>{t("Número removido")}</SelectItem>
                )}
                {channels?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {channelLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Secao>
        )}

        {seletorDeEtiqueta && <Secao titulo={t("Tags")}>{seletorDeEtiqueta}</Secao>}

        {atendimento}

        {mostrarSeletorDeEntrada && (
          <Secao titulo={t("Entrada no Instagram")}>
            <Select
              value={value.entrada ?? "all"}
              onValueChange={(v) => onChange({ ...value, entrada: v === "all" ? undefined : v })}
            >
              <SelectTrigger
                className={cn(
                  GATILHO_DO_SELECT,
                  value.entrada != null && "border-accent bg-accent-soft text-accent",
                )}
                aria-label={t("Filtrar por origem no Instagram")}
              >
                <SelectValue placeholder={t("Direct e comentários")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Direct e comentários")}</SelectItem>
                <SelectItem value="direct">{t("Só Direct")}</SelectItem>
                <SelectItem value="comentario">{t("Só comentários")}</SelectItem>
              </SelectContent>
            </Select>
          </Secao>
        )}

        <FiltrosSalvos value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
