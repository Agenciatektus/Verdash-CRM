"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Note as NoteIcon, Trash } from "@/lib/ui/icons";
import type { Note } from "@/lib/types/messaging";
import { cn } from "@/lib/utils";

import { classesDaBolha, classesDaLinha, classesDoAutor, COLUNA_DA_FALA } from "./bolha/estilo";

import { AudioPlayer } from "@/components/inbox/media/AudioPlayer";
import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import { ImageMedia } from "@/components/inbox/media/ImageMedia";
import { MediaUnavailable } from "@/components/inbox/media/MediaUnavailable";
import { VideoMedia } from "@/components/inbox/media/VideoMedia";
import { kindFromMime } from "@/lib/messaging/media/upload-validation";
import { partesDoCorpo } from "@/lib/notifications/mentions";

/**
 * O anexo da nota interna (#1863, F3).
 *
 * A URL é a da ROTA DA NOTA, não a de mensagem: `/notes/{id}/media` devolve um
 * 302 para signed URL de 60 s no bucket `internal-media`. Um anexo de nota não
 * tem `messages.id`, e servir pela rota de mensagem seria servir pelo caminho
 * que leva ao cliente.
 *
 * O tipo não vem do banco: `conversation_notes` guarda só o mime GRAVADO, e
 * `kindFromMime` é o MESMO corte que decidiu se o upload era aceito — o que
 * renderiza é necessariamente o que passou pela validação. Mime que a função não
 * conhece cai em documento, o fallback que sempre dá para baixar o arquivo.
 *
 * ─── O anexo que o PRAZO apagou (#3756) ──────────────────────────────────────
 *
 * A retenção por idade da 0572 zera os três ponteiros da nota, e até aqui o
 * "sem caminho" era lido como "nota só de texto": o operador lia a nota e não
 * sabia que ali havia um arquivo. A mensagem já tinha o seu aviso desde a 0557;
 * a nota passa a ter o equivalente, no lugar do anexo e no MESMO desenho — o
 * `MediaUnavailable` que a bolha usa (`MessageBubble`, ramo `mediaExpirada`),
 * não um segundo cartão inventado aqui: dois avisos para a mesma política
 * ensinariam dois vocabulários. A marca (`media_expired_at`, com os dias que a
 * política tinha no instante da remoção) é o que distingue os dois casos: sem
 * ela, nota apagada e nota que nunca teve anexo são a mesma coisa.
 */
export function NoteMedia({ note }: { note: Note }) {
  const t = useT();
  if (!note.media_storage_path) {
    // O aviso carrega os DIAS, como o da mensagem: "por política" sem o número
    // é promessa sem medida. Nota marcada por uma versão que não gravava os
    // dias (ou marca sem valor) cai no texto genérico, nunca em erro.
    if (!note.media_expired_at) return null; // nota só de texto
    const aviso =
      typeof note.media_retention_days === "number"
        ? t("Anexo da nota apagado pela política de retenção ({n} dias)").replace(
            "{n}",
            String(note.media_retention_days),
          )
        : t("Anexo da nota apagado pela política de retenção.");
    return (
      <div className="mt-1.5">
        <MediaUnavailable detalhe={aviso} />
      </div>
    );
  }
  const src = `/api/v1/conversations/${note.conversation_id}/notes/${note.id}/media`;
  switch (kindFromMime(note.media_mime ?? "") ?? "document") {
    case "image":
      return (
        <div className="mt-1.5">
          <ImageMedia messageId={note.id} src={src} alt={t("Imagem da nota interna")} />
        </div>
      );
    case "video":
      return (
        <div className="mt-1.5">
          <VideoMedia messageId={note.id} src={src} />
        </div>
      );
    case "audio":
      return (
        <div className="mt-1.5">
          <AudioPlayer messageId={note.id} src={src} isOutbound={false} />
        </div>
      );
    default:
      return (
        <div className="mt-1.5">
          <DocumentCard
            messageId={note.id}
            src={src}
            mime={note.media_mime}
            sizeBytes={note.media_size_bytes}
            storagePath={note.media_storage_path}
            isOutbound={false}
          />
        </div>
      );
  }
}

interface Props {
  note: Note;
  onDelete?: () => void;
}

/**
 * Onda 5.2: nota interna inline no thread — nunca vai ao cliente.
 *
 * Visual v2 (fase 3.5): ela fica do NOSSO lado do fio (é o time falando), com
 * borda tracejada no tom de aviso, a mesma linguagem da caixa do composer em
 * "Nota interna". Quem escreveu e o "só o time vê" vão acima da bolha, como o
 * nome das mensagens; a hora fica dentro, no canto, como em toda bolha.
 */
export function NoteCard({ note, onDelete }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const time = format(new Date(note.created_at), "HH:mm", { locale: localeDaData });

  return (
    // A nota é uma fala do nosso lado, à direita, no `.b-note` do quadro DS:
    // fundo de aviso com borda tracejada, e o rótulo "Nota interna de Fulano,
    // só a equipe vê" em cima, na cor de aviso.
    <div className={classesDaLinha({ inicio: true, saida: true })}>
      <div className={cn(COLUNA_DA_FALA, "items-end")}>
        <p className={classesDoAutor("nota")}>
          <NoteIcon size={12} weight="fill" aria-hidden />
          <span>
            {t("Nota interna de")} {note.created_by_name ?? t("Alguém")}
          </span>
          <em className="font-medium not-italic text-text-subtle">{t("só a equipe vê")}</em>
        </p>
        <div
          data-testid="nota-interna"
          className={classesDaBolha({
            tom: "nota",
            saida: true,
            inicio: true,
            falhou: false,
            busca: false,
            temMenu: Boolean(onDelete),
            modoMeta: note.body ? "no-texto" : "abaixo",
          })}
        >
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              // Visível onde não há hover (toque) e no foco do teclado; com mouse,
              // aparece ao passar por cima, sem disputar a leitura da nota.
              className="absolute right-1 top-1 grid size-6 place-items-center rounded-full border border-border bg-surface text-text-muted shadow-xs transition-opacity hover:text-destructive [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t("Excluir nota")}
            >
              <Trash size={12} weight="bold" />
            </button>
          )}
          <NoteMedia note={note} />
          {/* Nota só de anexo (imagem colada sem legenda) chega com `body` vazio:
              renderizar o `<p>` assim mesmo deixaria um parágrafo fantasma de
              altura nula entre o arquivo e a hora. Com texto, a hora flutua no
              fim da última linha (espaçador invisível), como nas mensagens. */}
          {note.body ? (
            <>
              <p className="whitespace-pre-wrap wrap-anywhere">
                {/* A menção gravada pelo autocompletar (#2372) sai como `@Ana Lima`
                    realçada, e não como o token `@[Ana Lima](mencao:…)` do banco. */}
                {partesDoCorpo(note.body).map((parte, i) =>
                  parte.mencao ? (
                    <span key={i} className="rounded-sm bg-warning/25 px-0.5 font-semibold">
                      {`@${parte.mencao.nome}`}
                    </span>
                  ) : (
                    <span key={i}>{parte.texto}</span>
                  ),
                )}
                <span aria-hidden className="inline-block h-px w-10 align-baseline" />
              </p>
              <span className="absolute bottom-1.5 right-2.5 text-[11px] leading-none text-text-subtle">{time}</span>
            </>
          ) : (
            <span className="absolute bottom-1.5 right-2.5 text-[11px] leading-none text-text-subtle">{time}</span>
          )}
        </div>
      </div>
    </div>
  );
}
