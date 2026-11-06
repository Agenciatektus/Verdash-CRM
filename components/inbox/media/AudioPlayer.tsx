"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

import { toast } from "sonner";

import { CircleNotch, Pause, Play } from "@/lib/ui/icons";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";
import { useAoAparecer } from "./useAoAparecer";
import { useFonteComReserva } from "./useFonteComReserva";

const RATES = [1, 1.5, 2] as const;

/**
 * A forma da onda: a mensagem de voz não traz a amostragem, então as alturas
 * saem do id (estáveis entre renders e iguais para quem abrir a mesma conversa).
 * A informação é a do trecho ouvido, não a do volume.
 */
export function ondaDe(id: string, barras = 28): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Array.from({ length: barras }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 2654435761) >>> 0;
    return 30 + (h % 70);
  });
}

/** O que o Safari antigo do iPhone não toca e a rota sabe converter (`?formato=aac`). */
const CONVERTIVEIS = new Set(["audio/ogg", "audio/webm", "audio/opus"]);

function convertivel(mime: string | null | undefined): boolean {
  return CONVERTIVEIS.has((mime ?? "").split(";")[0]!.trim().toLowerCase());
}

/**
 * O aparelho toca este áudio COM CERTEZA? Aí um erro do `<audio>` é a mídia
 * (canal fora, Storage sem assinar), não o formato, e converter não salva.
 * Sem codec no mime a pergunta leva `codecs=opus`: o Chrome diz só "maybe"
 * para `audio/ogg` puro.
 * ponytail: supõe opus, o codec de toda nota de voz; um ogg/vorbis sem codec
 * no mime cairia na conversão à toa (só custa uma ida ao ffmpeg).
 */
function tocaComCerteza(el: HTMLAudioElement, mime: string): boolean {
  const comCodec = mime.includes("codecs") ? mime : `${mime}; codecs="opus"`;
  return el.canPlayType(comCodec) === "probably";
}

/** O que o aparelho toca não muda enquanto a página vive: não há a que se inscrever. */
const semInscricao = () => () => {};

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  messageId: string;
  /**
   * Mantido por compatibilidade: desde o visual v2 (fase 3.5) a bolha enviada
   * é o accent SUAVE com texto escuro, e o player usa as mesmas cores nos dois
   * lados. O branco-sobre-accent de antes sumia na bolha nova.
   */
  isOutbound?: boolean;
  /** Fonte alternativa para mídia de NOTA interna (#1863, F3) — ver ImageMedia. */
  src?: string;
  /** Para onde ir se `src` falhar (a URL assinada venceu): ver `useFonteComReserva`. */
  srcReserva?: string;
  /**
   * O mime gravado na mensagem. Com ele o player pergunta ao aparelho se toca
   * (`canPlayType`) e, se não, converte sob demanda (F2). Sem mime (nota
   * interna) não há conversão: a rota de nota não tem `?formato`.
   */
  mime?: string | null;
}

