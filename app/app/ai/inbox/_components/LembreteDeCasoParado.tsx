"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  atualizarLembreteDeCasoParado,
  type LembreteDeCasoParado as Lembrete,
} from "@/app/actions/settings/atualizarLembreteDeCasoParado";
import { Button } from "@/components/ui/button";
import { Escolha } from "@/components/ui/escolha";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

const INTERVALOS_EM_HORAS = [1, 2, 4, 8, 12, 24, 48, 72];
const TETOS = [1, 2, 3, 4, 5, 10];

/** O valor gravado entra na lista mesmo fora das opções: o select nunca mente sobre o que está salvo. */
function comOGravado(opcoes: number[], gravado: number): number[] {
  return opcoes.includes(gravado) ? opcoes : [...opcoes, gravado].sort((a, b) => a - b);
}

/**
 * O lembrete de caso parado da organização (migration 0766), na própria
 * Central — é nela que o lembrete aparece. Só quem administra vê o cartão; a
 * página decide isso com o mesmo `podeAdministrarEmpresa` da action.
 *
 * O padrão (ligado, a cada 24 horas, três avisos por espera) é o comportamento
 * de antes desta tela existir.
 */
export function LembreteDeCasoParado({ inicial }: { inicial: Lembrete }) {
  const t = useT();
  const [valor, setValor] = useState<Lembrete>(inicial);
  const [isPending, startTransition] = useTransition();

  function intervaloEmPalavras(horas: number): string {
    if (horas % 24 === 0) {
      const dias = horas / 24;
      return dias === 1 ? t("1 dia") : t("{n} dias").replace("{n}", String(dias));
    }
    return horas === 1 ? t("1 hora") : t("{n} horas").replace("{n}", String(horas));
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await atualizarLembreteDeCasoParado(valor);
      if (resultado.ok) {
        toast.success(t("Lembrete de caso parado salvo."));
        return;
      }
      if (resultado.error === "mfa_required") return irAoDesafioDeMfa();
      toast.error(t("Não foi possível salvar o lembrete de caso parado."));
    });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="lembrete-de-caso-parado">
      <h2 className="text-sm font-medium">{t("Lembrete de caso parado")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Quando um caso espera uma decisão da equipe, esta Central volta a avisar. O relógio começa quando o caso chega à equipe e recomeça quando o cliente responde.",
        )}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={valor.ligado}
          onChange={(e) => setValor({ ...valor, ligado: e.target.checked })}
          className="mt-1"
        />
        <span>{t("Lembrar a equipe dos casos parados")}</span>
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm max-md:w-full">
          {t("Lembrar a cada")}{" "}
          <Escolha
            className="ml-2 w-auto min-w-28 max-md:mt-1 max-md:ml-0 max-md:w-full"
            value={valor.intervaloHoras}
            disabled={!valor.ligado}
            onValueChange={(v) => setValor({ ...valor, intervaloHoras: Number(v) })}
          >
            {comOGravado(INTERVALOS_EM_HORAS, valor.intervaloHoras).map((h) => (
              <option key={h} value={h}>
                {intervaloEmPalavras(h)}
              </option>
            ))}
          </Escolha>
        </label>
        <label className="text-sm max-md:w-full">
          {t("Avisos por espera")}{" "}
          <Escolha
            className="ml-2 w-auto min-w-20 max-md:mt-1 max-md:ml-0 max-md:w-full"
            value={valor.teto}
            disabled={!valor.ligado}
            onValueChange={(v) => setValor({ ...valor, teto: Number(v) })}
          >
            {comOGravado(TETOS, valor.teto).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Escolha>
        </label>
      </div>
      <Button type="button" size="sm" disabled={isPending} onClick={salvar}>
        {t("Salvar lembrete")}
      </Button>
    </Card>
  );
}
