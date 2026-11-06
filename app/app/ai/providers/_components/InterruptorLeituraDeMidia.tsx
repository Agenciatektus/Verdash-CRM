"use client";

/**
 * O interruptor POR EMPRESA da leitura de mídia pela IA.
 *
 * Salva no clique, mesmo desenho de `app/app/settings/automacoes/_interruptor.tsx`.
 * O que a chave faz (e por que o padrão é LIGADA) está em
 * `lib/messaging/media/leitura-da-org.ts`.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirLeituraDeMidiaDaEmpresa } from "@/app/actions/settings/definirLeituraDeMidiaDaEmpresa";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/traducao";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um gerente ou administrador da organização pode mudar esta configuração.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function InterruptorLeituraDeMidia({ ligado, idioma }: { ligado: boolean; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligado);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirLeituraDeMidiaDaEmpresa(novo);
      if (r.ok) {
        toast.success(t("Configuração salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="leitura_de_midia_empresa">{t("A IA lê a mídia que o cliente envia")}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Transcreve áudios e descreve imagens, documentos e vídeos para o agente entender o que chegou. Desligado, nenhuma mídia é lida pela IA e não há gasto com isso: o agente só sabe que chegou um arquivo. A mídia que a própria empresa envia nunca é lida. O padrão é ligado.",
            )}
          </p>
        </div>
        <Switch
          id="leitura_de_midia_empresa"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>
    </div>
  );
}
