/**
 * F9 do turno da IA, primeira parte: o conjunto de ferramentas que vai ao modelo
 * (ADR-0006, fatia S8).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: ferramentas MCP da tela, capacidades
 * entregues ao Operador, allowlist da condução, política do preview e o breaker.
 * A limpeza da conexão MCP volta ao orquestrador por `registrarLimpezaDoMcp` no
 * mesmo instante em que antes era atribuída, para o `finally` dele fechar a conexão
 * mesmo se algo lançar depois.
 */
import type { ToolSet } from '../../edge/llm/run-model-call';
import { buildMcpTurnTools } from '../../edge/crm/mcp-tools';
import type { criarEvidenciasComerciaisDoTurno } from '../../guardrails/promise/evidencias-comerciais';
import { capacidadesEntreguesAoOperador, catalogoEntregueAoOperador } from '../entrega-de-capacidade';
import { copiarFotoNoStorage, PASTA_DE_TESTE_DE_MIDIA, prepararFotosDoProduto } from '../fotos-do-produto';
import { applyPreviewPolicy, previewGateContext } from '../preview';
import { READ_ONLY_TOOLS, wrapToolsWithBreaker } from '../tool-breaker';
import { restringirAConducao } from '@/lib/cadencia/conducao/ferramentas';
import { filtrarRawTools } from '@/lib/cadencia/conducao/presets';
import { restringirConfigAConducao } from '@/lib/cadencia/conducao/turno';
import { AGENDA_TOOL_NAMES, avisarCapacidadesAusentes } from '../inbound-turn';
import type { EstadoDoTurno } from './estado-do-turno';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

type PoliticaDoPreview = Parameters<typeof applyPreviewPolicy>;

/** O que F3, F7 e F8 entregam à montagem das ferramentas. */
export interface EntradaDasFerramentas {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  /** As ferramentas do engine; mutadas aqui como eram no corpo do turno. */
  rawTools: ToolSet;
  evidenciasComerciais: ReturnType<typeof criarEvidenciasComerciaisDoTurno>;
  /** Acumula os ids MCP do turno (lido depois pela projeção da abertura). */
  mcpToolIdsDoTurno: string[];
  semanticClassifier: PoliticaDoPreview[4];
  conferirAfirmacoes: PoliticaDoPreview[7];
  registrarLimpezaDoMcp: (limpar: () => Promise<void>) => void;
}

