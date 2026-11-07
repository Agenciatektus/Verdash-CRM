"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AcaoDeVocabulario } from "@/lib/schemas/tags";
import { DotsThree } from "@/lib/ui/icons";

/**
 * O menu ⋯ de uma linha: Cor, Renomear, Juntar e Excluir num botão só (os quatro
 * lado a lado empilhavam no tablet e a tabela passava da borda). A `cliente`
 * reservada pelo sistema só aceita Cor, pelo mesmo motivo de antes.
 */
export function MenuDaLinha({
  tag,
  reservada,
  t,
  aoEscolher,
}: {
  tag: string;
  reservada: boolean;
  t: (texto: string) => string;
  aoEscolher: (acao: AcaoDeVocabulario) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="mb:min-h-(--mb-alvo) mb:min-w-(--mb-alvo)" aria-label={`${t("Ações da etiqueta")} ${tag}`}>
          <DotsThree size={18} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => aoEscolher("definir_cor")}>{t("Cor")}</DropdownMenuItem>
        {!reservada && (
          <>
            <DropdownMenuItem onSelect={() => aoEscolher("renomear")}>{t("Renomear")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => aoEscolher("juntar")}>{t("Juntar")}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => aoEscolher("excluir")}>
              {t("Excluir")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
