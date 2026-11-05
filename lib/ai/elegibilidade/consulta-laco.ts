/**
 * Lê as últimas mensagens da conversa, roda `detectarLacoComRobo` e, havendo
 * laço, silencia a conversa. Chamado pelo drain (enfileirar) e pelo turno (rodar).
 *
 * Fail-open na leitura (erro = segue como hoje), fail-closed no efeito (laço = não responde).
 * Não abre caso humano: isso exige contexto de agente que não existe nestes pontos.
 */
import type pg from "pg";

import { detectarLacoComRobo, JANELA_LACO_MS, MOTIVO_LACO_PREFIXO, type MensagemDaConversa } from "./laco-com-robo";

interface Log {
  warn(msg: string, f?: Record<string, unknown>): void;
}

export async function conversaEmLacoComRobo(
  pool: pg.Pool,
  input: { organizationId: string; conversationId: string; agora: Date },
  log: Log,
): Promise<boolean> {
  let mensagens: MensagemDaConversa[];
  try {
    const { rows } = await pool.query<{
      direction: "inbound" | "outbound";
      body: string | null;
      sent_at: Date | string;
      sent_via: string | null;
    }>(
      `select direction, body, sent_at, sent_via
         from messages
        where organization_id = $1 and conversation_id = $2
          and sent_at >= $3::timestamptz
        order by sent_at desc
        limit 300`,
      [input.organizationId, input.conversationId, new Date(input.agora.getTime() - JANELA_LACO_MS)],
    );
    mensagens = rows.map((r) => ({
      direcao: r.direction,
      texto: r.body,
      enviadoEm: new Date(r.sent_at),
      // 'automation', 'system' e 'external_device' não são a IA
      enviadaPelaIa: r.direction === "outbound" && r.sent_via === "ai",
    }));
  } catch (err) {
    log.warn("[laco-com-robo] leitura das mensagens falhou — seguindo", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
  }

  const { laco, motivo } = detectarLacoComRobo(mensagens, input.agora);
  if (!laco) return false;

  log.warn("[laco-com-robo] laço detectado — conversa silenciada", {
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    motivo,
  });
  try {
    await pool.query(
      // O cron de devolução automática ignora conversa com este motivo (`avaliarDevolucao`), senão devolveria à IA e o laço recomeçaria.
      `update conversations set bot_silenced_until = 'infinity', last_handoff_reason = $3
        where organization_id = $1 and id = $2`,
      [input.organizationId, input.conversationId, `${MOTIVO_LACO_PREFIXO} (${motivo === "volume" ? "volume" : motivo === "ura" ? "URA" : "repetição"})`],
    );
  } catch (err) {
    log.warn("[laco-com-robo] silenciar falhou", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
  return true; // fail-closed: mesmo sem conseguir gravar, não responde agora
}
