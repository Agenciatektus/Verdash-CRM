"use client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";

import { motivoDoVeto } from "@/lib/agent-engine/agent/sugestao-de-resposta";

import { useSugestaoDeResposta, type SugestaoDeResposta } from "./useSugestaoDeResposta";

/**
 * Propostas com rótulo legível. A de mover etapa NÃO é aplicada por clique: a
 * pessoa move o card pelo painel do lead (decisão do assistido na cadência).
 */
const ROTULO_DA_PROPOSTA: Record<string, string> = {
  crm_move_lead_stage: "Mover o negócio de etapa (confirme pelo painel do lead)",
};

const STATUSES: Record<string, string> = {
  generating: "Preparando sugestão…",
  pending: "Sugestão para revisar",
  approved: "Resposta aprovada: aguardando envio",
  sending: "Enviando resposta aprovada…",
  sent: "Resposta aprovada enviada",
  dismissed: "Sugestão rejeitada",
  stale: "Sugestão obsoleta: a conversa mudou",
  failed: "Não foi possível concluir a sugestão ou o envio",
};

/**
 * O painel de revisão da sugestão do agente.
 *
 * Dois jeitos de montar, de propósito:
 * - com `sugestao` (o composer): o estado vem de fora e o gatilho "Sugerir
 *   resposta" é o chip da barra, então o painel só ocupa espaço quando há algo
 *   para revisar ou um aviso a dar. Antes ele era uma caixa fixa acima de toda
 *   resposta, mesmo vazia;
 * - só com `conversationId` (uso isolado e testes): o painel tem estado próprio
 *   e mostra o próprio botão, como sempre mostrou.
 */
export function ReplyReviewPanel({
  conversationId,
  disabled,
  sugestao,
}: {
  conversationId?: string;
  disabled?: boolean;
  sugestao?: SugestaoDeResposta;
}) {
  if (sugestao) return <Painel s={sugestao} disabled={disabled} comBotao={false} />;
  return <PainelProprio conversationId={conversationId ?? ""} disabled={disabled} />;
}

function PainelProprio({ conversationId, disabled }: { conversationId: string; disabled?: boolean }) {
  const s = useSugestaoDeResposta(conversationId);
  return <Painel s={s} disabled={disabled} comBotao />;
}

function Painel({ s, disabled, comBotao }: { s: SugestaoDeResposta; disabled?: boolean; comBotao: boolean }) {
  const t = useT();
  const { draft, body, notice, busy } = s;
  // A causa do veto, em linguagem de quem opera (issue #2975): sem código
  // conhecido, a frase genérica de sempre continua sendo a verdade.
  const motivo = draft ? motivoDoVeto(draft.error_code) : null;
  // Pendente COM texto e COM código de veto de envio (doc de decisão 234): a
  // prévia barrou uma versão anterior e a sugestão oferecida veio depois. Só os
  // vetos de envio têm `causa`; paradas e `unknown_preview_tool` não barram
  // versão nenhuma. O aviso não diz que ESTE texto é a reescrita: o rascunho
  // grava só `impediments[0]`, e a barrada pode ter sido outra mensagem.
  const barrada = draft?.status === "pending" && draft.original_body?.trim() ? motivo : null;
  if (!comBotao && !draft && !notice) return null;
  return (
    <section
      className="mb-2 space-y-2 rounded-2xl border border-accent/30 bg-surface p-3 shadow-xs"
      aria-label={t("Assistência do agente")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {t(draft ? (STATUSES[draft.status] ?? "Assistência do agente") : "Assistência do agente")}
        </p>
        {comBotao && (
          <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={s.generate}>
            {t(busy ? "Preparando…" : "Sugerir resposta")}
          </Button>
        )}
      </div>
      {draft && (
        <>
          <p className="text-xs text-muted-foreground">
            {t("Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.")}
          </p>
          {barrada?.causa && (
            <p className="text-xs text-muted-foreground">
              {t("Uma versão anterior desta sugestão foi barrada: {causa}. Confira antes de enviar.").replace(
                "{causa}",
                t(barrada.causa),
              )}
            </p>
          )}
          {body && (
            <Textarea
              aria-label={t("Resposta sugerida")}
              value={body}
              onChange={(e) => s.setBody(e.target.value)}
              disabled={disabled || busy || draft.status !== "pending"}
              rows={3}
            />
          )}
          {draft.proposals.length > 0 && (
            <details className="text-xs">
              <summary>{t("Ações propostas: precisam de autorização separada")}</summary>
              <p>{t("Abra a ação correspondente no CRM ou na agenda para confirmar.")}</p>
              <ul>
                {draft.proposals.map((p, i) => (
                  <li key={i}>{ROTULO_DA_PROPOSTA[p.tool] ? t(ROTULO_DA_PROPOSTA[p.tool]!) : p.tool}</li>
                ))}
              </ul>
            </details>
          )}
          {draft.status === "pending" && (
            <>
              <Input
                aria-label={t("Feedback para a próxima sugestão")}
                placeholder={t("Feedback para a próxima sugestão")}
                value={s.feedback}
                onChange={(e) => s.setFeedback(e.target.value)}
                maxLength={1000}
              />
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={disabled || busy || !body.trim()} onClick={() => s.decide("approve")}>
                  {t("Aprovar e enviar")}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => s.decide("reject")}>
                  {t("Rejeitar")}
                </Button>
              </div>
            </>
          )}
          {draft.status === "failed" && (
            <p className="text-xs">
              {motivo
                ? t(motivo.texto)
                : t("Confira a configuração do agente e tente gerar novamente.")}
            </p>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice.message}
        </p>
      )}
    </section>
  );
}
