"use client";
import { useT } from "@/hooks/i18n/useT";
import type { Message } from "@/lib/types/messaging";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { nomeOriginalDoDocumento } from "./media-utils";
import { StickerMedia } from "./StickerMedia";
import { MediaUnavailable } from "./MediaUnavailable";
import { VideoMedia } from "./VideoMedia";
import { mediaSrc } from "./media-utils";

/**
 * Dispatcher de mídia por message.type (Onda 1). Tipo com mídia mas sem
 * renderer dedicado (location/contact futuros) cai no DocumentCard —
 * sempre dá pro atendente baixar o arquivo.
 */
export function MediaRenderer({ message }: { message: Message }) {
  const t = useT();
  const isOutbound = message.direction === "outbound";
  // O worker desistiu (o ponteiro do canal venceu antes do download): diz isso
  // e NÃO pede a rota — ela tentaria o mesmo ponteiro morto a cada render.
  if (!message.media_storage_path && message.metadata?.media_status === "failed") {
    return <MediaUnavailable kind="Mídia" expirada className="h-24 w-56" />;
  }
  // A URL assinada que a lista entregou em lote: sem ela, cada mídia faria a
  // própria ida a /messages/{id}/media ao montar. O documento continua na rota:
  // ele só baixa no clique, que pode vir horas depois, com a URL já vencida.
  const src = message.media_signed_url ?? undefined;
  // Se a URL assinada vencer (aba aberta além da validade), a mídia tenta a rota
  // uma vez, que assina de novo, em vez de dizer "indisponível".
  const srcReserva = src ? mediaSrc(message.id) : undefined;
  switch (message.type) {
    case "image":
      return (
        <ImageMedia
          messageId={message.id}
          alt={t("Imagem recebida")}
          src={src}
          srcReserva={srcReserva}
          srcMiniatura={message.media_thumb_signed_url ?? undefined}
        />
      );
    case "sticker":
      return <StickerMedia messageId={message.id} src={src} srcReserva={srcReserva} />;
    case "audio":
      return <AudioPlayer messageId={message.id} isOutbound={isOutbound} src={src} srcReserva={srcReserva} mime={message.media_mime} />;
    case "video":
      return <VideoMedia messageId={message.id} src={src} srcReserva={srcReserva} />;
    case "contact":
      return null;
    default:
      return (
        <DocumentCard
          messageId={message.id}
          mime={message.media_mime}
          sizeBytes={message.media_size_bytes}
          storagePath={message.media_storage_path}
          isOutbound={isOutbound}
          nome={nomeOriginalDoDocumento(message.metadata) ?? nomeDoArquivo(message.metadata)}
        />
      );
  }
}

/** O nome do arquivo, quando o canal o mandou (`metadata.filename`/`file_name`); só texto curto. */
function nomeDoArquivo(metadata: Record<string, unknown> | null | undefined): string | null {
  const bruto = metadata?.filename ?? metadata?.file_name;
  return typeof bruto === "string" && bruto.trim() ? bruto.trim().slice(0, 120) : null;
}
