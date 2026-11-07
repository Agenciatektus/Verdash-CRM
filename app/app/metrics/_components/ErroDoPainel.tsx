"use client";

import { Aviso } from "@/components/ui/aviso";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { ReactNode } from "react";

/**
 * A falha de UM painel, dentro dele: aviso crítico com "Tentar de novo". Seção
 * ausente lê-se como "não há dado"; um painel quebrado não derruba os outros.
 */
export function ErroDoPainel({
  mensagem,
  aoTentar,
  recarregando = false,
}: {
  /** Já traduzida por quem chama: t() aqui receberia parâmetro livre (cerca de i18n). */
  mensagem: ReactNode;
  aoTentar: () => void;
  recarregando?: boolean;
}) {
  const t = useT();
  return (
    <Aviso
      tom="crit"
      acao={
        <Button variant="outline" size="sm" loading={recarregando} onClick={aoTentar}>
          {t("Tentar de novo")}
        </Button>
      }
    >
      {mensagem}
    </Aviso>
  );
}
