import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/tasks — as tarefas da organização, em ordem de prazo.
 * POST /api/v1/tasks — cria uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). Duas coisas do original
 * NÃO vieram, e as duas por motivo escrito:
 *
 *  1. **A lista de "agendamentos" derivada de `custom_fields`.** O GET original
 *     varria `crm_leads` procurando `agendamento_data`, `agendamento_hora`,
 *     `procedimento` e `agendamento_status` e sintetizava itens com título
 *     `🗓️ Fulano (Limpeza)`. Para a clínica dele isso era a agenda inteira; num
 *     produto que já tem `calendar_appointments` (migration 0177) seria uma
 *     SEGUNDA verdade sobre o mesmo compromisso, alimentada por um jsonb sem
 *     schema — e escrita em vocabulário de um nicho só.
 *
 *  2. **O fallback para `custom_fields.tasks` quando a tabela não existe.** O
 *     original capturava `42P01`/`PGRST205` e passava a gravar as tarefas dentro
 *     do lead. Isso existia porque lá a tabela vivia só no `baseline.sql`, sem
 *     migration — quem aplicasse `migrations/` não a teria. Aqui a 0210 fecha
 *     essa lacuna, e o fallback vira o pior tipo de rede: ele transforma "o
 *     banco desta instalação está desatualizado" em sucesso silencioso, com o
 *     dado indo para um lugar que nenhuma lista, índice ou policy alcança.
 *     Falhar aberto na INFORMAÇÃO é o certo aqui: 500 com a mensagem do banco.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { COLUNAS_DA_TAREFA } from "@/lib/tarefas/colunas";
import { recusaDeVinculoDaTarefa } from "@/lib/tarefas/vinculos-da-tarefa";
import { prazoNoPassado } from "@/lib/tarefas/prazo-no-passado";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA, type Tarefa } from "@/lib/tarefas/tipos";

export const dynamic = "force-dynamic";

/** As colunas que a tela lê — a lista e o porquê dos embutidos em `lib/tarefas/colunas.ts`. */
const COLUNAS = COLUNAS_DA_TAREFA;

const criacaoSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).default("medium"),
  status: z.enum(SITUACOES_DA_TAREFA).default("pending"),
  lead_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  // O vínculo com o ASSUNTO do atendimento (#2818): é o que faz a tarefa
  // criada de dentro da conversa voltar para a tela de quem precisa cumpri-la.
  // Opcional como os outros dois — a tarefa avulsa é caso real.
  demanda_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

