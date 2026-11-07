"use client";

import { ContactCard } from "@/components/inbox/media/ContactCard";
import { LocationCard } from "@/components/inbox/media/LocationCard";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MediaUnavailable } from "@/components/inbox/media/MediaUnavailable";
import { useT } from "@/hooks/i18n/useT";
import type { Localizacao } from "@/lib/messaging/localizacao";
import { DERIVACAO_TERMINADA } from "@/lib/messaging/media/derivable";
import { transcricaoDoAudio } from "@/lib/messaging/media/texto-derivado";
import type { Message } from "@/lib/types/messaging";
import { Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AvisoSemConteudo } from "./AvisoSemConteudo";
import { TranscricaoDoAudio } from "./TranscricaoDoAudio";

/**
 * O espaçador que reserva o lugar da hora no fim da última linha (ver
 * `larguraDaMeta`). Invisível e fora da árvore de acessibilidade.
 */
function Espacador({ largura }: { largura: string | null }) {
  if (!largura) return null;
  return <span aria-hidden className={cn("inline-block h-px align-baseline", largura)} />;
}

/**
 * O texto da mensagem. O `whitespace-pre-wrap` mora AQUI, no parágrafo, e não
 * no contêiner da bolha: no contêiner ele transformava a indentação do JSX em
 * espaço visível e empurrava a mídia e o cartão para baixo, que é parte do
 * "os balões ficaram bem ruins" que esta fase conserta.
 */
function Texto({ children, className, espaco }: { children: React.ReactNode; className?: string; espaco: string | null }) {
  return (
    <p className={cn("whitespace-pre-wrap wrap-anywhere", className)}>
      {children}
      <Espacador largura={espaco} />
    </p>
  );
}

interface Props {
  message: Message;
  apagada: boolean;
  ocultaNoCrm: boolean;
  localizacao: Localizacao | null;
  /** Largura do espaçador da hora, quando ela flutua no fim do texto. */
  espaco: string | null;
  /** A bolha é só a imagem: a mídia encosta na borda, sem margem negativa. */
  soMidia: boolean;
  /** Relógio da bolha (ms), para o aviso "Transcrevendo…" (upstream #2133). */
  agora?: number;
}

/** Depois disto sem status, o worker não vai mais transcrever: o aviso some (upstream #2133). */
const TETO_AVISO_TRANSCREVENDO_MS = 10 * 60_000;

