"use client";

import { useT } from "@/hooks/i18n/useT";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Chip } from "@/components/ui/chip";
import { Clock } from "@/lib/ui/icons";

/**
 * "Horários livres": a grade mostra a disponibilidade de UM serviço, e a escolha
 * dele mora aqui, num botão que abre a lista por serviço. Eram chips soltos no
 * topo da grade (25 numa organização cheia); só existe com 2+ serviços.
 */
export function HorariosLivresPorServico({
  tipos,
  tipoId,
  onEscolher,
}: {
  tipos: Array<{ id: string; nome: string; duracaoMin: number }>;
  tipoId: string | null;
  onEscolher: (id: string) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = React.useState(false);
  if (tipos.length < 2) return null;
  const ativo = tipos.find((o) => o.id === tipoId);
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="horarios-livres">
          <Clock size={16} aria-hidden />
          <span>
            {t("Horários livres")}
            {ativo ? `: ${ativo.nome}` : ""}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        folhaNoCelular
        data-testid="tipo-da-grade"
        className="flex max-h-80 w-80 flex-col gap-2 overflow-y-auto"
      >
        <p className="text-sm font-medium">{t("Horários livres de")}</p>
        <div className="flex flex-wrap gap-1.5">
          {tipos.map((opcao) => (
            <Chip
              key={opcao.id}
              data-testid={`tipo-da-grade-${opcao.id}`}
              ligado={opcao.id === tipoId}
              onClick={() => {
                onEscolher(opcao.id);
                setAberto(false);
              }}
            >
              {opcao.nome}
            </Chip>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
