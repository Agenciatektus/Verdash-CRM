"use client";
import { useT } from "@/hooks/i18n/useT";
import { DownloadSimple } from "@/lib/ui/icons";

import { extensaoDoDocumento, formatBytes, mediaDownloadSrc } from "./media-utils";

interface Props {
  messageId: string;
  mime: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  /** Mantido por compatibilidade: o cartão usa as mesmas cores nos dois lados (visual v2). */
  isOutbound?: boolean;
  /** Nome ORIGINAL do documento quando o payload o trouxer (#2613). Ausente/vazio → `Documento XLSX`. */
  fileName?: string | null;
  /** Fonte alternativa para mídia de NOTA interna (#1863, F3) — ver ImageMedia. */
  src?: string;
  /** Nome ORIGINAL do documento (`media_filename`, #2613 do upstream). */
  fileName?: string | null;
}

/**
 * O `.doc` do quadro DS: ícone do tipo (sigla em crit sobre crit-bg), nome do
 * arquivo, tipo e tamanho, e o botão redondo de baixar. O nome vem do
 * `filename` que o canal mandou, quando veio; sem ele, a sigla do tipo. O
 * número de páginas NÃO é guardado pela ingestão, então não aparece.
 */
export function DocumentCard({ messageId, mime, sizeBytes, storagePath, src, nome, fileName }: Props & { nome?: string | null }) {
  const t = useT();
  const extensao = extensaoDoDocumento(mime, storagePath);
  const label = extensao ?? t("Documento");
  // Sem nome, `Documento XLSX` e não `XLSX`: a extensão sozinha se lê como título (#2613).
  const titulo =
    nome?.trim() || fileName?.trim() || (extensao ? t("Documento {ext}").replace("{ext}", extensao) : t("Documento"));
  const href = src ?? mediaDownloadSrc(messageId);
  return (
    <div className="-ml-1.5 -mr-1.25 -mt-0.5 mb-1 flex w-67.5 max-w-full items-center gap-3 rounded-xl bg-tint p-2">
      <span
        aria-hidden
        className="grid h-11 w-9 shrink-0 place-items-center rounded-[7px] bg-error-bg text-[10.5px] font-extrabold tracking-[0.02em] text-error-fg"
      >
        {label.slice(0, 4)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-bold" title={titulo}>{titulo}</span>
        <span className="block text-meta font-normal text-text-subtle">
          {label}, {formatBytes(sizeBytes)}
        </span>
      </span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`${t("Baixar")} ${titulo} (${formatBytes(sizeBytes)})`}
        className="grid size-8.5 shrink-0 place-items-center rounded-full border border-border-strong text-text-muted transition-colors hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <DownloadSimple size={16} aria-hidden />
      </a>
    </div>
  );
}
