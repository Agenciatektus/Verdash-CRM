"use client";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { ImageIcon } from "@/lib/ui/icons";

/**
 * Fallback compartilhado quando a mídia não carrega (expirada/removida).
 *
 * `expirada`: o ponteiro do canal venceu antes de o CRM guardar os bytes (o
 * anexo do Instagram vale pouco tempo). Dizer "expirada" é a verdade e poupa o
 * atendente de recarregar a tela esperando que apareça.
 *
 * `detalhe` é o motivo ESCRITO, já traduzido por quem chama, e aparece na tela
 * no lugar do "Mídia indisponível" genérico (#3756).
 */
export function MediaUnavailable({
  kind,
  detalhe,
  className,
  expirada = false,
}: {
  kind?: string;
  detalhe?: string;
  className?: string;
  expirada?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-lg bg-background/40 text-muted-foreground",
        detalhe ? "px-3 py-2 text-center" : null,
        className || (detalhe ? "min-h-24 w-56" : "h-24 w-56"),
      )}
    >
      <ImageIcon size={20} weight="duotone" aria-hidden />
      <span className="text-xs">{detalhe ?? (expirada ? t("Mídia expirada") : t("Mídia indisponível"))}</span>
      {!detalhe && kind && <span className="sr-only">{t(kind)}</span>}
    </div>
  );
}