/** Player de voz estilo WhatsApp: play/pause, progresso seekável, tempo, 1x/1.5x/2x. */
export function AudioPlayer({ messageId, src, srcReserva, mime }: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const { fonte, tentarReserva } = useFonteComReserva(src ?? mediaSrc(messageId), srcReserva);
  // Sem `src` até chegar perto da tela: o áudio não pede rede antes disso.
  const { ref: caixaRef, visivel, carregar } = useAoAparecer<HTMLDivElement>();
  const tocarAoCarregar = useRef(false);
  /**
   * "Tocando" só DEPOIS de o `play()` resolver. Marcar antes deixava o botão em
   * "Pausar" quando o play falhava (autoplay bloqueado, mídia que não decodifica,
   * src que expirou): a pessoa via o áudio "tocando" em silêncio, e o próximo
   * clique pausava o que nunca tocou.
   */
  const tocar = (el: HTMLAudioElement) =>
    Promise.resolve(el.play()).then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  useEffect(() => {
    if (!visivel || !tocarAoCarregar.current) return;
    tocarAoCarregar.current = false;
    if (audioRef.current) tocar(audioRef.current);
  }, [visivel]);
  // Buscando a versão convertida: o botão diz que espera e ignora toques —
  // um 2º toque pediria outra conversão e trocaria o áudio no meio.
  const [carregando, setCarregando] = useState(false);
  // Modo conversão (F2): o aparelho não toca este formato. O `<audio>` fica sem
  // `src` até o toque, e o toque toca a versão AAC por `blob:` — em memória,
  // nunca em Cache Storage nem IndexedDB (D4 da ADR-0006).
  const [erroLigouConversao, setErroLigouConversao] = useState(false);
  const blobRef = useRef<string | null>(null);
  // Nota interna (src próprio de /notes/) não passa pela rota de conversão das mensagens.
  const podeConverter = convertivel(mime) && !src?.includes("/notes/");
  // O que o aparelho responde para este mime. `null` no servidor e na
  // hidratação: ali ninguém sabe o que o aparelho toca, e o `<audio>` nasce SEM
  // src. Com src no primeiro commit, o WebKit já baixa o ogg, falha e guarda o
  // erro no elemento — e o `play()` do toque é recusado sem destravá-lo:
  // viravam dois toques.
  const resposta = useSyncExternalStore(
    semInscricao,
    () => (podeConverter && mime ? document.createElement("audio").canPlayType(mime) : "nao-se-aplica"),
    () => null,
  );
  const conversao = erroLigouConversao || resposta === "";

  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("ended", onEnded);
    };
  }, []);

  if (failed) return <MediaUnavailable kind="Áudio" className="h-12 w-60" />;

  // ponytail: OGG streams report Infinity at loadedmetadata; self-heal when refined
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const tocarConvertido = async (el: HTMLAudioElement) => {
    // Chamado ainda DENTRO do gesto, antes do fetch: é o que destrava o
    // elemento no WebKit para o play() de depois do await. Sem src, rejeita —
    // e tudo bem.
    el.play().catch(() => {});
    setCarregando(true);
    try {
      const resposta = await fetch(`${mediaSrc(messageId)}?formato=aac`, { cache: "no-store" });
      // Teto de conversões (429) ou conversor ocupado (503) é espera, não
      // defeito: o botão fica, e o próximo toque tenta de novo.
      if (resposta.status === 429 || resposta.status === 503) {
        toast.warning(t("Muitas conversões de áudio seguidas. Tente em um minuto."));
        return;
      }
      if (!resposta.ok) throw new Error(String(resposta.status));
      blobRef.current = URL.createObjectURL(await resposta.blob());
    } catch {
      setFailed(true);
      return;
    } finally {
      setCarregando(false);
    }
    el.src = blobRef.current;
    if (RATES[rateIdx] !== 1) el.playbackRate = RATES[rateIdx]!;
    await tocar(el);
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el || carregando) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else if (conversao && !blobRef.current) {
      void tocarConvertido(el);
    } else if (!visivel && !conversao) {
      // Clique antes de a mídia ter carregado: põe o `src` e toca em seguida.
      tocarAoCarregar.current = true;
      carregar();
    } else {
      void tocar(el);
    }
  };

  const cycleRate = () => {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next]!;
  };

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrent(value);
  };

  const progresso = safeDuration > 0 ? current / safeDuration : 0;

  // `.audio` do quadro DS: play redondo de 38 na marca (no escuro, o degradê),
  // onda com o trecho ouvido pintado, e ao lado a duração e a velocidade. O
  // `<input type="range">` fica por cima da onda, invisível: arrastar e as setas
  // do teclado continuam funcionando, e a onda é só o desenho dele.
  return (
    <div ref={caixaRef} className="flex w-62.5 max-w-full items-center gap-2.5 py-0.5">
      {/* Em conversão o src sai do render e é posto à mão (blob:). Por isso o
          React nunca mais o toca: regravar o mesmo src recarregaria o áudio. */}
      <audio
        ref={audioRef}
        src={visivel && resposta !== null && !conversao ? fonte : undefined}
        preload={visivel ? "metadata" : "none"}
        onError={(e) => {
          const el = e.currentTarget;
          // O `canPlayType` pode mentir ("maybe"): o erro de decodificação liga a
          // conversão UMA vez; depois, a reserva da URL; só então indisponível.
          const jaConvertido = blobRef.current && el.src === blobRef.current;
          if (podeConverter && mime && !jaConvertido && !tocaComCerteza(el, mime)) setErroLigouConversao(true);
          else if (!tentarReserva()) setFailed(true);
        }}
      />
      <button
        type="button"
        aria-label={playing ? t("Pausar áudio") : t("Reproduzir áudio")}
        aria-busy={carregando || undefined}
        onClick={toggle}
        className="pele-grad-icone grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {carregando ? (
          <CircleNotch size={16} weight="bold" className="motion-safe:animate-spin" aria-hidden />
        ) : playing ? (
          <Pause size={16} weight="fill" aria-hidden />
        ) : (
          <Play size={16} weight="fill" aria-hidden className="ml-0.5" />
        )}
      </button>
      <div className="relative flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
        {ondaDe(messageId).map((altura, i, todas) => (
          <i
            key={i}
            aria-hidden
            style={{ height: `${altura}%` }}
            className={cn(
              "block min-h-0.75 flex-1 rounded-[2px]",
              (i + 0.5) / todas.length <= progresso
                ? "bg-accent dark:bg-(image:--pele-grad)"
                : "bg-[color-mix(in_oklch,var(--color-text-subtle)_45%,transparent)]",
            )}
          />
        ))}
        <input
          type="range"
          aria-label={t("Progresso do áudio")}
          aria-valuetext={`${fmt(current)} ${t("de")} ${fmt(safeDuration)}`}
          min="0"
          max={String(safeDuration || 1)}
          step="0.1"
          value={current}
          onChange={(e) => seek(Number(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.75">
        <span className="font-mono text-meta font-normal tabular-nums text-text-muted">
          {fmt(playing || current > 0 ? current : safeDuration)}
        </span>
        <button
          type="button"
          aria-label={`${t("Velocidade de reprodução")}: ${RATES[rateIdx]}x`}
          onClick={cycleRate}
          className="rounded-lg bg-tint px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {RATES[rateIdx]}x
        </button>
      </div>
    </div>
  );
}
