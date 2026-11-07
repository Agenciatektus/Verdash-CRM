"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/traducao";
import { Plus } from "@/lib/ui/icons";

import { AcrescentarEtiqueta } from "./_sugestoes";

/** "Nova etiqueta" no cabeçalho da página: o formulário de acrescentar, num diálogo. */
export function NovaEtiqueta({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const [aberto, setAberto] = useState(false);
  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus size={14} aria-hidden className="mr-1" />
          {t("Nova etiqueta")}
        </Button>
      </DialogTrigger>
      {/* Sem descrição: a frase de escopo já está no formulário. */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("Nova etiqueta")}</DialogTitle>
        </DialogHeader>
        <AcrescentarEtiqueta idioma={idioma} aoConcluir={() => setAberto(false)} />
      </DialogContent>
    </Dialog>
  );
}