const listaSchema = z.object({
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  /** As tarefas de UMA demanda — a seção "Tarefas desta demanda" do inbox. */
  demanda_id: z.string().uuid().optional(),
  due_from: z.string().datetime({ offset: true }).optional(),
  due_to: z.string().datetime({ offset: true }).optional(),
  /** "abertas" = o que ainda pede ação. É o default da tela. */
  aberto: z.enum(["true", "false"]).optional(),
  /**
   * De quem é a tarefa (o "Minhas" do celular, M3.2): "eu"/"me" (o usuário da sessão), "ninguem" (sem responsável)
   * ou o id de um membro da organização. É recorte de PERGUNTA, não de permissão:
   * só estreita a mesma consulta (mesma org, mesma RLS, mesmo limite), nunca
   * amplia o que o papel já vê.
   */
  assigned_to: z.union([z.literal("eu"), z.literal("me"), z.literal("ninguem"), z.string().uuid()]).optional(),
  /**
   * Com `aberto=true`: traz também as ENCERRADAS desde este instante (a faixa
   * "Encerradas" da tela de Tarefas, recolhida por padrão). Sem isto, marcar
   * como feita fazia a linha sumir na releitura seguinte, e a tarefa parecia
   * apagada. Recorte de tempo, não de permissão: mesma org, mesma RLS.
   */
  encerradas_desde: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = listaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const filtros = parsed.data;

  const supabase = await createClient();

  // "eu" vira o usuário da sessão; o id de um colega vai direto ao filtro. Sem
  // conferir a filiação (P2 do Cassio na #183): a RLS de `user_organizations` não
  // deixa agent/viewer ler a linha de outro membro, e o filtro só ESTREITA a lista
  // que a pessoa já vê (mesma org, mesma RLS). Id de fora devolve vazio, como
  // membro sem tarefa, e a rota não diz se ele existe.
  const responsavel = filtros.assigned_to === "eu" || filtros.assigned_to === "me" ? authz.user.id : (filtros.assigned_to ?? null);

  // ⚠️ `organization_id` à mão mesmo com RLS ligada: é a regra do CLAUDE.md, e
  // ela não é redundante — o dia em que esta rota trocar para o admin client
  // (que bypassa RLS) o filtro já está aqui.
  let query = supabase
    .from("crm_tasks")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (filtros.status) query = query.eq("status", filtros.status);
  if (filtros.priority) query = query.eq("priority", filtros.priority);
  if (filtros.lead_id) query = query.eq("lead_id", filtros.lead_id);
  if (filtros.contact_id) query = query.eq("contact_id", filtros.contact_id);
  if (filtros.demanda_id) query = query.eq("demanda_id", filtros.demanda_id);
  if (filtros.due_from) query = query.gte("due_date", filtros.due_from);
  if (filtros.due_to) query = query.lte("due_date", filtros.due_to);
  if (responsavel === "ninguem") query = query.is("assigned_to", null);
  else if (responsavel) query = query.eq("assigned_to", responsavel);
  if (filtros.aberto === "true" && filtros.encerradas_desde) {
    // O instante passa pelo Zod (`datetime` com offset) antes de entrar no
    // filtro: nenhuma vírgula ou parêntese chega ao `or` do PostgREST.
    query = query.or(
      `status.in.(pending,in_progress),and(status.in.(done,cancelled),updated_at.gte.${filtros.encerradas_desde})`,
    );
  } else if (filtros.aberto === "true") {
    query = query.in("status", ["pending", "in_progress"]);
  }

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }

  return ok({ tasks: (data ?? []) as unknown as Tarefa[] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // `agent` e não `manager`: criar tarefa é o gesto de quem ATENDE, todo dia.
  const authz = await requireRole("agent", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = criacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  if (prazoNoPassado(parsed.data.due_date, parsed.data.status)) {
    return fail("validation_failed", t("O prazo da tarefa não pode estar no passado."), 422, {
      requestId,
      details: { campo: "due_date" },
    });
  }

  if (parsed.data.assigned_to) {
    // A chave estrangeira de `assigned_to` é só para `auth.users`: sem esta conferência, um id de
    // outra organização (ou de quem saiu da equipe) gravaria sem erro. A régua
    // e o porquê do admin client estão em `lib/tarefas/responsavel.ts`.
    const equipe = isServiceRoleConfigured() ? createAdminClient() : await createClient();
    const veredito = await conferirResponsavel(equipe, authz.org.orgId, parsed.data.assigned_to);
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_equipe") {
      return fail("validation_failed", t("O responsável escolhido não faz parte da equipe."), 422, {
        requestId,
        // O mesmo contrato das outras recusas de vínculo: a tela sabe QUAL campo marcar.
        details: { campo: "assigned_to" },
      });
    }
  }

  const supabase = await createClient();
  const recusa = await recusaDeVinculoDaTarefa(supabase, authz.org.orgId, parsed.data, t);
  if (recusa) {
    return fail("validation_failed", recusa.mensagem, 422, { requestId, details: { campo: recusa.campo } });
  }


  if (parsed.data.demanda_id) {
    // A chave estrangeira não passa pela RLS: sem esta conferência, a demanda
    // de outra organização gravaria sem erro. A régua está em `lib/tarefas/demanda.ts`.
    const veredito = await conferirDemanda(supabase, authz.org.orgId, parsed.data.demanda_id);
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_organizacao") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
    if (veredito === "encerrada") {
      return fail("state_conflict", t("Esta demanda já foi encerrada. Crie a tarefa numa demanda em andamento."), 409, {
        requestId,
      });
    }
  }

  const { data, error } = await supabase
    .from("crm_tasks")
    .insert({
      ...parsed.data,
      organization_id: authz.org.orgId,
      created_by: authz.user.id,
    })
    .select(COLUNAS)
    .single();

  if (error) {
    // 23503 = negócio, contato ou demanda apagado no meio, entre a escolha e a
    // gravação. Outra organização NÃO cai aqui: a FK não passa por RLS e
    // aceitaria, por isso `recusaDeVinculoDaTarefa` e `conferirDemanda` vêm antes.
    // A recusa nomeia os campos porque quem lê é quem escolheu na tela.
    if (error.code === "23503") {
      return fail("validation_failed", t("O negócio, o contato ou a demanda vinculada não existe."), 422, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }

  const tarefa = data as unknown as Tarefa;

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "crm_task.created",
    resourceType: "crm_tasks",
    resourceId: tarefa.id,
    requestId,
    metadata: { due_date: tarefa.due_date, priority: tarefa.priority },
  });

  // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele.
  await registraAtividadeDaTarefa(supabase, {
    organizationId: authz.org.orgId,
    tarefa,
    tipo: "task_created",
    actor: { type: "user", id: authz.user.id },
  });

  return ok({ task: tarefa }, { requestId, status: 201 });
}
