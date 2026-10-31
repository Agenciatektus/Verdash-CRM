/**
 * F8 do turno da IA: ferramentas de leitura (ADR-0006, fatia S6).
 *
 * Ferramentas MOVIDAS de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * texto, ordem ou número de awaits: `get_lead_context`, `search_knowledge`, `get_lead_note` e `read_skill_reference`. Cada `criar*` recebe por parâmetro o que a
 * closure lia do escopo do turno; o que ela escrevia vai no `EstadoDoTurno` (o mesmo
 * objeto do orquestrador). Quando cada uma entra no turno continua decidido lá.
 */
import { tool } from '../../../edge/llm/run-model-call';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import { getLeadContext, type LeadContextResult } from '../../../edge/crm/get-lead-context';
import type { criarEvidenciasComerciaisDoTurno } from '../../../guardrails/promise/evidencias-comerciais';
import { citationsFromHits, searchKnowledge } from '../../search-knowledge';
import { getLeadNoteBody } from '../../lead-notes';
import { readSkillReference } from '../../skill-references';
import type { matchSkills } from '../../skills';
import { projetarContexto, projetarRetornoDeTool, turnoProjeta, type ContextoProjetado } from '../../projecao';
import type { carregarContextoDoTurno } from '../contexto';
import type { SaidaDoRoteamento } from '../roteamento';
import type { EstadoDoTurno } from '../estado-do-turno';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { AGENT_TOOL_DEFS } from '../../inbound-turn';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;

export function criarGetLeadContext(
  c: ContextoDoTurno,
  r: { fusoDaOrg: string; turnContextKnobs: SaidaDoContexto['turnContextKnobs']; mcpToolIdsDoTurno: string[]; noteRunError: (err: Error) => void },
) {
  const { deps, pool, input, preview, tenantId, leadId } = c;
  const { fusoDaOrg, turnContextKnobs, mcpToolIdsDoTurno, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.get_lead_context,
    execute: async (): Promise<
      | LeadContextResult
      // A variante PROJETADA é um tipo próprio, não um `LeadContext` disfarçado
      // por cast: são payloads diferentes, e um `as` aqui faria o compilador
      // parar de vigiar exatamente a fronteira que este código existe para
      // manter. Note que `lgpd` não viaja nela — base legal e anonimização são
      // dado de conformidade que o runtime usa nos gates, e que o modelo nunca
      // precisou ler (no caminho não-projetado ele já ia junto; aqui para).
      | { ok: true; context: ContextoProjetado; tokenCount: number }
      | { ok: false; error: { code: string; message: string } }
    > => {
      try {
        const releitura = preview
          ? preview.context
          : await getLeadContext(
              pool,
              deps.crmCfg,
              { tenantId, leadId, conversationId: input.conversationId, fuso: fusoDaOrg },
              turnContextKnobs,
            );
        // Sem esta linha a projeção da abertura seria decorativa: bastaria o
        // modelo chamar esta ferramenta para receber o contexto CRU de volta,
        // com `lead_id`, `conversation_id` e caminho de mídia. A releitura é a
        // mesma superfície da abertura e tem de obedecer à mesma regra —
        // proteger só a porta da frente é não ter protegido.
        if (releitura.ok && turnoProjeta(mcpToolIdsDoTurno)) {
          return {
            ok: true,
            context: projetarContexto(releitura.context),
            tokenCount: releitura.tokenCount,
          };
        }
        return releitura;
      } catch (err) {
        // bug de programação: ensina o modelo a encerrar E derruba o job no fim
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao ler o contexto — encerre o turno agora.',
          },
        };
      }
    },
  });
}

export function criarSearchKnowledge(
  c: ContextoDoTurno,
  r: { agentConfig: SaidaDoRoteamento['agentConfig']; evidenciasComerciais: ReturnType<typeof criarEvidenciasComerciaisDoTurno>; mcpToolIdsDoTurno: string[] },
  estado: EstadoDoTurno,
) {
  const { deps, job, pool, tenantId, runLog } = c;
  const { agentConfig, evidenciasComerciais, mcpToolIdsDoTurno } = r;
  return tool({
    ...AGENT_TOOL_DEFS.search_knowledge,
    execute: async ({ query }) => {
      const fontes = agentConfig?.knowledgeSourceIds ?? [];
      if (fontes.length === 0 && agentConfig?.activeKbVersionId == null) {
        return {
          ok: false,
          error: {
            code: 'no_knowledge_base',
            message: 'este agente não tem material de consulta habilitado — siga sem ele.',
          },
        };
      }
      const out = await searchKnowledge(
        pool,
        {
          organizationId: tenantId,
          knowledgeSourceIds: fontes,
          kbVersionId: agentConfig?.activeKbVersionId ?? null,
          query,
          topK: agentConfig?.ragTopK ?? 5,
          threshold: agentConfig?.ragSimilarityThreshold ?? 0.4,
          jobId: job?.id,
          agentId: agentConfig?.agentId ?? null,
        },
        { log: runLog, embed: deps.embed },
      );
      if (out.ok && out.results.length > 0) {
        evidenciasComerciais.registrarConhecimento(out);
        // As citações são montadas AQUI, pelo código, a partir do resultado
        // cru — é por isso que os ids podem sair do que vai ao modelo sem
        // perder nada: quem precisa deles é esta linha, não o modelo.
        estado.pendingCitations = citationsFromHits(out.results);
      }
      // `chunk_id` e `knowledge_source_id` viajavam CRUS para o modelo em toda
      // busca com RAG — dois UUIDs por resultado, sem uso nenhum do lado dele
      // (nenhuma ferramenta os aceita como argumento). UUID cru na resposta ao
      // cliente foi MEDIDO nesta base; esta era uma fonte silenciosa dele.
      return turnoProjeta(mcpToolIdsDoTurno) ? projetarRetornoDeTool(out) : out;
    },
  });
}

// get_lead_note é READ-ONLY: relê o corpo de UMA nota do lead pelo id (sob demanda —
// o índice só traz headline). Escopado por (tenant, lead) do closure.
export function criarGetLeadNote(
  c: ContextoDoTurno,
  r: { noteRunError: (err: Error) => void },
) {
  const { pool, tenantId, leadId } = c;
  const { noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.get_lead_note,
    execute: async ({ note_id }) => {
      try {
        const noteId = note_id.trim();
        const body = noteId === '' ? null : await getLeadNoteBody(pool, tenantId, leadId, noteId);
        if (body === null) {
          return {
            ok: false,
            error: {
              code: 'note_not_found',
              message:
                'não há nota com esse id na memória deste lead — confira o id no índice de memória.',
            },
          };
        }
        return { ok: true, note_id: noteId, body };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao ler a nota — encerre o turno agora.',
          },
        };
      }
    },
  });
}

export function criarReadSkillReference(
  c: ContextoDoTurno,
  r: { skillMatch: ReturnType<typeof matchSkills>; noteRunError: (err: Error) => void },
) {
  const { deps, tenantId } = c;
  const { skillMatch, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.read_skill_reference,
    execute: async ({ skill_name, ref_path }) => {
      try {
        return await readSkillReference(
          { admin: deps.crmCfg.supabase },
          {
            organizationId: tenantId,
            matchedSkills: skillMatch.matched,
            skillName: skill_name,
            refPath: ref_path,
          },
        );
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao ler a reference da skill — encerre o turno agora.',
          },
        };
      }
    },
  });
}
