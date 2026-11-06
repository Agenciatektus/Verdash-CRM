"use client";

import { useContext, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { AceiteDoPadrao, corpoComAceiteDoPadrao } from "./jev-dados";

/** Um PATCH na rota do Jev, com o aviso de volta e a releitura do cartão. */
export function useMudarOJev(recarregar: () => Promise<void>) {
  const t = useT();
  const [enviando, setEnviando] = useState(false);

  const aceiteDoPadrao = useContext(AceiteDoPadrao);

  async function mudar(corpoPedido: Record<string, unknown>, sucesso: string) {
    // Empresa no padrão da plataforma: qualquer mudança (menos desligar) é ela
    // assumindo o Jev, e a rota exige o aceite real. Sem o checkbox marcado, nada sai.
    const corpo = corpoComAceiteDoPadrao(corpoPedido, aceiteDoPadrao);
    if (corpo === null) {
      toast.error(t("Marque o aceite do envio das mensagens à TypeSafe AI antes de mudar o Jev."));
      return;
    }
    setEnviando(true);
    try {
      const res = await fetch("/api/v1/ai/jev", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        // A recusa da rota já vem escrita para leigo e no idioma de quem pediu.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      toast.success(sucesso);
      await recarregar();
    } catch {
      toast.error(t("não consegui falar com o servidor"));
    } finally {
      setEnviando(false);
    }
  }

  return { mudar, enviando };
}
