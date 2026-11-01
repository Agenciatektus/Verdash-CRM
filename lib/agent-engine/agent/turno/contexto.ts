/**
 * F4 do turno da IA: contexto e system prompt (ADR-0006, fatia S2).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto ou número de awaits. As leituras da abertura seguem num `Promise.all`
 * único; o `system` sai igual byte a byte. Sem contexto do lead não há turno: a
 * falha de `get_lead_context` é lançada aqui mesmo, como antes.
 */
import { prospectingConversationContext } from '@/lib/prospecting/context';

import { getLeadContext } from '../../edge/crm/get-lead-context';
import { auxModelArgs, type AuxModelArgs } from '../aux-model-args';
import { getLeadState } from '../lead-state';
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from '../org-memory';
import { loadPlaybook } from '../playbook';
import type { TurnAgentResolution } from '../resolve-turn-agent';
import { loadSkills, renderSkillIndex } from '../skills';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import {
  CASES_SYSTEM_BLOCK,
  TRANSPARENCIA_SYSTEM_BLOCK,
  blocosDeAgendaResidentes,
  latestCheckpoint,
  loadInboundBodyForJob,
} from '../inbound-turn';
import type { ContextoDoTurno } from './portoes-de-entrada';

/** O que o orquestrador já resolveu antes de F4 (roteamento e F2). */
export interface EntradaDoContexto {
  agentConfig: TurnAgentResolution['config'];
  contextKnobs: { historyLimit: number; maxTokens: number };
  fusoDaOrg: string;
}

