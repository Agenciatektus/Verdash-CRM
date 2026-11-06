import { CabecalhoDaPagina, Pagina, SecaoDaPagina } from "@/components/pagina";
/**
 * Configurações → Conversões. Onde o dono do tráfego conecta a conta de anúncios
 * e vê quais vendas foram (ou não foram) reportadas de volta.
 *
 * ── Por que esta tela nasce JUNTO com o mecanismo, e não depois ──────────────
 *
 * Invariante 6 da doutrina de restrição de canal: "nenhum mecanismo de backend
 * pode depender de estado configurável que não tenha tela para ver, tela para
 * mudar, e caminho visível de falha". A #144 mediu o preço de ignorar isso —
 * rodízio e visibilidade por atendente existiam INTEIROS, sem tela, e um
 * contribuidor abriu issue pedindo a feature que já estava construída.
 *
 * O handler de conversões teria caído no mesmo buraco, e pior: a falha mais
 * comum dele (`sem_valor`) é ACIONÁVEL por quem opera. Sem esta lista, "a Meta
 * não recebe minhas vendas" não teria resposta em lugar nenhum do produto.
 *
 * ── Por que ADMIN CLIENT para ler, diferente de `settings/marca` ─────────────
 *
 * A tela da marca lê `organizations` pelo client de sessão, porque a RLS
 * entrega essa linha a qualquer membro. Aqui não existe policy nenhuma:
 * `ad_platform_connections` e `ad_conversion_dispatches` têm RLS ligada com ZERO
 * policies e grants revogados de anon/authenticated (0204), exatamente para não
 * serem alcançáveis pela anon key que vai para o browser. Pelo client de sessão
 * esta página mostraria vazio para todo mundo — o gate de papel acima é o que
 * autoriza, e a leitura privilegiada acontece no servidor.
 *
 * ── Por que `admin`, e não `manager` ────────────────────────────────────────
 *
 * O objeto é uma credencial que escreve na conta de anúncios da empresa, ao lado
 * de billing e API tokens na mesma prancheta. Mesmo gate de `settings/marca`.
 */

