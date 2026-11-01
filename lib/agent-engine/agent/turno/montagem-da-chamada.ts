/**
 * F9 do turno da IA, terceira parte: a abertura que vai ao modelo (ADR-0006, fatia S8).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: projeção do contexto, `buildOpening`,
 * sufixos por lead (agora, condução, skills, hint do estágio, bolhas, caso aguardando,
 * roteiro, revisão humana) e as partes nativas de mídia. Devolve `openingMessages`
 * (chamada principal e correção) e `openingTextOnly` (fechamento).
 */
import type { ModelMessage } from '../../edge/llm/run-model-call';
import { getCaseAwaitingLead } from '../human-cases';
import { buildNativeMediaParts } from '../media-parts';
import { turnoProjeta } from '../projecao';
import { instrucaoDeBolhas } from '../split-message';
import { blocoDaConducao, nomeDaEtapa } from '@/lib/cadencia/conducao/turno';
import { renderAgora } from '@/lib/tempo/agora';
import type { capacidadesEntreguesAoOperador } from '../entrega-de-capacidade';
import type { carregarContextoDoTurno } from './contexto';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { prepararContextoDoTurno } from './preparo-do-contexto';
import type { SaidaDoRoteamento } from './roteamento';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;
type SaidaDoPreparo = Awaited<ReturnType<typeof prepararContextoDoTurno>>;

export interface EntradaDaAbertura {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  fusoDaOrg: string;
  leadState: SaidaDoContexto['leadState'];
  currentInboundText: SaidaDoContexto['currentInboundText'];
  roteiro: SaidaDoPreparo['roteiro'];
  effectivePrevious: SaidaDoPreparo['effectivePrevious'];
  effectiveContext: SaidaDoPreparo['effectiveContext'];
  notesIndexBlock: SaidaDoPreparo['notesIndexBlock'];
  compromissosBlock: SaidaDoPreparo['compromissosBlock'];
  origemBlock: SaidaDoPreparo['origemBlock'];
  mcpToolIdsDoTurno: readonly string[];
  entregues: ReturnType<typeof capacidadesEntreguesAoOperador>;
  matchedSkillsBlock: string;
  stageHintBlock: string;
}