export async function montarConjuntoDeFerramentas(
  c: ContextoDoTurno,
  r: EntradaDasFerramentas,
  estado: EstadoDoTurno,
) {
  const { deps, pool, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const {
    agentConfig, rawTools, evidenciasComerciais, mcpToolIdsDoTurno, semanticClassifier, conferirAfirmacoes,
    registrarLimpezaDoMcp,
  } = r;

  if (agentConfig !== null && agentConfig.toolIds.length > 0) {
    try {
      // As de OPERAÇÃO saem antes de serem montadas, quando o Operador as tem.
      // Medido: são elas que carregavam 2 dos 3 vazamentos (o DADO que devolvem),
      // e tirá-las levou a taxa de 30% para 10% — ver RELATORIO-passo6.md.
      const catalogoEntregue = catalogoEntregueAoOperador({
        operadorLigado: agentConfig.operatorEnabled,
        ferramentasDoOperador: agentConfig.operatorToolIds,
        ferramentasDoConversador: agentConfig.toolIds,
      });
      const configSemOperador =
        catalogoEntregue.length === 0
          ? agentConfig
          : {
              ...agentConfig,
              toolIds: agentConfig.toolIds.filter((t) => !catalogoEntregue.includes(t)),
            };
      // Ponto 1 da allowlist da condução: ferramentas ∩ objetivo, funis ∩ o da
      // cadência. Idempotente com a restrição que o handler já aplicou.
      const conducaoDoTurno = input.conducao ?? preview?.conducao;
      const configDoTurno = conducaoDoTurno
        ? restringirConfigAConducao(configSemOperador, conducaoDoTurno)
        : configSemOperador;
      if (catalogoEntregue.length > 0) {
        runLog.info('capacidades de catálogo entregues ao operador', {
          entregues: catalogoEntregue,
        });
      }
      const mcp = await buildMcpTurnTools(
        deps.crmCfg,
        {
          organizationId: tenantId,
          jobId: preview?.runId ?? liveJob().id,
          contactId: leadId || null,
          conversationId: input.conversationId,
        },
        configDoTurno,
        runLog,
        preview ? { readOnly: true } : undefined,
      );
      if (mcp !== null) {
        registrarLimpezaDoMcp(mcp.cleanup);
        for (const [name, mcpTool] of Object.entries(mcp.tools)) {
          if (name in rawTools) continue;
          if (
            (name === 'crm_search_products' || name === 'crm_search_knowledge') &&
            typeof mcpTool.execute === 'function'
          ) {
            const executeOriginal = mcpTool.execute.bind(mcpTool);
            rawTools[name] = {
              ...mcpTool,
              execute: (async (...args: Parameters<typeof executeOriginal>) => {
                const resultado = await executeOriginal(...args);
                // O modelo escolhe a consulta, nunca fornece a autorização.
                // A ponte MCP já aplica organização, papel e escopo de leitura.
                if (name === 'crm_search_products') evidenciasComerciais.registrarCatalogo(resultado);
                else evidenciasComerciais.registrarConhecimento(resultado);
                return resultado;
              }) as typeof mcpTool.execute,
            };
            continue;
          }
          // Marca a EXECUÇÃO (não só a decisão de chamar) — é isso que o agendaStallGate
          // precisa saber para não vetar um turno que já checou a agenda de verdade.
          if (AGENDA_TOOL_NAMES.has(name) && typeof mcpTool.execute === 'function') {
            const executeOriginal = mcpTool.execute.bind(mcpTool);
            rawTools[name] = {
              ...mcpTool,
              execute: (async (...args: Parameters<typeof executeOriginal>) => {
                estado.agendaToolCalledThisTurn = true;
                return executeOriginal(...args);
              }) as typeof mcpTool.execute,
            };
          } else {
            rawTools[name] = mcpTool;
          }
        }
        mcpToolIdsDoTurno.push(...mcp.toolIds);
        runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
      }
    } catch (err) {
      // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
      // derruba o turno — a conversa do cliente não pode morrer porque uma tool
      // extra falhou. Isso continua certo.
      //
      // O que estava errado era o DEPOIS. A versão anterior deste comentário
      // dizia "o humano vê o log". Não vê: o log sai no stdout do worker, num
      // contêiner de VPS que o dono do negócio nunca abre. Medido num turno
      // real — o agente atendeu sem NENHUMA das capacidades que o humano tinha
      // ligado na tela, e a única pista existia num log que ninguém lê. É
      // falha-em-verde: anunciada na tela, ausente na execução, nada contando.
      const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      runLog.error('tools MCP da tela não montadas — turno segue sem elas', { error: detalhe });
      if (preview)
        preview.result.impediments.push({
          code: 'capabilities_unavailable',
          message: 'Não foi possível carregar as capacidades configuradas.',
        });
      else await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
    }
  }

  // ── A CURA (spec 16, passo 6) ───────────────────────────────────────────────
  //
  // As ferramentas de escrita saem do Conversador quando o Operador as assumiu.
  // O gate de vazamento é rede — barra na saída e ensina; isto é a cura: o
  // modelo não pode repetir o nome de uma ferramenta que nunca viu, e foi pelo
  // NOME que o vazamento voltou depois de a descrição ser limpa.
  //
  // A remoção é CONDICIONAL a o novo dono existir (ver entrega-de-capacidade):
  // tirar de um lado sem garantir o outro não separa papéis, perde capacidade.
  const entregues = capacidadesEntreguesAoOperador({
    operadorLigado: agentConfig?.operatorEnabled ?? false,
    ferramentasDoOperador: agentConfig?.operatorToolIds ?? [],
  });
  for (const nome of entregues) delete rawTools[nome];
  if (entregues.length > 0) {
    runLog.info('capacidades entregues ao operador — fora do turno do conversador', {
      entregues,
    });
  }

  // Ponto 2 da allowlist da condução + anti-IDOR, ANTES da política de preview
  // (no assistido o rascunho vê exatamente o que o automático veria). Fica só
  // o que o objetivo permite, e toda ferramenta recusa ids de outra pessoa.
  const conducaoDasTools = input.conducao ?? preview?.conducao;
  if (conducaoDasTools) {
    const alvo = conducaoDasTools;
    const filtradas = restringirAConducao(filtrarRawTools(rawTools, alvo.preset), {
      leadId: alvo.lead_id,
      contactId: alvo.contact_id,
      conversationId: alvo.conversation_id,
      agendamentoEhDaConducao: async (appointmentId) => {
        const { rows } = await pool.query<{ ok: boolean }>(
          `select true as ok from calendar_appointments
            where organization_id = $1 and id = $2 and contact_id = $3`,
          [tenantId, appointmentId, alvo.contact_id],
        );
        return rows.length > 0;
      },
    });
    for (const nome of Object.keys(rawTools)) delete rawTools[nome];
    Object.assign(rawTools, filtradas);
    runLog.info('ferramentas restritas à condução da cadência', {
      conducao_id: alvo.id,
      ferramentas: Object.keys(rawTools),
    });
  }

  // Circuit breaker de tools (F2-15): estado no closure DESTA invocação — zera
  // entre runs por construção (mesma garantia de isolamento do resto do run).
  if (preview && rawTools.get_lead_note)
    rawTools.get_lead_note = {
      ...rawTools.get_lead_note,
      execute: async () => ({ ok: true, notes: preview.notes ?? [] }),
    };
  const previewContext = preview
    ? await previewGateContext(pool, preview, runLog, clock())
    : null;
  const previewTools =
    preview && previewContext
      ? applyPreviewPolicy(
          rawTools,
          preview,
          {
            ...previewContext,
            disclosure: {
              ...previewContext.disclosure,
              mode: deps.knobs.disclosureMode ?? 'inject',
            },
          },
          () => estado.pendingCitations,
          semanticClassifier,
          () => ({
            agenda: {
              active: previewContext.agenda?.active ?? false,
              ferramentas: previewContext.agenda?.ferramentas ?? [],
              toolCalledThisTurn: estado.agendaToolCalledThisTurn,
            },
          }),
          // #2490 — a MESMA `prepararFotosDoProduto` do caminho de produção,
          // com a MESMA cópia por service role e a MESMA query no catálogo:
          // a prévia só troca o destino, a pasta `dry-run` da organização em vez
          // da conversa: anexo em pasta de conversa seria efeito no cliente —
          // proibido no preview. Vale para o sandbox e para o rascunho assistido
          // (que tem conversa, mas não pode anexar nela). A pasta é permanente:
          // o nome da cópia é determinístico, então repetir o teste não duplica.
          // Nada é enviado: o `send_message` da prévia nem chega perto do canal.
          (codigo: string) =>
            prepararFotosDoProduto(pool, copiarFotoNoStorage(runLog), {
              tenantId,
              conversationId: PASTA_DE_TESTE_DE_MIDIA,
              codigo,
            }),
          // #2923 — a conferência de fato do turno entra na prévia: o mesmo
          // conferidor criado acima, com as evidências que as ferramentas
          // consultaram NESTE turno. É ele que grava a observação e que faz um
          // `contradiz`/`nao_esta_na_base` aparecer para quem revisa o rascunho
          // (impedimento no assistido, aviso no Teste) em vez de sair calado.
          conferirAfirmacoes,
        )
      : rawTools;
  const tools = wrapToolsWithBreaker(previewTools, {
    thresholds: deps.knobs.breaker,
    readOnlyTools: READ_ONLY_TOOLS,
    log: runLog, // os warns dos gates do breaker saem carimbados com o run
  });

  return { tools, entregues };
}
