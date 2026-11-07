/**
 * F5b do turno da IA: a ENTRADA do agente publicado, depois dos desvios
 * determinísticos (subida v1.90 do upstream, #2679/#3142/#3143).
 *
 * Ordem do início do turno: detecções determinísticas (pedido de humano e
 * opt-out ambíguo, em `desvios-deterministicos.ts`) → filtro de palavra-chave →
 * horário de funcionamento do agente → contagem da condução da cadência. Um
 * pedido de humano ou um opt-out fora do horário é tratado AGORA, não às 8h; e
 * uma mensagem fora do filtro não recebe aviso de fora do horário: quem não
 * entra no agente não fala por ele.
 *
 * A contagem da condução (fork) vem DEPOIS do adiamento pela janela, como antes,
 * para o job reagendado não contar duas vezes.
 */
import { MAX_TURNOS_POR_CONDUCAO } from '@/lib/cadencia/conducao/settings';
import { contarTurno, encerrarConducaoEPassarParaHumano } from '@/lib/cadencia/conducao/turno';

import { claimOfJob } from '../../queue/claim';
import { rescheduleJob } from '../../queue/queue';
import { turnoDisparaNasMensagens } from '../palavra-chave-do-gatilho';
import { agenteJaRespondeuNoAtendimento } from '../agente-ja-respondeu';
import { msAteAJanelaAbrir } from '../janela-de-atendimento';
import { enviaAvisoForaDoHorario, portasDeProducao } from '../aviso-fora-do-horario';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import { JobSettledError, avisoAoLeadDoTurno } from '../inbound-turn';
import type { ContextoDoTurno, Passo } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

