"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Textarea } from "@/components/ui/textarea";
import type { EtapaDoFunil } from "@/hooks/pipelines/useAgentMapping";
import type { PatchDeEtapa } from "@/hooks/pipelines/useStages";
import { useT } from "@/hooks/i18n/useT";
import {
  dividirFrases,
  MAX_CARACTERES_DA_FRASE,
  MAX_FRASES_POR_ETAPA,
  MIN_CARACTERES_DA_FRASE,
} from "@/lib/leads/gatilho-por-frase";

/**
 * "Frases que levam o negócio para esta etapa" (migration 9092): até 5, uma por linha.
 * Vale só para a mensagem que a EQUIPE envia; o que o cliente escreve nunca move o
 * card. Salva ao sair do campo, e só se mudou.
 */
export function FrasesDaEtapa({
  etapa,
  ocupado,
  aplicar,
}: {
  etapa: EtapaDoFunil;
  ocupado: boolean;
  aplicar: (etapaId: string, patch: PatchDeEtapa) => void;
}) {
  const t = useT();
  const gravadas = etapa.gatilho_frases ?? [];
  const [rascunho, setRascunho] = useState(gravadas.join("\n"));

  function confirmar() {
    const frases = dividirFrases(rascunho);
    if (frases.join("\n") === gravadas.join("\n")) return;
    if (frases.length > MAX_FRASES_POR_ETAPA) {
      toast.error(t("Cada etapa aceita até 5 frases."));
      return;
    }
    if (frases.some((f) => f.length < MIN_CARACTERES_DA_FRASE || f.length > MAX_CARACTERES_DA_FRASE)) {
      toast.error(t("Cada frase precisa ter de 3 a 120 caracteres."));
      return;
    }
    aplicar(etapa.id, { gatilho_frases: frases });
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-text-muted">
      <label className="font-medium" htmlFor={`frases-${etapa.id}`}>
        {t("Frases que levam o negócio para esta etapa (uma por linha, até 5)")}
      </label>
      <Textarea
        id={`frases-${etapa.id}`}
        value={rascunho}
        onChange={(e) => setRascunho(e.target.value)}
        onBlur={confirmar}
        disabled={ocupado}
        rows={2}
        placeholder={t("pedido confirmado")}
        data-testid={`frases-${etapa.id}`}
      />
      <span>
        {t(
          "Vale só para a mensagem que a sua equipe envia. Não diferencia maiúscula nem acento, e o negócio só avança de etapa.",
        )}
      </span>
    </div>
  );
}
