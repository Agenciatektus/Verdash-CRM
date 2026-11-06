import { requireSupportWrite } from "@/lib/impersonate/support";
import { carteiraDoContato } from "@/lib/carteira/dono";
import { MOTIVO_DA_RECUSA, recusaNegocioNaCarteiraDeOutro } from "@/lib/carteira/negocio-novo";
import { traduzir } from "@/lib/i18n/dicionario";
/**
 * GET  /api/v1/leads?search=… — busca de leads (a paleta Ctrl K).
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { somenteOProprio, type VisibilityMode } from "@/lib/auth/types";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import { createLeadSchema, validateRequest, type CreateLeadInput } from "@/lib/schemas";
import { buscarLeads, termoDaBuscaDeLeads, TETO_DE_LEADS } from "@/lib/leads/busca-de-leads";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import { createLeadHandler } from "./_handler";

export const dynamic = "force-dynamic";

/**
 * Só BUSCA, de propósito: listar todos os leads da organização seria o endpoint
 * pesado que a regra proíbe, e o quadro já tem a rota dele. Sem `search` válido
 * (2 a 100 caracteres) a resposta é 422, não a lista inteira.
 *
 * `viewer`+ e o cliente da SESSÃO: a RLS de `crm_leads` decide o que cada papel
 * acha, e a organização entra à mão (ver `lib/leads/busca-de-leads.ts`).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const termo = termoDaBuscaDeLeads(url.searchParams.get("search") ?? "");
  if (termo === null) {
    return fail("validation_failed", t("A busca precisa de 2 a 100 caracteres."), 422, { requestId });
  }
  const pedido = Number(url.searchParams.get("limit") ?? TETO_DE_LEADS);
  const limite = Number.isInteger(pedido) && pedido > 0 ? Math.min(pedido, TETO_DE_LEADS) : TETO_DE_LEADS;

  const supabase = await createClient();
  try {
    return ok(await buscarLeads(supabase, authz.org.orgId, termo, limite), { requestId });
  } catch (erroDaBusca) {
    console.error("[leads] busca falhou:", erroDaBusca instanceof Error ? erroDaBusca.message : erroDaBusca, {
      requestId,
    });
    return fail("internal_error", t("Erro ao buscar os leads."), 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // ─── NO "SÓ OS SEUS", O QUE O ATENDENTE CRIA É DELE (issue #2547) ──────────
  //
  // Em `visibility_mode = 'own'` a policy de `crm_leads` só deixa o Atendente
  // gravar o negócio que ele enxergaria depois — o que tem ELE de responsável.
  // O "Novo Lead" não manda responsável, então a criação era recusada (500, e
  // 403 explicado desde o #2556). Decisão do mantenedor (opção A): sem
  // responsável no corpo, o responsável é o próprio Atendente. Ele passa pela
  // mesma régua de atribuição de quem manda o campo (`ownerPatchOrThrow`:
  // membro ativo, `owner_kind`, `assigned_at`).
  //
  // Só quando o corpo NÃO menciona dono: `owner_user_id: null` explícito ou um
  // colega de responsável continuam sendo pedidos que a regra recusa (403).
  // Gerente e admin enxergam a organização inteira e criam como sempre. O modo
  // vem da org do cookie validado, nunca do corpo — admin client, como em
  // `app/app/layout.tsx`.
  if (
    activeOrg.role === "agent" &&
    input.owner_user_id === undefined &&
    input.owner_agent_id === undefined
  ) {
    // Um client só para as duas leituras do modo/carteira (service-role: RLS
    // não segura nada aqui, então `organization_id` junto em todo `.eq`).
    const admin = createAdminClient();
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", activeOrg.orgId)
      .maybeSingle();
    // Leitura do modo falhou: segue SEM o padrão e registra. Seguir não amplia
    // acesso (a RLS de `crm_leads` lê o mesmo modo e decide); derrubar a criação
    // criaria uma falha nova nos modos em que ela daria certo — as leituras
    // vizinhas deste fluxo (moeda, origem) também degradam em vez de falhar.
    if (orgErr) {
      logger.error("leads.create: leitura do modo de visibilidade falhou; segue sem responsável padrão", {
        requestId,
        orgId: activeOrg.orgId,
        error: orgErr.message,
      });
    }
    const modo = (orgRow?.settings as { visibility_mode?: VisibilityMode } | null)?.visibility_mode;
    // `modo === "own"` estava escrito à mão aqui, na tela do Inbox e no catálogo
    // de recursos — três cópias da MESMA pergunta. Agora ela é um predicado só
    // (`somenteOProprio`), e a #3479 é o que acontece quando uma das cópias fica
    // para trás: no negócio o criador vira responsável, na conversa não.
    if (somenteOProprio(modo)) {
      // ─── CARTEIRA DE OUTRO VENDEDOR (issue #2591, regra 4) ─────────────────
      //
      // O padrão do #2547 acima dá o negócio a quem o criou — mas isso só é
      // justo enquanto ninguém é o DONO do cliente. Com o contato na carteira
      // de outro vendedor, o que o Atendente acabou de fazer foi riscar um
      // cliente do colega sem ninguém avisar. A issue decide: com carteira de
      // outro vendedor o negócio recusa com o motivo (403 explicado, molde do
      // #2556) em vez de nascer silenciosamente no nome errado.
      //
      // O dono que NÃO conta (viewer, revogado, de outra org) passa como
      // `donoDaCarteira: null` — aí nada muda, que é o padrão.
      const carteira = await carteiraDoContato(admin, activeOrg.orgId, input.contact_id);
      if (
        recusaNegocioNaCarteiraDeOutro({
          modo,
          criadorId: authUser.id,
          donoDaCarteira: carteira.qualificado ? carteira.dono : null,
        })
      ) {
        return fail("carteira_de_outro_vendedor", traduzir(MOTIVO_DA_RECUSA, authUser.idioma), 403, {
          requestId,
        });
      }
      input = { ...input, owner_user_id: authUser.id };
    }
  }

  const supabase = await createClient();

  // ─── AVISO DE NEGÓCIO ABERTO DUPLICADO (issue #1751) ───────────────────────
  //
  // Antes do INSERT, porque o aviso descreve o mundo em que a pessoa pediu a
  // criação — consultado depois, o negócio NOVO entraria na própria contagem.
  //
  // A consulta nunca recusa: a migration 0256 decidiu que um cliente PODE ter
  // dois negócios abertos, então o segundo nasce e a resposta traz
  // `meta.avisos: ["negocio_aberto_existente"]` com o negócio que já existe,
  // para a tela mostrar o aviso com link. Sem contato não há o que perguntar —
  // lead órfão é caminho legítimo (#852).
  const negocioExistente = input.contact_id
    ? await negocioAbertoExistente(supabase, {
        organizationId: activeOrg.orgId,
        contactId: input.contact_id,
        pipelineId: input.pipeline_id,
      })
    : null;

  try {
    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: authUser.id },
        requestId,
        idioma: authUser.idioma,
      },
      input as CreateLeadInput,
    );
    return ok(lead, {
      requestId,
      // 9082: origem não manual com negócio aberto no funil devolve o existente.
      status: lead.reaproveitado ? 200 : 201,
      // `meta` só quando há aviso: uma resposta sem `meta` continua sem
      // `meta`, e o que muda é acrescentar, nunca esconder.
      ...(negocioExistente
        ? {
            meta: {
              avisos: [AVISO_NEGOCIO_ABERTO_EXISTENTE],
              negocio_aberto_existente: negocioExistente,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
