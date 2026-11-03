/**
 * Regra pura do reprocesso automático de mídia que falhou (cron `media-derive-retry`).
 *
 * `media-derive-worker` grava `failed` + `metadata.media_derived_motivo` e o evento morre.
 * Aqui decide-se quem ganha outra tentativa: no máximo MAX_REPROCESSOS por mensagem,
 * com intervalo mínimo, só nas últimas 48 h e nunca para motivo permanente.
 */
import { MOTIVO_IMAGEM_NAO_REDUZIDA } from "@/lib/messaging/media/imagem-para-ia";
import {
  MOTIVO_AUDIO_LONGO_DEMAIS,
  MOTIVO_AUDIO_SEM_DURACAO_GRANDE_DEMAIS,
} from "@/lib/messaging/media/trava-da-transcricao";

export const MAX_REPROCESSOS = 3;
// Acima do backoff do dreno (2+4+8+16 = 30 min): antes disso o evento original ainda pode estar em retry.
export const INTERVALO_MINIMO_MS = 35 * 60_000;
export const JANELA_MS = 48 * 3_600_000;
export const LOTE_MAXIMO = 100;

/** Repetir não muda o resultado: o mesmo áudio/imagem cai na mesma trava. */
const MOTIVOS_PERMANENTES = [
  MOTIVO_AUDIO_LONGO_DEMAIS,
  MOTIVO_AUDIO_SEM_DURACAO_GRANDE_DEMAIS,
  MOTIVO_IMAGEM_NAO_REDUZIDA,
];

export interface MensagemFalha {
  id: string;
  organization_id: string;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

export function reprocessosFeitos(metadata: Record<string, unknown> | null): number {
  const n = Number(metadata?.derive_retries);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Nunca vai dar certo: o cron grava o teto para a consulta parar de reler a linha. */
export function descartavelParaSempre(m: MensagemFalha): boolean {
  const meta = m.metadata ?? {};
  if (meta.media_status === "expired") return true;
  const motivo = typeof meta.media_derived_motivo === "string" ? meta.media_derived_motivo : "";
  return MOTIVOS_PERMANENTES.some((p) => motivo.includes(p));
}

export function elegivelParaReprocesso(m: MensagemFalha, agoraMs: number): boolean {
  const meta = m.metadata ?? {};
  if (descartavelParaSempre(m)) return false;
  if (reprocessosFeitos(meta) >= MAX_REPROCESSOS) return false;
  const criada = Date.parse(m.created_at);
  if (!Number.isFinite(criada) || agoraMs - criada > JANELA_MS) return false;
  // Sem derive_last_retry_at, a falha original é o `updated_at` (o worker gravou o `failed`).
  const ultima = Date.parse(String(meta.derive_last_retry_at ?? m.updated_at ?? m.created_at));
  return Number.isFinite(ultima) && agoraMs - ultima > INTERVALO_MINIMO_MS;
}

export function selecionarParaReprocesso(
  candidatas: MensagemFalha[],
  agoraMs: number,
  orgsElegiveis: ReadonlySet<string>,
  limite: number = LOTE_MAXIMO,
): MensagemFalha[] {
  return candidatas
    .filter((m) => orgsElegiveis.has(m.organization_id) && elegivelParaReprocesso(m, agoraMs))
    .slice(0, limite);
}
