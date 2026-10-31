/**
 * F8 do turno da IA: a ferramenta `send_template` (ADR-0006, fatia S7).
 *
 * MOVIDA de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra, texto, ordem
 * ou número de awaits. O teto do turno e o `seq` vivem no `EstadoDoTurno` (o mesmo objeto
 * do orquestrador); `pararDigitando` chega como seta porque o orquestrador o reatribui.
 * Quando a ferramenta entra no turno continua decidido lá.
 */
import { tool } from '../../../edge/llm/run-model-call';
import { claimOfJob } from '../../../queue/claim';
import { runBeforeSend } from '../../../guardrails/before-send';
import { isStatusSendable } from '../../../../channels/meta/template-binding';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { definicaoNaConexao } from '@/lib/channels/linha-do-espelho';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import type { SaidaDoRoteamento } from '../roteamento';
import type { SaidaDosDesvios } from '../desvios-deterministicos';
import type { EstadoDoTurno } from '../estado-do-turno';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { AGENT_TOOL_DEFS, eTurnoDeResposta } from '../../inbound-turn';

export function criarSendTemplate(
  c: ContextoDoTurno,
  r: {
    agentOperation: SaidaDoRoteamento['agentOperation'];
    liveChannel: SaidaDosDesvios['liveChannel'];
    optedOutThisTurn: SaidaDosDesvios['optedOutThisTurn'];
    lgpd: SaidaDosDesvios['lgpd'];
    maxSendsPerTurn: number;
    pararDigitando: () => void;
  },
  estado: EstadoDoTurno,
) {
  const { deps, pool, input, tenantId, leadId, clock, runLog, liveJob } = c;
  const { agentOperation, liveChannel, optedOutThisTurn, lgpd, maxSendsPerTurn, pararDigitando } = r;
  return tool({
    ...AGENT_TOOL_DEFS.send_template,
    execute: async ({ template_name, language, values }) => {
      estado.tentativasDeEnvio += 1;
      if (estado.seq >= maxSendsPerTurn) {
        return {
          ok: false,
          error: {
            code: 'max_sends_per_turn',
            message:
              `você já enviou ${estado.seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
              'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
          },
        };
      }
      // O texto RENDERIZADO vai como `body` da cadeia: os gates de promessa,
      // spinning e disclosure avaliam exatamente o que o contato vai ler. Sem
      // isso, "usar template" seria a forma de escapar dos guardrails de conteúdo.
      // A definição DESTA conexão (lib/channels/linha-do-espelho.ts): sem o
      // escopo, com canal oficial e parceiro espelhando o mesmo nome, o agente
      // renderizava e passava pelos gates o texto de OUTRO número.
      const linha =
        (await definicaoNaConexao<{
          components: unknown;
          parameter_format: string;
          status: string;
        }>(pool, ['components', 'parameter_format', 'status'], {
          organizationId: tenantId,
          name: template_name,
          language,
          channelSessionId: input.channelSessionId,
        })) ?? undefined;
      if (linha === undefined) {
        return {
          ok: false,
          error: {
            code: 'template_desconhecido',
            message:
              `não existe template "${template_name}" em ${language} nesta conta. ` +
              'Encerre o turno; um humano precisa configurá-lo.',
          },
        };
      }
      // "Existe" não é "pode ser disparado". A regra vive em template-binding.ts e
      // o caminho HUMANO já a respeitava (recusa `not_approved` no menu do composer);
      // este caminho não a consultava — e é o que age SEM humano olhando. Um template
      // PENDING ou REJECTED iria à Graph API, voltaria erro genérico, e o modelo
      // trataria como falha de infraestrutura em vez de configuração pendente.
      //
      // Erro SEPARADO de `template_desconhecido` de propósito: as duas causas pedem
      // ações humanas diferentes — criar o template, ou esperar/consertar a análise
      // da Meta. Colapsá-las manda o operador procurar no lugar errado.
      if (!isStatusSendable(linha.status)) {
        return {
          ok: false,
          error: {
            code: 'template_nao_aprovado',
            message:
              `o template "${template_name}" existe mas está ${linha.status} na Meta — ` +
              'só um template APPROVED pode ser disparado. Encerre o turno; ' +
              'um humano precisa resolver a aprovação.',
          },
        };
      }

      const rendered = renderTemplateBody(linha.components, values, {
        name: template_name,
        language,
        parameterFormat: linha.parameter_format,
      });

      const chain = await runBeforeSend({
        pool,
        log: runLog,
        agentOperation,
        tenantId,
        leadId,
        jobId: liveJob().id,
        channelSessionId: input.channelSessionId,
        body: rendered,
        // Só ESTE gate muda; stop, LGPD e pacing continuam valendo integralmente.
        isTemplate: true,
        optedOutThisTurn,
        // Resposta do turno, mesmo sendo template: lê a janela de resposta (0495).
        resposta: eTurnoDeResposta(liveJob()),
        crmDailyLimit: null,
        now: clock(),
        sleep: deps.sleep,
        lgpd,
        send: (finalBody: string) => {
          pararDigitando(); // a mensagem sai agora; renovar depois dela mentiria
          estado.seq += 1;
          return liveChannel().send({
            tenantId,
            leadId,
            jobId: liveJob().id,
            jobClaim: claimOfJob(liveJob()),
            agentOperation,
            seq: estado.seq,
            conversationId: input.conversationId,
            body: finalBody,
            template: { name: template_name, language, values },
          });
        },
      });

      if (chain.status === 'vetoed') {
        return { ok: false, error: { code: chain.code, message: chain.message } };
      }
      const outcome = chain.outcome;
      estado.outcomes.push(outcome);
      if (outcome.kind === 'sent' || outcome.kind === 'already_sent') {
        return {
          ok: true,
          status: 'enviada',
          message_id: outcome.messageId,
          // Explícito: sem isso o modelo tende a emendar texto livre depois do
          // template — que a janela fechada recusaria.
          message: 'template enviado. Não escreva mais nada neste turno.',
        };
      }
      return { ok: true, status: 'aceita_aguardando_canal' };
    },
  });
}
