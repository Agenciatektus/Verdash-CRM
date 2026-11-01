/**
 * F8 do turno da IA: a ferramenta `send_message`, do corpo formatado até a reserva em voo (ADR-0006, fatia S7).
 *
 * MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra, texto ou ordem.
 * O que a closure lia do escopo do turno chega por parâmetro; o que ela escrevia vai no
 * `EstadoDoTurno` (o MESMO objeto do orquestrador, nunca um campo copiado por valor).
 */
import { tool } from '../../../edge/llm/run-model-call';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import { vetoReason } from '@/lib/leads/veto-activity';
import { decidePromise } from '../../../guardrails/promise/engine';
import { formatarParaWhatsApp } from '../../formato-whatsapp';
import { respostaFicouObsoleta } from '../../turno-ja-respondido';
import { copiarFotoNoStorage, prepararFotosDoProduto, type FotoParaEnvio } from '../../fotos-do-produto';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import type { EstadoDoTurno } from '../estado-do-turno';
import { executarCadeiaDoEnvio, type DependenciasDoEnvio } from './guardrails-do-envio';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { AGENT_TOOL_DEFS, claimsCurrentInboundIsEmpty, MAX_VETOS_DE_FALSO_VAZIO } from '../../inbound-turn';

export function criarSendMessage(c: ContextoDoTurno, r: DependenciasDoEnvio, estado: EstadoDoTurno) {
  const { deps, job, pool, input, preview, tenantId, leadId, runLog, liveJob } = c;
  const { agentConfig, mensagemDoJob, maxSendsPerTurn, promiseTable } = r;
  return tool({
    ...AGENT_TOOL_DEFS.send_message,
    execute: async ({ body: corpoDoModelo, produto_codigo }) => {
      estado.tentativasDeEnvio += 1;
      // O texto sai no formato do WhatsApp — sem `\n` literal nem
      // `**negrito**` de Markdown na tela do cliente. Antes de qualquer gate,
      // para que o corpo vazio, as bolhas e a pausa humana meçam o que sai.
      // Ver `formato-whatsapp.ts`.
      const body = formatarParaWhatsApp(corpoDoModelo);
      // CORPO VAZIO NÃO SAI. Medido ao vivo (2026-09-19): o `gpt-4o-mini`
      // chamou `send_message` várias vezes com corpo que virou vazio e o
      // WhatsApp do cliente recebeu bolhas em branco. O schema garante
      // min(1) no argumento, mas um `\n`/espaço passa e vira vazio depois do
      // trim/gates. Recusar aqui devolve ao modelo para reescrever — nunca
      // manda bolha em branco.
      if (body.trim() === '') {
        return {
          ok: false,
          error: {
            code: 'corpo_vazio',
            message:
              'O texto da mensagem ficou vazio. Escreva a resposta de verdade e chame send_message de novo.',
          },
        };
      }
      // DUPLICATA PRÓXIMA NO MESMO TURNO (near-dup): o corpo é quase idêntico a algo
      // que JÁ foi aceito e enviado NESTE turno, ou que está EM VOO agora (tool calls
      // paralelas do mesmo passo — a reserva vira logo abaixo, antes do primeiro
      // await; a candidata checada ainda não foi reservada, então nunca se suprime
      // a si mesma). O contrato é UMA resposta adequada e completa — repetição
      // imediata é redundância, não informação nova (mudança de valor/negação é
      // exceção na régua: preço, hora ou "não" trocado passam, ver near-dup.ts).
      // Suprime sem tocar no canal nem no ledger (nada é marcado como entregue),
      // devolvendo ao modelo um erro de ENSINO (mesma forma de corpo_vazio/
      // resposta_obsoleta). Cobre o caminho de recuperação do turno mudo: a
      // correção re-entra por aqui, na janela em memória. Bolhas de UM
      // send_message não se comparam entre si (só candidato contra candidato),
      // então fatiamento legítimo não se autossuprime.
      const corpoRepetido = estado.dupTrava.checar(body);
      if (corpoRepetido !== null) {
        runLog.info('duplicate_suppressed — candidato quase idêntico ao já aceito no turno', {
          job_id: job?.id ?? null,
          prior_len: corpoRepetido.length,
          candidato_len: body.length,
        });
        // RASTRO PARA O OPERADOR (#2996, item 7): suprimir sem registrar é
        // silêncio invisível na timeline — quem opera precisa ver que o agente
        // DECIDIU não falar e por quê. Mesmo vocabulário do veto de guardrail
        // (`send_vetoed`), motivo legível pela `vetoReason` (sem código cru na
        // tela), metadados SÓ ids e tamanhos — nunca o conteúdo da mensagem
        // (PII: a linha aparece na tela e no export LGPD). Sem lastro (a
        // supressão acontece ANTES da cadeia, não existe trace) a linha entra
        // como 'system' com `actor_agent_id` — regra da própria 0071. Try/catch:
        // a timeline não pode derrubar a recusa que ela descreve.
        try {
          const roteou = await emitAgentActivityForContact({
            pool,
            organizationId: tenantId,
            contactId: leadId,
            type: 'send_vetoed',
            sourceModule: 'near-dup',
            sourceId: job?.id ?? null,
            ...(agentConfig?.agentId ? { agentId: agentConfig.agentId } : {}),
            reason: vetoReason('near_dup', 'duplicate_suppressed'),
            payload: {
              gate: 'near_dup',
              code: 'duplicate_suppressed',
              conversation_id: input.conversationId,
              prior_len: corpoRepetido.length,
              candidato_len: body.length,
            },
          });
          if (!roteou.routed) {
            runLog.warn('supressão near-dup não roteada na timeline do negócio', {
              reason: roteou.reason,
            });
          }
        } catch (err) {
          runLog.warn('atividade da supressão near-dup não gravada', {
            error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
          });
        }
        return {
          ok: false,
          error: {
            code: 'duplicate_suppressed',
            message:
              'Você já enviou uma mensagem muito parecida a esta nesta conversa, depois da última fala do cliente — ela NÃO foi reenviada. ' +
              'Não repita a mesma informação. Se há algo genuinamente novo a acrescentar, envie SÓ a parte nova; ' +
              'senão encerre o turno agora.',
          },
        };
      }
      if (claimsCurrentInboundIsEmpty(body, mensagemDoJob)) {
        estado.vetos.falseEmptyInbound += 1;
        if (estado.vetos.falseEmptyInbound < MAX_VETOS_DE_FALSO_VAZIO) {
          return {
            ok: false,
            error: {
              code: 'false_empty_inbound',
              message:
                'O cliente enviou texto nesta mensagem. Não diga que ela veio vazia, em branco ou sem texto. ' +
                `Responda ao pedido real agora: ${JSON.stringify(mensagemDoJob)}. ` +
                `Esta é a tentativa de correção ${estado.vetos.falseEmptyInbound}.`,
            },
          };
        }
        // Não há segunda cadeia a re-rodar aqui (diferente do vocabulário
        // interno, que desarma um gate e chama `runBeforeSend` de novo): esta
        // barreira é local ao `execute`, então soltar é seguir para o resto do
        // caminho de envio, com a cadeia inteira ainda pela frente.
        runLog.warn('fail-safe do gate de falso-vazio: envio liberado após vetos seguidos', {
          vetos: estado.vetos.falseEmptyInbound,
        });
      }
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
      // RESERVA EM VOO (#2996, item 6): do gate até aqui o CAMINHO DE PASSAGEM
      // é tudo síncrono (nenhuma operação assíncrona entre `checar` e
      // `reservar`; o único ponto que cede o event loop mora no ramo de
      // supressão, que termina em return), então check-then-reserve é atômico
      // no event loop — a próxima chamada paralela do passo só roda depois
      // desta tick e vê a reserva. Daqui até o `finally` da cadeia esta
      // candidata vale como "em envio": três send_message quase idênticos num
      // mesmo passo não passam todos pela checagem. Veto/falha/exceção removem
      // a reserva (os `liberar` explícitos + o `finally`); envio aceito
      // PROMOVE para a memória durável (exatamente uma vez, em `promover`).
      // JANELA PRÉ-CADEIA COM DONO (revisão do #2996, item 6): as duas
      // consultas de antes da cadeia — a de resposta obsoleta e a de preparo
      // de fotos — não têm catch próprio; uma exceção delas escaparia por
      // CIMA do `finally` da cadeia e deixaria a reserva órfã em `emVoo`,
      // suprimindo depois a re-tentativa legítima da candidata que nunca saiu
      // (no provedor com chave de reserva da assinatura, o turno até re-entra
      // no modelo e esbarra nela). Este bloco envolve a reserva e as duas
      // consultas: em exceção ele SOLTA a reserva e RE-LANÇA o erro original
      // intacto — sem traduzir para `internal_error`, sem mudar classificação
      // nem desfecho do turno; só o vazamento deixa de existir. Os `liberar`
      // dos returns estruturados seguem valendo (return não passa por catch).
      // `let` das fotos declarado antes do bloco porque o escopo precisa
      // alcançar a cadeia; envolver a reserva não altera o caminho do gate —
      // ele segue inteiramente síncrono do `checar` até a reserva.
      let fotosDoProduto: FotoParaEnvio[] = [];
      let fotosQueFaltaram = 0;
      try {
        estado.dupTrava.reservar(body);
        // RESPOSTA OBSOLETA: o cliente escreveu de novo enquanto este turno pensava.
        // Só antes do PRIMEIRO envio — cortar a meio uma resposta já começada é pior
        // que a duplicata. A mensagem nova tem job próprio, que lê a conversa inteira
        // e responde a tudo de uma vez. Ver `respostaFicouObsoleta`.
        if (
          !preview &&
          estado.seq === 0 &&
          (await respostaFicouObsoleta(
            pool,
            { organizationId: tenantId, conversationId: input.conversationId, jobId: liveJob().id },
            deps.knobs.respostaObsoletaTetoMs ?? 0,
          ))
        ) {
          runLog.info('resposta descartada — o cliente escreveu de novo durante o turno', {
            job_id: liveJob().id,
            conversation_id: input.conversationId,
          });
          // #1943: marca o turno como descartado. NADA mais sai dele, nem a
          // pergunta pendente do roteiro — ela segue feita para o turno da
          // mensagem nova. Ver `perguntaDoRoteiroPodeSair` no `enviar`.
          estado.turnoDescartado = true;
          // Nada saiu: a reserva em voo não pode virar memória (nem sobreviver
          // ao turno como entrada órfã). #2996, item 6.
          estado.dupTrava.liberar(body);
          return {
            ok: false,
            error: {
              code: 'resposta_obsoleta',
              message:
                'O cliente mandou mensagem nova enquanto você escrevia; esta resposta ficou desatualizada e NÃO foi enviada. ' +
                'NÃO chame send_message de novo neste turno — encerre agora. O próximo turno lê a conversa inteira e responde a tudo de uma vez.',
            },
          };
        }
        // A foto do produto (ideia de @vgamkt, #1130): preparada ANTES da cadeia e
        // fora do lock do número — a cópia no Storage é rede. Código errado volta
        // ao modelo sem enviar nada; foto que não copiou sai do envio e o texto
        // segue (degradar para só texto). Ver `agent/fotos-do-produto.ts`.
        if (produto_codigo !== undefined && produto_codigo.trim() !== '' && !preview) {
          const preparadas = await prepararFotosDoProduto(pool, copiarFotoNoStorage(runLog), {
            tenantId,
            conversationId: input.conversationId,
            codigo: produto_codigo,
          });
          if (!preparadas.ok) {
            // Nada saiu: libera a reserva antes de devolver o erro ao modelo.
            estado.dupTrava.liberar(body);
            return { ok: false, error: { code: preparadas.code, message: preparadas.message } };
          }
          fotosDoProduto = preparadas.fotos;
          fotosQueFaltaram = preparadas.tinha - preparadas.fotos.length;
        }
        // F4-04: sinaliza (independente do gate F4-01/F4-08) se ESTA candidata é uma
        // promessa fora de tabela — usado só para correlacionar com o jailbreak no fim do
        // turno. A detecção é determinística (decidePromise); sem tabela do tenant = no-op.
        if (
          promiseTable !== null &&
          !decidePromise({ candidate: body, table: promiseTable }).allow
        ) {
          estado.outOfTablePromiseAttempted = true;
        }
      } catch (err) {
        // EXCEÇÃO PRÉ-CADEIA (revisão do #2996, item 6): nada saiu — a reserva
        // órfã sai junto e o erro sobe idêntico ao de antes (nenhum code novo,
        // nenhum return inventado). `liberar` é idempotente: se um caminho já
        // tiver liberado, aqui é no-op.
        estado.dupTrava.liberar(body);
        throw err;
      }
      return executarCadeiaDoEnvio(c, r, estado, { body, produto_codigo, fotosDoProduto, fotosQueFaltaram });
    },
  });
}