import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  contaEnviadas,
  lerEstadoDaConexao,
  lerPendencias,
} from "@/lib/conversoes/estado-da-conexao";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { traduzir } from "@/lib/i18n/dicionario";
import { montarCodigoDeOrigemDoSite } from "@/lib/leads/origem-do-site";
import { googleAdsEstaConfigurado } from "@/lib/plataformas-de-anuncio/google/config";
import { lerEstadoDaConexaoGoogle } from "@/lib/plataformas-de-anuncio/google/estado-da-conexao";
import { lerEstadoDaCaptura } from "@/lib/plataformas-de-anuncio/landing-config";
import { existeConexaoDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { listarLinks, metricasLinks } from "@/lib/plataformas-de-anuncio/rastreio/links";
import { createAdminClient } from "@/lib/supabase/admin";

import { HistoricoDeEnvios } from "./_historico";
import { DiagnosticoGoogle } from "./_diagnostico";
import { lerDiagnosticoGoogle, lerFiltros, lerHistorico } from "@/lib/conversoes/historico";
import { AbaGoogle } from "./_abaGoogle";
import { AbaMeta } from "./_abaMeta";
import { AbaSite } from "./_abaSite";
import { AbaVisaoGeral } from "./_abaVisaoGeral";
import { HistoricoDeCliques } from "./_historicoCliques";
import { lerHistoricoDeCliques } from "@/lib/conversoes/historico-de-cliques";
import { LeadSubmittedCausal } from "./_leadSubmittedCausal";
import { ativacaoLeadMeta } from "@/lib/conversoes/ativacao-lead-meta";
import { vendaPeloCanalLigada } from "@/lib/conversoes/venda-pelo-canal";
import { identidadeDaMeta } from "@/lib/plataformas-de-anuncio/meta/identidade";
import type { EtapaAberta } from "./_regrasGoogle";
import { listarRegrasGoogle } from "@/lib/conversoes/regras-google";
import { listarRegrasMeta, rotuloDoEventoDaMeta } from "@/lib/conversoes/regras-meta";

export const metadata = { title: "Conversões" };
export const dynamic = "force-dynamic";

/** As abas, na ordem da nav; a primeira é a Visão geral (sem `?aba=`). */
const ABAS = ["visao", "meta", "google", "site", "historico", "diagnostico"] as const;

export default async function ConversoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const parametros = await searchParams;
  const { erro: erroDoGoogle, ok: okDoGoogle } = parametros;
  const aba =
    ABAS.find((a) => a === parametros.aba) ?? (parametros.aba === "links" ? "site" : "visao");

  const admin = createAdminClient();
  const [
    estado,
    pendencias,
    enviadas,
    estadoGoogle,
    estadoDaCaptura,
    canais,
    organizacao,
    capturaGoogle,
    etapas,
    regrasGoogle,
    regrasMeta,
    leituraMeta,
  ] = await Promise.all([
    lerEstadoDaConexao(admin, activeOrg.orgId),
    lerPendencias(admin, activeOrg.orgId),
    contaEnviadas(admin, activeOrg.orgId),
    lerEstadoDaConexaoGoogle(admin, activeOrg.orgId),
    lerEstadoDaCaptura(admin, "meta_ads_landing_pages", activeOrg.orgId),
    // Os números conectados viram SUGESTÃO no formulário de captura. Falhar
    // aqui não pode derrubar a tela inteira: sem sugestão, a pessoa digita.
    listSelectableChannels(admin, activeOrg.orgId).catch(() => []),
    // O `slug` é o `[org]` da rota pública, e não está no `ActiveOrg`.
    admin
      .from("organizations")
      .select("slug, settings, meta_lead_birth_enabled_at")
      .eq("id", activeOrg.orgId)
      .maybeSingle(),
    lerEstadoDaCaptura(admin, "google_ads_landing_pages", activeOrg.orgId),
    admin
      .from("crm_stages")
      .select("id, name, pipeline_id, crm_pipelines(name)")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_won", false)
      .eq("is_lost", false)
      .order("position"),
    // Falha na leitura das regras não derruba a tela: o editor some e o resto fica.
    listarRegrasGoogle(admin, activeOrg.orgId).catch(() => null),
    listarRegrasMeta(admin, activeOrg.orgId).catch(() => null),
    existeConexaoDeLeitura(admin, activeOrg.orgId, "meta_ads"),
  ]);
  // O nome que a pessoa reconhece para cada evento de etapa, das duas
  // plataformas — o Histórico e as pendências leem daqui.
  const rotulosDeEtapa = [
    ...(regrasGoogle ?? []).map((r) => ({ eventName: r.eventName, label: r.label })),
    ...(regrasMeta ?? []).map((r) => ({
      eventName: r.eventName,
      label: `${rotuloDoEventoDaMeta(r.metaEvent)} (Meta)`,
    })),
  ];
  const linhaDaOrganizacao = organizacao.data as unknown as {
    slug: string | null;
    settings?: unknown;
    meta_lead_birth_enabled_at?: unknown;
  } | null;
  const slug = linhaDaOrganizacao?.slug ?? null;
  // Página / WABA gravadas pela tela (#2098) — a MESMA leitura que a credencial
  // faz no caminho do envio, para a tela e o envio nunca divergirem.
  const identidadeMeta = identidadeDaMeta(linhaDaOrganizacao?.settings);
  // As regras de etapa da Meta têm dois destinos: a conexão direta OU a ponte
  // do canal da conversa (a mesma chave da venda). Escondê-las sem a conexão
  // direta deixava quem só tem o canal com regras que enviam e que ninguém vê.
  const vendaPeloCanal = vendaPeloCanalLigada(linhaDaOrganizacao?.settings);
  // Etapas abertas agrupadas por funil, na ordem do funil; a primeira de cada
  // funil é onde o lead nasce (a sugestão "Novo lead" do recomendado).
  const vistosOsFunis = new Set<string>();
  const etapasAbertas: EtapaAberta[] = (
    (etapas.data ?? []) as Array<{
      id: string;
      name: string;
      pipeline_id: string;
      crm_pipelines: { name: string } | Array<{ name: string }> | null;
    }>
  )
    .map((e) => ({
      id: e.id,
      nome: e.name,
      pipelineId: e.pipeline_id,
      funil:
        (Array.isArray(e.crm_pipelines) ? e.crm_pipelines[0] : e.crm_pipelines)?.name ?? "Funil",
    }))
    .sort((a, b) => a.funil.localeCompare(b.funil))
    .map((e) => {
      const primeira = !vistosOsFunis.has(e.pipelineId);
      vistosOsFunis.add(e.pipelineId);
      return { id: e.id, nome: e.nome, funil: e.funil, primeira };
    });
  // As abas de leitura só consultam o que mostram: a de configuração não paga
  // o histórico, e o histórico não paga o diagnóstico.
  const filtrosDoHistorico = lerFiltros(parametros);
  const historico =
    aba === "historico"
      ? await lerHistorico(admin, activeOrg.orgId, filtrosDoHistorico).catch(() => null)
      : null;
  // Cliques rastreados (1.95, upstream #3600): só na aba Histórico.
  const historicoCliques =
    aba === "historico"
      ? await lerHistoricoDeCliques(admin, activeOrg.orgId).catch(() => null)
      : null;
  const diagnostico =
    aba === "diagnostico"
      ? await lerDiagnosticoGoogle(admin, activeOrg.orgId, {
          instalacaoConfigurada: googleAdsEstaConfigurado(estadoGoogle.api),
          habilitada: estadoGoogle.habilitada,
          temRefreshToken: estadoGoogle.temRefreshToken,
          customerId: estadoGoogle.customerId,
          temAcaoDeVenda: Boolean(estadoGoogle.conversionActionId),
          etapasAbertas: etapasAbertas.length,
        }).catch(() => null)
      : null;

  const links = aba === "site" ? await listarLinks(admin, activeOrg.orgId).catch(() => null) : null;
  const metricas =
    aba === "site" ? await metricasLinks(admin, activeOrg.orgId).catch(() => null) : null;

  const numerosConectados = canais
    .map((c) => c.phone_number)
    .filter((n): n is string => Boolean(n));
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  /**
   * O exemplo do link é GERADO aqui, e não escrito à mão.
   *
   * Um exemplo fixo envelhece: no dia em que o contrato mudar, a tela passa a
   * ensinar um link que a ingestão não reconhece — e o defeito só apareceria na
   * atribuição de quem seguiu a instrução, meses depois. Gerando pelo mesmo
   * módulo que a ingestão lê, o exemplo é verdadeiro por construção.
   */
  const codigoDeExemplo =
    montarCodigoDeOrigemDoSite({ utm_source: "instagram", utm_campaign: "promo-junina" }) ?? "";
  const linkDeExemplo = `https://wa.me/5511999999999?text=${encodeURIComponent(
    `${t("Olá! Vim pelo site.")} ${codigoDeExemplo}`.trim(),
  )}`;

  const rotuloDaAba: Record<(typeof ABAS)[number], string> = {
    visao: t("Visão geral"),
    meta: "Meta",
    google: "Google Ads",
    site: t("Site e links"),
    historico: t("Histórico"),
    diagnostico: t("Diagnóstico"),
  };
  // Só as abas de formulário usam o molde Leitura (768px); a visão geral e as tabelas ficam na largura toda.
  const leitura = aba === "meta" || aba === "google" || aba === "site";
  const etapasLegiveis = !etapas.error;
  const idsAbertos = new Set(etapasAbertas.map((e) => e.id));

  return (
    <Pagina largura={leitura ? "leitura" : "total"}>
      <CabecalhoDaPagina
        titulo={t("Conversões")}
        descricao={t(
          "Quando um negócio que veio de anúncio é marcado como ganho, o valor da venda volta para a plataforma que trouxe o cliente. É esse retorno que ensina o anúncio a procurar mais gente parecida com quem comprou.",
        )}
      />
      <SecaoDaPagina>
        <nav className="flex gap-1 overflow-x-auto border-b" aria-label={t("Seções de conversões")}>
          {ABAS.map((chave) => (
            <a
              key={chave}
              href={chave === "visao" ? "?" : `?aba=${chave}`}
              aria-current={aba === chave ? "page" : undefined}
              className={`flex items-center gap-1.5 whitespace-nowrap ${
                aba === chave
                  ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium"
                  : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              }`}
            >
              {rotuloDaAba[chave]}
              {chave === "visao" && pendencias.length > 0 && (
                <Badge variant="error" data-testid="contagem-de-pendencias">
                  {pendencias.length}
                </Badge>
              )}
            </a>
          ))}
        </nav>

        {aba === "visao" ? (
          <AbaVisaoGeral
            resumo={{
              meta: {
                conectada: estado.conectada,
                habilitada: estado.habilitada,
                peloCanal: vendaPeloCanal,
              },
              google: {
                conectada: estadoGoogle.temRefreshToken,
                habilitada: estadoGoogle.habilitada,
                etapas:
                  etapasLegiveis && regrasGoogle
                    ? {
                        ligadas: regrasGoogle.filter((r) => r.enabled && idsAbertos.has(r.stageId))
                          .length,
                        total: etapasAbertas.length,
                      }
                    : null,
              },
              site: {
                capturaLigada: Boolean(estadoDaCaptura?.habilitada || capturaGoogle?.habilitada),
              },
            }}
            pendencias={pendencias}
            enviadas={enviadas}
            rotulosDeEtapa={rotulosDeEtapa}
            idioma={idioma}
          />
        ) : aba === "meta" ? (
          <>
            <AbaMeta
              estado={estado}
              idioma={idioma}
              leituraConectada={leituraMeta.conectada}
              vendaPeloCanal={vendaPeloCanal}
              identidade={identidadeMeta}
              etapasAbertas={etapasAbertas}
              podeListarEtapas={etapasLegiveis}
              regrasMeta={regrasMeta}
            />
            {organizacao.error || !linhaDaOrganizacao ? (
              <p role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
                {t(
                  "Não foi possível ler a ativação de LeadSubmitted. Atualize a página para tentar novamente.",
                )}
              </p>
            ) : (
              <LeadSubmittedCausal
                key={`${activeOrg.orgId}:${ativacaoLeadMeta(linhaDaOrganizacao.meta_lead_birth_enabled_at) !== null}`}
                ligado={ativacaoLeadMeta(linhaDaOrganizacao.meta_lead_birth_enabled_at) !== null}
                idioma={idioma}
              />
            )}
          </>
        ) : aba === "google" ? (
          <AbaGoogle
            estado={estadoGoogle}
            idioma={idioma}
            erro={erroDoGoogle}
            ok={okDoGoogle}
            etapasAbertas={etapasAbertas}
            podeListarEtapas={etapasLegiveis}
            regras={regrasGoogle}
          />
        ) : aba === "site" ? (
          <AbaSite
            slug={slug}
            idioma={idioma}
            capturaGoogle={capturaGoogle}
            capturaMeta={estadoDaCaptura}
            numerosConectados={numerosConectados}
            linkDeExemplo={linkDeExemplo}
            links={links}
            metricas={metricas}
          />
        ) : aba === "historico" ? (
          <div className="flex flex-col gap-8">
            {historico ? (
              <HistoricoDeEnvios
                linhas={historico.linhas}
                total={historico.total}
                filtros={filtrosDoHistorico}
                regras={rotulosDeEtapa}
                idioma={idioma}
              />
            ) : (
              <p className="rounded-md border p-4 text-sm">
                {t("Não consegui ler o histórico agora. Atualize a página em instantes.")}
              </p>
            )}
            {historicoCliques ? (
              <HistoricoDeCliques linhas={historicoCliques} idioma={idioma} />
            ) : (
              <p role="alert" className="rounded-md border p-4 text-sm">
                {t(
                  "Não consegui ler o histórico de cliques agora. Atualize a página em instantes.",
                )}
              </p>
            )}
          </div>
        ) : diagnostico ? (
          <DiagnosticoGoogle itens={diagnostico} idioma={idioma} />
        ) : (
          <p className="rounded-md border p-4 text-sm">
            {t("Não consegui ler o diagnóstico agora. Atualize a página em instantes.")}
          </p>
        )}
      </SecaoDaPagina>
    </Pagina>
  );
}
