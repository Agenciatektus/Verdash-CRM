/**
 * F8 do turno da IA: o que o `send_message` devolve ao modelo para cada desfecho do canal (ADR-0006, fatia S7).
 *
 * MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra, texto ou ordem.
 * O que a closure lia do escopo do turno chega por parâmetro; o que ela escrevia vai no
 * `EstadoDoTurno` (o MESMO objeto do orquestrador, nunca um campo copiado por valor).
 */
import type { ChannelSendResult } from '../../../channel-adapter';
import type { FotoParaEnvio } from '../../fotos-do-produto';

export function responderAoDesfecho(
  outcome: ChannelSendResult,
  r: { produto_codigo?: string; fotosDoProduto: FotoParaEnvio[]; fotosQueFaltaram: number; noteRunError: (err: Error) => void },
) {
  const { produto_codigo, fotosDoProduto, fotosQueFaltaram, noteRunError } = r;
  switch (outcome.kind) {
    case 'sent':
    case 'already_sent':
      return {
        ok: true,
        status: 'enviada',
        message_id: outcome.messageId,
        ...(produto_codigo !== undefined ? { fotos_enviadas: fotosDoProduto.length } : {}),
        ...(fotosQueFaltaram > 0
          ? {
              aviso: `${fotosQueFaltaram} foto(s) do produto não puderam ser enviadas; o texto foi. Não diga ao cliente que mandou essas fotos.`,
            }
          : {}),
      };
    case 'queued':
      return {
        ok: true,
        status: 'aceita_aguardando_canal',
        message:
          'o canal aceitou a mensagem e vai enviá-la quando a sessão voltar — não reenvie.',
      };
    case 'blocked':
      return {
        ok: false,
        error: {
          code: 'contato_bloqueado',
          message:
            'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
        },
      };
    case 'failed':
      return {
        ok: false,
        error: {
          code: 'envio_falhou',
          message:
            'o canal falhou ao enviar — não tente de novo neste turno; o sistema fará retry.',
        },
      };
    case 'unavailable':
      // transiente (transporte/tool do canal): ensina o modelo a parar; o
      // job re-tenta com a MESMA idempotency_key (ledger ficou 'requested').
      noteRunError(
        new Error(
          `canal indisponível no envio (${outcome.reason}) — job re-tentado pela fila`,
        ),
      );
      return {
        ok: false,
        error: {
          code: 'envio_indisponivel',
          message:
            'não consegui enviar agora (canal indisponível) — encerre o turno; o sistema re-tentará.',
        },
      };
  }
}