export async function avaliarEntradaDoAgente(
  c: ContextoDoTurno,
  e: {
    routed: SaidaDoRoteamento['routed'];
    agentConfig: SaidaDoRoteamento['agentConfig'];
    inboundsPendentes: readonly string[];
    mensagemDoJob: string;
  },
): Promise<Passo<null>> {
  const { deps, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const { routed, agentConfig, inboundsPendentes, mensagemDoJob } = e;

  // O PÚBLICO DO AGENTE (#3722): nenhum agente publicado neste número atende o
  // público deste contato. SILÊNCIO, e o genérico não assume (venderia ao cliente
  // com contrato). Vale em todo turno; a mensagem segue na Central para o humano.
  if (!preview && 'silencioPeloPublico' in routed && routed.silencioPeloPublico === true) {
    runLog.info('turno pulado — nenhum agente publicado neste número atende ao público deste contato (#3722)', {
      kind: liveJob().kind,
      conversation_id: input.conversationId,
    });
    return { seguir: false, motivo: 'silencio_pelo_publico' };
  }

  // O FILTRO DE PALAVRA-CHAVE da versão publicada (#2679). O filtro decide se o
  // MODELO entra, nunca se a pessoa é ouvida (as detecções vieram antes).
  //
  // O QUE É JULGADO é `inboundsPendentes` (a mesma lista do handoff), e não só a
  // mensagem fixada no job: "oi" seguido de "quero um orçamento" entra pelo
  // segundo. Cada mensagem é julgada sozinha (`turnoDisparaNasMensagens`).
  //
  // O FILTRO DECIDE A ENTRADA, NÃO CADA MENSAGEM (#3142): a âncora do "já
  // engajado" é uma OUTBOUND DESTE AGENTE NESTE ATENDIMENTO
  // (`agente-ja-respondeu.ts`). A leitura só acontece com filtro configurado; erro
  // de leitura sobe e o turno é re-tentado pela fila (`false` calaria um cliente
  // já engajado).
  const agenteJaEngajado =
    !preview && liveJob().kind === 'inbound_turn' && agentConfig?.filtroDePalavraChave != null
      ? await agenteJaRespondeuNoAtendimento(pool, {
          organizationId: tenantId,
          conversationId: input.conversationId,
          agentId: agentConfig.agentId,
        })
      : false;
  // Um miss NÃO adia: não há "depois" em que a mesma mensagem venha a casar. O
  // turno é encerrado sem resposta e a mensagem segue visível na Central. Regex
  // quebrada, corpo sem texto ou nada a julgar ⇒ o turno SEGUE (falha aberta).
  if (
    !preview &&
    liveJob().kind === 'inbound_turn' &&
    agentConfig?.filtroDePalavraChave != null &&
    !agenteJaEngajado
  ) {
    const corposDoTurno =
      inboundsPendentes.length > 0
        ? inboundsPendentes
        : mensagemDoJob.trim() === ''
          ? []
          : [mensagemDoJob];
    if (!turnoDisparaNasMensagens(agentConfig.filtroDePalavraChave, corposDoTurno)) {
      runLog.info('turno pulado — mensagem fora do filtro de palavra-chave da versão publicada', {
        agent_id: agentConfig.agentId,
        agent_version_id: agentConfig.versionId,
        mensagens_pendentes: corposDoTurno.length,
      });
      return { seguir: false, motivo: 'fora_do_filtro_de_palavra_chave' };
    }
  }

  // Horário de funcionamento da versão publicada (spec da tela: TriggerEditor).
  // Vale SÓ para o turno inbound: a janela do lojista é sobre QUANDO ele atende
  // quem chega; o que segura o follow-up é a janela anti-ban (`pacing/engine.ts`).
  //
  // Adia, não descarta: o job volta a 'pending' na abertura, SEM consumir
  // attempts (`rescheduleJob`) — quem escreveu 22h é atendido às 8h. O throw é
  // o contrato de `JobSettledError`: o run já dispôs do job, main.ts no-opa.
  if (!preview && liveJob().kind === 'inbound_turn' && agentConfig?.janelaDeAtendimento != null) {
    const esperaMs = msAteAJanelaAbrir(agentConfig.janelaDeAtendimento, clock());
    if (esperaMs !== null) {
      // O AVISO DE FORA DO HORÁRIO (#1926) — ANTES do adiamento. Qualquer erro
      // aqui só PERDE um aviso: o turno é adiado de qualquer forma.
      try {
        const aviso = await enviaAvisoForaDoHorario(
          portasDeProducao(pool, deps.crmCfg.supabase, runLog),
          {
            organizationId: tenantId,
            conversationId: input.conversationId,
            contactId: leadId,
            channelSessionId: input.channelSessionId,
            texto: agentConfig.avisoForaDoHorario ?? null,
            janela: agentConfig.janelaDeAtendimento,
            agora: clock(),
          },
        );
        runLog.info(
          aviso.enviar
            ? 'aviso de fora do horário enviado'
            : 'aviso de fora do horário não enviado',
          { motivo: aviso.enviar ? 'enviado' : aviso.motivo },
        );
      } catch (err) {
        runLog.warn('aviso de fora do horário falhou — o turno segue adiado para a abertura', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
      await rescheduleJob(pool, liveJob().id, ctx.workerId, {
        acquiredAt: claimOfJob(liveJob())?.acquired_at,
        delayMs: esperaMs,
        reason:
          'fora do horário de funcionamento do agente — turno adiado para a abertura da janela',
      });
      runLog.info(
        'turno adiado — fora do horário de funcionamento configurado na versão publicada',
        {
          agent_id: agentConfig.agentId,
          espera_ms: esperaMs,
          janela: `${agentConfig.janelaDeAtendimento.start}-${agentConfig.janelaDeAtendimento.end}`,
        },
      );
      throw new JobSettledError(
        'fora do horário de funcionamento — job reagendado para a abertura da janela',
      );
    }
  }

  // CONDUÇÃO DA CADÊNCIA: cada turno conta. Depois dos adiamentos (janela
  // anti-ban e horário do agente), para o job reagendado não contar duas vezes.
  // Passou do teto, a IA para e uma pessoa assume.
  if (!preview && input.conducao) {
    const turnos = await contarTurno(pool, tenantId, input.conducao.id);
    if (turnos === null) {
      runLog.info('condução da cadência encerrada no meio-tempo — turno não executado', {
        conducao_id: input.conducao.id,
      });
      return { seguir: false, motivo: 'conducao_encerrada' };
    }
    if (turnos > MAX_TURNOS_POR_CONDUCAO) {
      await encerrarConducaoEPassarParaHumano(
        pool,
        input.conducao,
        'teto_de_turnos',
        runLog,
        avisoAoLeadDoTurno(deps, pool, liveJob(), input.channelSessionId, input.conversationId, runLog),
      );
      return { seguir: false, motivo: 'conducao_no_teto_de_turnos' };
    }
  }

  return { seguir: true, valor: null };
}
