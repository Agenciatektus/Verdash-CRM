/**
 * Destino do card pela intenção do roteador (#2155): o fim da F3 do turno da IA
 * (ADR-0006, S4). Código movido de `resolverRoteamentoDoTurno`, que o chama no mesmo ponto.
 */

import { aplicaDestinoDaIntencao, funisDeProdutoDoRoteador } from '../destino-da-intencao';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

/**
 * O destino do card pela intenção (#2155), no fim do roteamento (ADR-0006, S4). Movido
 * de `resolverRoteamentoDoTurno`, que o chama no mesmo ponto; separado só para caber no
 * teto de 300 linhas por arquivo.
 */
export async function aplicarDestinoDoCardDaIntencao(
  c: ContextoDoTurno,
  {
    destinoPipelineId,
    destinoStageId,
    routed,
    agentConfig,
  }: Pick<SaidaDoRoteamento, 'routed' | 'agentConfig'> & {
    destinoPipelineId: string | null;
    destinoStageId: string | null;
  },
): Promise<void> {
  const { deps, preview, tenantId, leadId, runLog, liveJob } = c;
  // #2155 — A INTENÇÃO TAMBÉM DIZ PARA ONDE O CARD VAI. O roteador escolhia o
  // agente e o card ficava no funil de entrada: o agente do produto não escrevia
  // nele, a conversa morria no time errado. Aplicado DEPOIS da decisão de
  // roteamento (mesmo agente, mesma intenção) e ANTES do turno do agente, para
  // que ele já responda com o card no funil certo. Silencioso por design: card
  // já no destino, destino já ocupado e alvo ambíguo não são erro (ver
  // `destino-da-intencao.ts`).
  if (!preview && destinoPipelineId !== null) {
    try {
      const destino = await aplicaDestinoDaIntencao({
        admin: deps.crmCfg.supabase,
        organizationId: tenantId,
        contactId: leadId,
        destinoPipelineId,
        destinoStageId,
        // Os funis de produto do roteador: quem tem card num deles e fala de outro
        // ganha um card a mais, não troca de funil (consórcio ↔ investimentos).
        funisDeProduto:
          routed.routerId === null
            ? []
            : await funisDeProdutoDoRoteador(deps.crmCfg.supabase, tenantId, routed.routerId),
        handlerCtx: {
          organization_id: tenantId,
          actor: {
            type: 'ai_agent',
            id: 'agent-engine',
            role: 'ai_operator',
            ...(agentConfig === null ? {} : { agent_id: agentConfig.agentId }),
          },
          requestId: liveJob().id,
        },
      });
      runLog.info('destino da intenção aplicado', {
        status: destino.status,
        pipeline_id: destinoPipelineId,
        intent: routed.intentName,
        ...(destino.error === undefined ? {} : { error: destino.error }),
        ...(destino.origemId === undefined ? {} : { origem: destino.origemId }),
        ...(destino.cloneId === undefined ? {} : { clone: destino.cloneId }),
      });
    } catch (err) {
      // Nunca derruba a resposta ao lead por causa do destino do card.
      //
      // A recusa da RÉGUA (#2297, caminho 1) não chega mais aqui: ela é
      // capturada dentro de `aplicaDestinoDaIntencao`, que conhece o negócio de
      // origem e abre o aviso na Central antes de devolver `recusado` — este
      // `catch` é a rede para o que não é recusa prevista (falha de banco na
      // leitura, por exemplo), e segue sem aviso porque não há negócio a apontar.
      runLog.warn('destino da intenção não aplicado', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        pipeline_id: destinoPipelineId,
      });
    }
  }
}