/** Tudo o que a bolha mostra entre o nome e a hora, fora do modo de edição. */
export function CorpoDaBolha({ message, apagada, ocultaNoCrm, localizacao, espaco, soMidia, agora }: Props) {
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  // Anexo que chegou SEM ponteiro guardado (as mensagens do Instagram de antes
  // da #13 da auditoria): a tela mostrava nada. Agora diz que expirou.
  const anexoSemArquivo = !hasMedia && message.metadata?.instagram_tem_anexo === true;
  const anexoTemporario = message.metadata?.instagram_anexo_temporario === true;
  const linksDoInstagram = linksDoInstagramDe(message.metadata);
  const temAnexosExtras = Array.isArray(message.metadata?.instagram_anexos_extras)
    && (message.metadata.instagram_anexos_extras as unknown[]).length > 0;
  const isContact = message.type === "contact";
  // A retenção marcou `metadata.media_status = 'expired'` (upstream 0557, #1534)
  // e a poda anulou os dois campos de mídia: sem isto a bolha perdia o render.
  // O aviso leva os DIAS que a organização configurou, quando a 0557 os gravou.
  const mediaExpirada = !hasMedia && message.metadata?.media_status === "expired";
  const diasDaRetencao =
    typeof message.metadata?.media_retention_days === "number" ? message.metadata.media_retention_days : null;
  const avisoDeExpiracao =
    diasDaRetencao !== null
      ? t("Mídia apagada pela política de retenção ({n} dias)").replace("{n}", String(diasDaRetencao))
      : t("Mídia apagada pela política de retenção.");
  const transcricao = transcricaoDoAudio(message);
  // Upstream #2133: o worker não grava "pending" — a linha nasce com status null
  // e só ele muda. Sem status terminal, áudio recebido (ou enviado pelo
  // celular) e recente ainda vai ganhar texto: a bolha avisa, pela idade em
  // `created_at` (nunca `sent_at`, que no inbound é o relógio do aparelho).
  const transcrevendo =
    message.type === "audio" &&
    !transcricao &&
    agora !== undefined &&
    !DERIVACAO_TERMINADA.has(message.media_derived_status ?? "") &&
    (message.direction === "inbound" || message.sent_via === "external_device") &&
    agora - new Date(message.created_at).getTime() < TETO_AVISO_TRANSCREVENDO_MS;
  // Nada a desenhar: sem texto, mídia, cartão, pino nem aviso de anexo. A bolha
  // nunca fica vazia — mostra que há uma mensagem e onde vê-la.
  const semConteudo = !hasMedia && !message.body && !anexoSemArquivo && !temAnexosExtras
    && linksDoInstagram.length === 0 && !isContact && !localizacao && !mediaExpirada;

  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  if (apagada) {
    const comCopiaInterna = isOutbound && Boolean(message.body);
    return (
      <div className="space-y-1">
        <Texto className="italic" espaco={comCopiaInterna ? null : espaco}>
          <Trash size={13} aria-hidden className="mr-1 inline-block align-text-bottom" />
          {t("Esta mensagem foi apagada")}
        </Texto>
        {/* O WhatsApp revoga o envio; o CRM conserva o corpo para auditoria
            interna. Não revelamos texto de uma mensagem apagada pelo cliente. */}
        {comCopiaInterna && (
          <div className="border-t border-current/20 pt-1 not-italic text-text">
            <p className="text-[0.6875rem] text-text-subtle">{t("Visível só aqui no CRM")}</p>
            <Texto espaco={null}>{message.body}</Texto>
          </div>
        )}
      </div>
    );
  }

  if (ocultaNoCrm) {
    return <Texto className="italic text-text-subtle" espaco={espaco}>{t("Mensagem ocultada no CRM")}</Texto>;
  }

  return (
    <>
      {hasMedia && (
        // Com legenda, a mídia encosta quase na borda (margem negativa menor
        // que o respiro da bolha) e o texto vem embaixo: é a leitura de foto
        // com legenda, e não a de um anexo solto dentro de uma caixa.
        // `.media` do quadro: com legenda, encosta na borda (-3 -7 7 -8) e o texto vem embaixo.
        <div className={cn(!soMidia && (message.type === "image" || message.type === "video") && "-ml-2 -mr-1.75 -mt-0.75", message.body && "mb-1.75")}>
          <MediaRenderer message={message} />
          {/* Só no corpo normal: apagada e ocultada saem antes, e a transcrição
              de uma mensagem apagada seria o mesmo texto por outro caminho. */}
          {transcricao && <TranscricaoDoAudio texto={transcricao} />}
          {transcrevendo && (
            <p data-testid="transcricao-de-audio-pendente" className="mt-1 text-xs text-text-subtle">
              {t("Transcrevendo…")}
            </p>
          )}
        </div>
      )}

      {mediaExpirada && (
        <div className={cn(message.body && "mb-1.5")}>
          <MediaUnavailable detalhe={avisoDeExpiracao} />
        </div>
      )}

      {anexoSemArquivo && (
        <div className={cn(message.body && "mb-1.5")}>
          {anexoTemporario ? (
            <p className="text-xs italic text-text-subtle">{t("Mídia temporária: o CRM não guarda")}</p>
          ) : (
            <MediaUnavailable kind="Anexo" expirada />
          )}
        </div>
      )}

      {temAnexosExtras && (
        <p className="mb-1 text-xs italic text-text-subtle">{t("Esta mensagem tinha mais anexos no Instagram.")}</p>
      )}

      {linksDoInstagram.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 block text-xs underline underline-offset-2"
        >
          {link.titulo ? `${t("Ver no Instagram")}: ${link.titulo}` : t("Ver no Instagram")}
        </a>
      ))}

      {isContact && !hasMedia && !mediaExpirada && (
        <div className={cn(message.body && "mb-1.5")}>
          <ContactCard message={message} />
        </div>
      )}

      {/* Pino com coordenadas: o cartão substitui o corpo, que é só o mesmo link em texto. */}
      {localizacao && <LocationCard localizacao={localizacao} />}

      {message.body && !isContact && !localizacao && <Texto espaco={espaco}>{message.body}</Texto>}

      {semConteudo && <AvisoSemConteudo message={message} />}
    </>
  );
}

/**
 * Permalinks de post/reel que a ingestão do Instagram guardou no metadata.
 * Só `https://(www.)instagram.com`: o metadata é dado de fora, e um link
 * arbitrário aqui viraria phishing na tela do atendente.
 */
function linksDoInstagramDe(metadata: Record<string, unknown> | null | undefined): Array<{ url: string; titulo: string | null }> {
  const brutos = metadata?.instagram_links;
  if (!Array.isArray(brutos)) return [];
  const links: Array<{ url: string; titulo: string | null }> = [];
  for (const b of brutos.slice(0, 10)) {
    const url = typeof (b as { url?: unknown })?.url === "string" ? (b as { url: string }).url : "";
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(u.hostname)) continue;
    } catch {
      continue;
    }
    const titulo = (b as { titulo?: unknown }).titulo;
    links.push({ url, titulo: typeof titulo === "string" ? titulo.slice(0, 120) : null });
  }
  return links;
}
