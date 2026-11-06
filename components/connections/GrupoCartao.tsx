"use client";
/** Um grupo na lista de Canais › Grupos: nome, selos, contagens e as duas chaves (entrar na inbox / IA responde). */
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

import type { Grupo } from "./grupos-lista";

export function GrupoCartao({
  g,
  bloqueado,
  onLigar,
  onIa,
}: {
  g: Grupo;
  bloqueado: boolean;
  onLigar: (g: Grupo, enabled: boolean) => void;
  onIa: (g: Grupo, iaModo: "off" | "chamada" | "todas") => void;
}) {
  const t = useT();
  const nome = g.subject ?? t("Grupo sem nome");
  const membros = g.participantCount;
  const admins = g.adminCount;
  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm">{nome}</span>
            {g.papel === "dono" && <Badge variant="info">{t("Dono")}</Badge>}
            {g.papel === "admin" && <Badge variant="info">{t("Admin")}</Badge>}
            {g.tipo === "comunidade" && <Badge variant="neutral">{t("Comunidade")}</Badge>}
            {g.tipo === "grupo_da_comunidade" && <Badge variant="neutral">{t("Grupo de comunidade")}</Badge>}
            {g.isAnnounce === true && <Badge variant="neutral">{t("Só admins enviam")}</Badge>}
          </div>
          {typeof membros === "number" && (
            <p className="text-xs text-muted-foreground">
              {membros} {t("membros")} · {admins ?? 0} {t("admins")}
            </p>
          )}
          {!g.presente && (
            <p className="text-xs text-muted-foreground">
              {t("O número saiu deste grupo. Desligue a chave se não precisar mais dela.")}
            </p>
          )}
        </div>
        <Switch aria-label={nome} checked={g.enabled} disabled={bloqueado} onCheckedChange={(v) => onLigar(g, v)} />
      </div>
      {/* #2729 — a segunda chave, a da IA, só em grupo LIGADO: fora da fila não há
          mensagem nossa na inbox, logo não há nada para a IA responder — uma chave
          que não liga nada seria mentira na tela (e o servidor recusa com 409
          `grupo_desligado`). O texto fica ao lado para as duas chaves da linha não
          parecerem uma só. */}
      {g.enabled && (
        <div className="flex items-center gap-2 pl-1">
          <select
            aria-label={t("Permitir que a IA responda neste grupo")}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={g.iaModo ?? (g.iaResponde === true ? "todas" : "off")}
            disabled={bloqueado}
            onChange={(e) => onIa(g, e.target.value as "off" | "chamada" | "todas")}
          >
            <option value="off">{t("Desligada")}</option>
            <option value="chamada">{t("Só quando chamada")}</option>
            <option value="todas">{t("Toda mensagem")}</option>
          </select>
          <span className="text-xs text-muted-foreground">
            {t("Só quando chamada: a IA responde quem marcar o número com @ ou responder uma mensagem dele.")}
          </span>
        </div>
      )}
    </li>
  );
}
