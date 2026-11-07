"use client";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { samePhone } from "@/lib/channels/phone-variants";
import type { ParticipanteDoGrupo } from "@/lib/grupos/acoes";
import { formatarTelefone, lerTelefones } from "@/lib/grupos/painel";
import { DotsThree } from "@/lib/ui/icons";

type Operacao = "add" | "remove" | "promote" | "demote";

export function ParticipantesDoGrupo({
  participantes,
  total,
  meuTelefone,
  admin,
  ocupado,
  onOperar,
}: {
  participantes: ParticipanteDoGrupo[];
  total: number;
  meuTelefone: string | null;
  /** Mostra o menu por participante e o campo de adicionar. */
  admin: boolean;
  ocupado: boolean;
  onOperar: (operacao: Operacao, telefones: string[]) => void;
}) {
  const t = useT();
  const [novos, setNovos] = useState("");
  const telefones = lerTelefones(novos);
  return (
    <section id="participantes-do-grupo" aria-label={t("Participantes")} className="min-w-0">
      <h3 className="mb-2 text-sm font-semibold text-text">
        {t("Participantes")} ({total})
      </h3>
      {admin && (
        <div className="mb-3 space-y-2">
          <Textarea
            value={novos}
            onChange={(e) => setNovos(e.target.value)}
            rows={2}
            aria-label={t("Adicionar participantes")}
            placeholder={t("Telefones com DDI e DDD, separados por vírgula ou linha (até 20)")}
          />
          <Button
            type="button"
            size="sm"
            disabled={ocupado || telefones.length === 0 || 20 < telefones.length}
            onClick={() => {
              onOperar("add", telefones);
              setNovos("");
            }}
          >
            {t("Adicionar participantes")}
          </Button>
        </div>
      )}
      <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-xl border border-border">
        {participantes.map((p, i) => {
          const voce = !!meuTelefone && !!p.telefone && samePhone(p.telefone, meuTelefone);
          return (
            <li key={p.telefone ?? i} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-text">{p.telefone ? formatarTelefone(p.telefone) : t("Sem telefone")}</div>
                {p.nome && <div className="truncate text-xs text-text-muted">{p.nome}</div>}
              </div>
              {p.dono && <Badge variant="neutral">{t("Super Admin")}</Badge>}
              {p.admin && !p.dono && <Badge variant="neutral">{t("Admin")}</Badge>}
              {voce && <Badge variant="neutral">{t("Você")}</Badge>}
              {admin && p.telefone && !voce && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" size="sm" variant="ghost" className="w-8 px-0" disabled={ocupado} aria-label={`${t("Ações do participante")} ${formatarTelefone(p.telefone)}`}>
                      <DotsThree size={16} weight="bold" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {p.admin ? (
                      <DropdownMenuItem onSelect={() => onOperar("demote", [p.telefone!])}>{t("Rebaixar")}</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => onOperar("promote", [p.telefone!])}>{t("Promover")}</DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="text-error-fg" onSelect={() => onOperar("remove", [p.telefone!])}>
                      {t("Remover")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