export async function montarAberturaDaChamada(c: ContextoDoTurno, r: EntradaDaAbertura) {
  const { deps, pool, input, preview, tenantId, clock, runLog } = c;
  const {
    agentConfig, fusoDaOrg, leadState, currentInboundText, roteiro, effectivePrevious, effectiveContext,
    notesIndexBlock, compromissosBlock, origemBlock, mcpToolIdsDoTurno, entregues, matchedSkillsBlock,
    stageHintBlock,
  } = r;

  // Spec 16 §4: a projeção arma quando NENHUMA ferramenta de catálogo entrou —
  // é exatamente o turno em que os ids do contexto não têm uso, e portanto o
  // único em que removê-los não custa nada. Logado porque "por que o prompt
  // deste turno é diferente do daquele?" precisa ter resposta no trace.
  const projetaContexto = turnoProjeta(mcpToolIdsDoTurno);
  runLog.info('projeção do contexto do turno', {
    projeta: projetaContexto,
    mcp_tools_no_turno: mcpToolIdsDoTurno.length,
  });
  const openingBase = input.buildOpening({
    previous: effectivePrevious,
    leadState,
    context: effectiveContext,
    notesIndexBlock,
    projeta: projetaContexto,
    entregues,
    compromissosBlock,
    origemBlock,
    ...(currentInboundText !== null ? { currentInboundText } : {}),
  });
  // Sufixos por-lead (situacionais, voláteis — depois do prefixo cacheável F2-17): corpos de
  // skill casadas (F3-09) + hint do classificador (F3-11) + instrução de split (F4-xx, quando
  // split_messages está on — Onda 4). Vazios são omitidos.
  const splitHint = instrucaoDeBolhas(agentConfig?.splitMessages ?? false);
  // Spec 15: o `case_id` real do caso 'awaiting_lead' desta conversa, se houver — sem
  // isso o modelo nunca consegue chamar provide_case_update quando o lead simplesmente
  // responde (o caminho comum; case_reply_turn só cobre a AÇÃO do humano). Sufixo
  // por-lead (volátil) — nunca no prefixo cacheável (o case_id muda a cada caso).
  const caseAwaitingLead =
    preview?.kind !== 'sandbox' && agentConfig !== null && agentConfig.casesEnabled
      ? await getCaseAwaitingLead(pool, tenantId, input.conversationId)
      : null;
  const caseAwaitingLeadBlock =
    caseAwaitingLead !== null
      ? `## Caso aguardando resposta deste cliente\n` +
        `Há um caso aberto (case_id: ${caseAwaitingLead.id}) esperando uma informação dele: "${caseAwaitingLead.ask}". ` +
        `Se a mensagem dele responde a isso, chame provide_case_update com este case_id e a informação recebida — ` +
        `NÃO diga que já repassou/avisou o responsável sem chamar a tool.`
      : '';
  // ── O RELÓGIO DO TURNO ────────────────────────────────────────────────────
  //
  // Entra AQUI, e o lugar é a metade do conserto.
  //
  // No `system` (o prefixo estável org-wide, F2-17) ele invalidaria o cache de
  // prompt de TODOS os leads a cada turno, porque muda a cada segundo — é o que
  // `stable-prefix.ts` proíbe em letra. No sufixo por-lead ele é volátil entre
  // iguais, e custa os ~50 tokens dele.
  //
  // PRIMEIRO da lista de propósito: a âncora temporal precede o material que o
  // modelo vai usar para decidir data — corpo de skill, hint do classificador,
  // caso pendente. E `executarTurnoDoAgente` é o ponto por onde passam os TRÊS
  // turnos conversacionais (inbound, follow-up e resposta a caso), então um
  // ponto só cobre os três — e alcança de carona a chamada de fechamento, que
  // reusa `openingTextOnly` e é onde nasce o `prazo` ISO da declaração.
  const agoraBlock = renderAgora(clock(), fusoDaOrg);
  // O objetivo da condução da cadência vai no SUFIXO por lead, nunca no
  // `system`: muda por conversa e invalidaria o prefixo cacheável da org.
  const conducaoDoPrompt = input.conducao ?? preview?.conducao;
  const conducaoBlock = conducaoDoPrompt
    ? blocoDaConducao(
        conducaoDoPrompt,
        await nomeDaEtapa(pool, tenantId, conducaoDoPrompt.etapa_alvo_id),
      )
    : '';
  const openingSuffixes = [
    agoraBlock,
    conducaoBlock,
    matchedSkillsBlock,
    stageHintBlock,
    splitHint,
    caseAwaitingLeadBlock,
    roteiro?.bloco ?? '',
    preview?.feedback ? '## Revisão humana deste atendimento\n' + preview.feedback : '',
  ].filter((b) => b !== '');
  const openingText =
    openingSuffixes.length === 0
      ? openingBase
      : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`;
  // Onda 3 (aprimoramento): mídia inbound recente vira part nativa (image/file) SÓ para
  // provider+modelo capazes (T2 modelCapabilities) — modelo incapaz/desconhecido → [] e o
  // derivado textual (já embutido em openingText via LeadContextMessage) cobre sozinho.
  const nativeParts =
    preview?.kind === 'sandbox'
      ? []
      : await buildNativeMediaParts({
          messages: effectiveContext.messages,
          provider: agentConfig?.provider ?? 'anthropic',
          model: agentConfig?.model ?? '',
          multimodalInput: agentConfig?.multimodalInput ?? false,
          admin: deps.crmCfg.supabase,
        });
  const openingTextOnly: ModelMessage[] = [{ role: 'user', content: openingText }];
  const openingMessages: ModelMessage[] =
    nativeParts.length === 0
      ? openingTextOnly
      : [{ role: 'user', content: [{ type: 'text', text: openingText }, ...nativeParts] }];

  return { openingMessages, openingTextOnly };
}
