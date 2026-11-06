/**
 * GET /api/v1/campaigns — a lista.
 * POST /api/v1/campaigns — cria um rascunho.
 *
 * Papel: `manager` para escrever (POST). Disparar para uma lista de gente não é
 * gesto de `viewer` nem de `agent`, e a RLS de escrita de `campaigns` (migration
 * 0375) exige o mesmo papel. A LISTA (GET) abre para `agent` em somente leitura
 * (decisão do Peterson, 27/10/2026), sem `passos` (textos das mensagens do 2º
 * toque); a RLS de leitura já é "membro da org".
 *
 * Paginação: keyset sobre (created_at DESC, id DESC), o mesmo formato de
 * `lead-captures`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { escreveComoPlatformAdmin, roleAtLeast } from "@/lib/auth/types";
import { FILTRO_VAZIO } from "@/lib/campanhas/audiencia";
import { decidirConteudo, decidirVelocidade, lerModoDoCanal } from "@/lib/campanhas/conteudo-do-canal";
import { gravarPool } from "@/lib/campanhas/pool-de-numeros";
import {
  codificarCursor,
  criarCampanhaSchema,
  decodificarCursor,
  listarCampanhasSchema,
} from "@/lib/campanhas/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS_DA_LISTA =
  "id, name, status, channel_session_id, snapshot_total, snapshot_eligible, snapshot_excluded, " +
  "scheduled_at, started_at, completed_at, cancelled_at, created_at, created_by, " +
  // `entrada_continua` vai na LISTA (9039) porque "Na lista: 0" numa campanha
  // contínua se lê como campanha quebrada: sem o modo, a tela não tem como
  // explicar o zero.
  "pipeline_id, stage_id, agent_id, entrada_continua, message_mode, provider_template_name";
// `passos` carrega o texto das mensagens de follow-up: só quem edita (manager+) recebe.
const COLUNAS_DO_GESTOR = `${COLUNAS_DA_LISTA}, passos`;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const gestor =
    roleAtLeast(authz.org.role, "manager") ||
    (escreveComoPlatformAdmin(authz.user) && !authz.user.support);
  const colunas = gestor ? COLUNAS_DO_GESTOR : COLUNAS_DA_LISTA;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listarCampanhasSchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("campaigns")
    .select(colunas)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.cursor) {
    const c = decodificarCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(`created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1] as { created_at: string; id: string } | undefined;

  return ok(pagina, {
    requestId,
    meta: {
      cursor: temMais && ultima ? codificarCursor(ultima) : null,
      has_more: temMais,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  // Client ADMIN na escrita, e não o da sessão: a migration 0375 concede ao
  // papel `authenticated` apenas SELECT (a tela lê; só o servidor escreve), e o
  // PostgREST com o JWT do usuário recebe "permission denied for table
  // campaigns" — medido na VPS em 19/09/2026, pela tela. O isolamento não se
  // perde: `org.orgId` vem do `requireRole()` acima, nunca do corpo, e entra
  // explicitamente em toda consulta abaixo.
  const supabase = createAdminClient();
  // A conexão é conferida CONTRA A ORGANIZAÇÃO: a FK composta da 0375 recusaria
  // o número de outro tenant, mas a recusa do banco chegaria como erro genérico.
  const canal = await lerModoDoCanal(supabase, org.orgId, entrada.channel_session_id);
  if (!canal.existe) {
    return fail(
      "campanha_canal_indisponivel",
      t("Escolha uma conexão de WhatsApp desta organização."),
      409,
      { requestId },
    );
  }
  // O conteúdo segue o que o número aceita: texto livre no QR, modelo aprovado
  // no oficial (migration 0710). O modelo escolhido é conferido inteiro aqui.
  const conteudo = await decidirConteudo(supabase, {
    organizationId: org.orgId,
    channelSessionId: entrada.channel_session_id,
    extras: entrada.channel_session_ids ?? [],
    modoDoCanal: canal.modo,
    pedido: entrada,
  });
  if (!conteudo.ok) {
    return fail(conteudo.codigo, t(conteudo.mensagem), conteudo.status, { requestId });
  }
  // Rápida só com modelo aprovado (migration 0711).
  const velocidade = decidirVelocidade({ pedida: entrada.velocidade, atual: "gradual", modo: conteudo.modo });
  if (!velocidade.ok) {
    return fail(velocidade.codigo, t(velocidade.mensagem), velocidade.status, { requestId });
  }

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      organization_id: org.orgId,
      name: entrada.name,
      description: entrada.description ?? null,
      channel_session_id: entrada.channel_session_id,
      message_body: conteudo.modo === "template" ? null : (entrada.message_body ?? null),
      // Vazio, e não `null`: a coluna é `not null default '{}'` (9034) e a
      // campanha de um texto só é o caso comum.
      message_variants: entrada.message_variants ?? [],
      ...conteudo.colunas,
      base_legal: entrada.base_legal,
      lia_ref: entrada.lia_ref ?? null,
      audience_filter: entrada.audience_filter ?? FILTRO_VAZIO,
      // Vazio, e não `null`: a coluna é `not null default '[]'` (9037), e
      // campanha de uma mensagem só é o caso comum.
      passos: entrada.passos ?? [],
      // `null`, e não o objeto do padrão: nulo é "o operador nunca abriu esta
      // seção", e é o que `lerSaidasDaCampanha` lê como o padrão de sempre
      // (9046). Gravar o padrão aqui daria o MESMO comportamento e perderia a
      // distinção — e com ela a resposta a "esta campanha foi configurada, ou
      // herdou?" na hora de auditar por que alguém parou de receber.
      saidas: entrada.saidas ?? null,
      // O MODO DE PÚBLICO (migration 9039). `false` por omissão: campanha criada
      // por quem não abriu essa seção nasce em modo LISTA, idêntica ao que
      // sempre foi. O que o modo contínuo exige (funil, etapa, teto do dia,
      // janela) NÃO é cobrado aqui — a campanha nasce em RASCUNHO, e rascunho
      // pode estar incompleto; o CHECK da 9039 excetua `draft` pelo mesmo
      // motivo. Quem cobra é o gate de `faltaParaEnviar`, no Preparar.
      entrada_continua: entrada.entrada_continua ?? false,
      entrada_etapa_id: entrada.entrada_etapa_id ?? null,
      intervalo_segundos: entrada.intervalo_segundos ?? null,
      janela_inicio_hora: entrada.janela_inicio_hora ?? null,
      janela_fim_hora: entrada.janela_fim_hora ?? null,
      teto_diario: entrada.teto_diario ?? null,
      teto_horario: entrada.teto_horario ?? null,
      velocidade: velocidade.velocidade,
      split_messages: entrada.split_messages ?? false,
      pipeline_id: entrada.pipeline_id ?? null,
      stage_id: entrada.stage_id ?? null,
      agent_id: entrada.agent_id ?? null,
      created_by: user.id,
    })
    .select(COLUNAS_DA_LISTA)
    .single();
  if (error || !data) {
    return fail("internal_error", error?.message ?? t("Não foi possível criar a campanha."), 500, {
      requestId,
    });
  }

  const criada = data as unknown as { id: string };
  if ((entrada.channel_session_ids ?? []).length > 0) {
    // Falha do pool NÃO derruba a criação: a campanha existe e fala pelo número
    // principal. Devolver erro aqui faria o operador achar que nada foi criado
    // e criar de novo.
    try {
      await gravarPool(supabase, {
        organizationId: org.orgId,
        campanhaId: criada.id,
        principal: entrada.channel_session_id,
        extras: entrada.channel_session_ids ?? [],
      });
    } catch {
      // O texto real já foi para o log do Supabase; a tela mostra o pool salvo
      // quando recarrega, que é a fonte da verdade.
    }
  }

  void audit({
    action: "campaign.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "campaign",
    resourceId: criada.id,
    requestId,
    metadata: {
      base_legal: entrada.base_legal,
      numeros: 1 + (entrada.channel_session_ids ?? []).length,
      modo: conteudo.modo,
      ...(conteudo.colunas.provider_template_name ? { modelo: conteudo.colunas.provider_template_name } : {}),
    },
  });

  return ok(data, { requestId, status: 201 });
}