export async function carregarContextoDoTurno(c: ContextoDoTurno, e: EntradaDoContexto) {
  const { deps, pool, input, preview, tenantId, leadId } = c;
  const { agentConfig, contextKnobs, fusoDaOrg } = e;

  // Knobs por-turno: a versão publicada vence o env; sem ela, env (main.ts).
  const maxSteps = agentConfig?.maxSteps ?? deps.knobs.maxSteps;
  // Fallback de modelo das chamadas AUXILIARES (classificadores/compaction/promessa):
  // knob de env → modelo do agente PUBLICADO na tela → organizations.settings.llm.
  // Sem isso, self-host que configurou tudo pela tela (que não preenche default_model)
  // morria no primeiro classificador: "modelo LLM não definido".
  // A regra de ONDE o classificador auxiliar tira modelo + provider + credencial
  // mora em `aux-model-args.ts`, fora daqui, para poder ser exercitada por unit:
  // esta função precisa de banco, job e registry para rodar. Ver o defeito que a
  // originou (PR #151) no cabeçalho de lá.
  const argsAux = (configuredModel: string | undefined): AuxModelArgs =>
    auxModelArgs(configuredModel, agentConfig);

  /**
   * Os DOIS limites do histórico vêm da versão publicada — e o segundo vinha da
   * env, que é o defeito.
   *
   * A tela oferece "Tamanho máximo desse histórico" por agente e grava
   * `history_token_window` (default 8.000). O turno lia `historyMessageWindow`
   * dali e `maxTokens` de `LEAD_CONTEXT_MAX_TOKENS`, uma env com default 1.000
   * que sequer aparece no `.env.example`: quem configurava 8.000 na tela recebia
   * 1.000, sem nada dizer que o número não valia. Metade da versão publicada era
   * lida, metade não.
   *
   * O corte não morde na conversa curta de WhatsApp — ali quem limita é a janela
   * de mensagens (20 por padrão). Ele morde exatamente onde dói: mensagem longa
   * e áudio transcrito, quando o histórico é a única coisa que sustenta o fio da
   * conversa. O ramo sem versão publicada segue com os knobs da instalação, que
   * é o único caso em que ela é a fonte legítima.
   */
  const turnContextKnobs =
    agentConfig !== null
      ? {
          historyLimit: agentConfig.historyMessageWindow,
          maxTokens: agentConfig.historyTokenWindow,
        }
      : contextKnobs;

  // Ritual de abertura: playbook por ponteiro + checkpoint + contexto curado.
  // Com agente publicado, o system_prompt DELE é a camada tenant (platform de
  // compliance continua à frente, sempre).
  //
  // As leituras da abertura correm em QUATRO trilhas paralelas: nenhuma escreve,
  // nenhuma está sob lock ou transação, e a única dependência entre elas — o
  // playbook precisa do contexto de prospecção — fica dentro da mesma trilha.
  // Em série eram 8 RTTs ao Supabase remoto antes de o modelo começar; assim são
  // 2 (a trilha mais funda). As 4 consultas em voo por turno são o formato das
  // trilhas, não um encaixe no pool: com QUEUE_MAX_CONCURRENCY=8 turnos abrindo
  // juntos, o pico chega a 32 leituras sobre 10 conexões (default do pg, knob
  // DB_POOL_MAX). O pg enfileira e nenhuma destas leituras segura conexão, então
  // o pior caso é espera de fila no pico, não erro nem deadlock.
  const [playbook, [skills, currentInboundText], orgMemory, [previous, leadState]] =
    await Promise.all([
      (async () => {
        const prospectingContext =
          !preview && input.conversationId
            ? await prospectingConversationContext(pool, tenantId, input.conversationId)
            : '';
        return loadPlaybook(
          pool,
          tenantId,
          agentConfig !== null ? { agentLayer: agentConfig.systemPrompt + prospectingContext } : undefined,
        );
      })(),
      // Skills situacionais (F3-09): índice (name+description) SEMPRE residente — vai junto do
      // system do playbook, no prefixo estável org-wide (disclosure progressivo; cacheável F2-17).
      // O CORPO só carrega no match, no sufixo por-lead (mais abaixo). loadSkills resolve os
      // ponteiros a cada run: trocar/rollback de skill = mover o ponteiro, sem restart.
      (async () =>
        [
          await loadSkills(pool, tenantId),
          input.inboundMessageId === undefined
            ? null
            : await loadInboundBodyForJob(pool, {
                tenantId,
                conversationId: input.conversationId,
                inboundMessageId: input.inboundMessageId,
              }),
        ] as const)(),
      // Fase 1 (harness): memória geral da org — prefixo estável, resolvida a cada
      // turno como o playbook (publicar ⇒ próximo turno vale). composeSystemPrompt já
      // encaixa playbook + memória + índice de skills no prefixo cacheável.
      loadOrgMemory(pool, tenantId),
      (async () =>
        [
          preview ? (preview.previous ?? null) : await latestCheckpoint(pool, tenantId, leadId),
          preview?.kind === 'sandbox' ? null : await getLeadState(pool, tenantId, leadId),
        ] as const)(),
    ]);
  const skillIndex = renderSkillIndex(skills);
  const systemWithMemory = composeSystemPrompt({
    playbookPrompt: playbook.prompt,
    orgMemoryBlock: renderOrgMemory(orgMemory),
    skillIndex,
  });
  // Spec 15 §5.2: bloco das tools de caso SEMPRE residente (não invalida o prefixo
  // cacheável — mesmo espírito do índice de skills) quando a tela habilita. O bloco da
  // Agenda segue o mesmo padrão, condicionado a `crm_book_appointment` estar entre as
  // tools publicadas — ver comentário de `agendaSystemBlock`. `TRANSPARENCIA_SYSTEM_BLOCK`
  // não depende de nenhuma feature — todo agente publicado o recebe.
  const blocosResidentes = [systemWithMemory, TRANSPARENCIA_SYSTEM_BLOCK];
  if (agentConfig !== null && agentConfig.casesEnabled) blocosResidentes.push(CASES_SYSTEM_BLOCK);
  // Spec 15 §5.2 / doutrina da Agenda: a régua é o que o agente TEM — ver
  // `blocosDeAgendaResidentes`, que decidiu isto num lugar só para poder ser
  // testada (o bloco da cadeia nomeia `crm_list_event_types`, e nomear
  // ferramenta ausente faz o modelo tentar chamá-la).
  if (agentConfig !== null) blocosResidentes.push(...blocosDeAgendaResidentes(agentConfig.toolIds));
  if (preview)
    blocosResidentes.push(
      'MODO PRÉVIA: proponha a resposta com send_message. Operações são propostas separadas; nunca diga que executou uma proposta. Nenhum envio real acontece.',
    );
  const system = blocosResidentes.join('\n\n');
  const openingContext = preview
    ? preview.context
    : await getLeadContext(
        pool,
        deps.crmCfg,
        { tenantId, leadId, conversationId: input.conversationId, fuso: fusoDaOrg },
        turnContextKnobs,
      );
  if (!openingContext.ok) {
    // Sem contexto não há turno: transiente (CRM fora) OU permanente (lead
    // sumiu) — ambos re-tentam pela fila e morrem em 'dead' se persistirem.
    throw new Error(`abertura do turno falhou em get_lead_context (${openingContext.error.code})`);
  }

  return {
    maxSteps,
    argsAux,
    turnContextKnobs,
    skills,
    currentInboundText,
    previous,
    leadState,
    system,
    openingContext,
  };
}
