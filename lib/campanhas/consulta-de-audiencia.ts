/**
 * O recorte virando linhas — a única peça do módulo de audiência que fala com o
 * banco.
 *
 * Fica separada de `audiencia.ts` (que é o filtro, puro) porque a prévia e o
 * snapshot chamam AS DUAS, e é o par que garante que os dois caminhos vejam o
 * mesmo recorte. Se um dia a prévia e o envio divergirem, a divergência estará
 * aqui, num arquivo só.
 *
 * `organization_id` entra em TODA consulta, explicitamente: o client admin
 * ignora RLS, e é ele que este módulo recebe (a prévia roda numa rota com papel
 * conferido; o snapshot roda no worker, que não tem usuário).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { DIAS_SEM_REPETIR_A_CADENCIA } from "@/lib/cadencia/inscrever";

import {
  casaCompra,
  limiteDeSilencio,
  resumirPedidos,
  STATUS_DE_COMPRA_EFETIVA,
  temPredicadoDeContato,
  temRecorte,
  usaCompra,
  usaNegocio,
  type CriteriosDeAudiencia,
  type FiltroDeAudiencia,
} from "./audiencia";
import { STATUS_TERMINAIS } from "./maquina-de-estados";
import { NA_FILA_DE_DESPACHO } from "./tipos";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { recusouMarketing, type CandidatoDaAudiencia } from "./elegibilidade";
import { camposUsadosNoTexto, type CamposPersonalizados } from "./renderizador";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";

/**
 * O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`).
 *
 * É a página dos DOIS caminhos: os negócios de `{{lead.x}}` e a consulta de
 * contatos sem recorte de negócio (que pagina até juntar `filtro.limite`).
 */
const PAGINA_DO_POSTGREST = 1000;

/** Teto de ids que um filtro de negócio devolve antes de virar `in (...)`. */
const TETO_DE_IDS_DE_NEGOCIO = 20_000;

/**
 * Teto de pedidos lidos para os critérios de compra. Acima dele a consulta
 * FALHA em vez de cortar: resumo de compras truncado erra a última data e a
 * contagem, e escolheria (ou excluiria) a pessoa errada calado.
 * shortcut: agrega em memória; se alguma org chegar perto, trocar por RPC com
 * `max(ordered_at)`/`count`/`sum` agrupado no banco.
 */
const TETO_DE_PEDIDOS = 200_000;

/** Cursor de keyset: a última linha LIDA — não a última guardada (a exclusão é depois). */
interface CursorDeLeitura {
  created_at: string;
  id: string;
}

/**
 * O filtro `.or()` do PostgREST para "depois (ou antes) deste cursor", na ordem
 * (`created_at`, `id`) — o mesmo desenho de `lib/agenda/protecao-followup.ts` e
 * dos cursores de `app/api/v1/campaigns/[id]/recipients`.
 */
function filtroDepoisDoCursor(cursor: CursorDeLeitura, ordem: "asc" | "desc"): string {
  const op = ordem === "asc" ? "gt" : "lt";
  return `created_at.${op}.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.${op}.${cursor.id})`;
}

/**
 * O cursor AVANÇOU? Se não, a página repetiu linhas e a leitura entraria em
 * laço — melhor falhar alto que servir audiência duplicada em silêncio.
 * (Molde: `agenda_page_did_not_advance`.)
 */
function avancou(anterior: CursorDeLeitura, novo: CursorDeLeitura, ordem: "asc" | "desc"): boolean {
  const passo = ordinal(novo.created_at, anterior.created_at) || ordinal(novo.id, anterior.id);
  return ordem === "asc" ? passo > 0 : passo < 0;
}

interface LinhaDeContato {
  id: string;
  /** Carimbado porque a ordem GLOBAL do recorte é (`created_at`, `id`). */
  created_at: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
  is_personal: boolean;
  is_anonymized: boolean;
  consent: unknown;
  /** Só quando o texto pede `{{contato.x}}` — ver `colunasDeContato`. */
  custom_fields?: unknown;
}

/** As colunas de sempre, mais os campos personalizados quando o TEXTO os usa. */
const COLUNAS_DO_CONTATO = "id, name, display_name, phone_number, is_blocked, is_personal, is_anonymized, consent";

/**
 * A consulta de contatos com os predicados dos CRITÉRIOS. É a mesma para o
 * público positivo e para o bloco `excluir`: um predicado escrito uma vez só.
 */
function consultaDeContatos(
  admin: SupabaseClient,
  organizationId: string,
  criterios: CriteriosDeAudiencia,
  agora: Date,
  colunas: string,
) {
  let consulta = admin
    .from("contacts")
    .select(colunas)
    .eq("organization_id", organizationId)
    // Placeholder de GRUPO não recebe campanha: campanha é 1:1 por doutrina, e
    // o grupo não tem opt-in individual nenhum por trás desse registro técnico.
    .eq("kind", "person")
    // Cadastro mesclado é fantasma: quem responde é o sobrevivente.
    .is("is_merged_into", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (criterios.com_todas_tags.length > 0) consulta = consulta.contains("tags", criterios.com_todas_tags);
  if (criterios.com_alguma_tag.length > 0) consulta = consulta.overlaps("tags", criterios.com_alguma_tag);
  if (criterios.sem_tags.length > 0) {
    consulta = consulta.not("tags", "ov", `{${criterios.sem_tags.map(citar).join(",")}}`);
  }
  if (criterios.origens.length > 0) consulta = consulta.in("source", criterios.origens);
  if (criterios.sem_interacao_ha_dias !== null) {
    const limite = limiteDeSilencio(criterios.sem_interacao_ha_dias, agora).toISOString();
    // Quem nunca interagiu ENTRA no recorte de silêncio: `last_activity_at` nulo
    // é o silêncio mais longo que existe, e deixá-lo de fora tiraria justamente
    // a lista fria — que é o caso de uso principal da campanha.
    consulta = consulta.or(`last_activity_at.is.null,last_activity_at.lt.${limite}`);
  }
  if (criterios.com_interacao_ha_dias !== null) {
    consulta = consulta.gte(
      "last_activity_at",
      limiteDeSilencio(criterios.com_interacao_ha_dias, agora).toISOString(),
    );
  }
  if (criterios.cadastrado_de) consulta = consulta.gte("created_at", criterios.cadastrado_de);
  if (criterios.cadastrado_ate) consulta = consulta.lte("created_at", criterios.cadastrado_ate);
  return consulta;
}

/**
 * Os contatos que têm negócio no recorte.
 *
 * Consulta separada, e não `join` embutido do PostgREST: o mesmo contato tem N
 * negócios, e o embed devolveria o contato N vezes — contagem de prévia
 * inflada, que é exatamente o número que o operador confere antes de apertar.
 */
async function contatosPorNegocio(
  admin: SupabaseClient,
  organizationId: string,
  criterios: CriteriosDeAudiencia,
): Promise<{ ids: string[]; truncado: boolean }> {
  // A consulta pede até `TETO_DE_IDS_DE_NEGOCIO` LINHAS e o PostgREST corta
  // TODA resposta em `max_rows` (cuja config da instalação pode ser MENOR que
  // `PAGINA_DO_POSTGREST`). Paginar por `range` tinha dois defeitos: parar
  // cedo quando o `max_rows` era menor (a primeira página já volta "curta") e
  // repetir/perder linha quando um negócio muda de etapa no meio da leitura
  // (#2404). Por isso o laço é KEYSEET em (`created_at`, `id`), e só a página
  // VAZIA prova o fim.
  const consultaDeNegocios = () => {
    let consulta = admin
      .from("crm_leads")
      .select("contact_id, created_at, id")
      .eq("organization_id", organizationId)
      .not("contact_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (criterios.funis.length > 0) consulta = consulta.in("pipeline_id", criterios.funis);
    if (criterios.etapas.length > 0) consulta = consulta.in("stage_id", criterios.etapas);
    if (criterios.responsaveis.length > 0) consulta = consulta.in("owner_user_id", criterios.responsaveis);
    if (criterios.situacoes_do_negocio.length > 0) {
      consulta = consulta.in("status", criterios.situacoes_do_negocio);
    }
    return consulta;
  };
  let truncado = false;
  const linhasDeNegocio: Array<{ contact_id: string; created_at: string; id: string }> = [];
  let cursor: CursorDeLeitura | null = null;
  for (;;) {
    let pagina = consultaDeNegocios().limit(PAGINA_DO_POSTGREST);
    if (cursor) pagina = pagina.or(filtroDepoisDoCursor(cursor, "asc"));
    const { data, error } = await pagina;
    if (error) throw new Error(`audiência: negócios — ${error.message}`);
    const lidas = (data ?? []) as unknown as typeof linhasDeNegocio;
    if (lidas.length === 0) break;
    const ultima = lidas[lidas.length - 1]!;
    const novo = { created_at: ultima.created_at, id: ultima.id };
    if (cursor && !avancou(cursor, novo, "asc")) {
      throw new Error("audiência: audiencia_page_did_not_advance");
    }
    cursor = novo;
    linhasDeNegocio.push(...lidas);
    if (linhasDeNegocio.length >= TETO_DE_IDS_DE_NEGOCIO) {
      // O teto é por LINHA: corta o excesso da última página e sonda UMA
      // linha além do teto — o aviso da prévia não pode mentir num recorte
      // de exatamente 20.000.
      linhasDeNegocio.length = TETO_DE_IDS_DE_NEGOCIO;
      const ultimaDoTeto = linhasDeNegocio[linhasDeNegocio.length - 1]!;
      const { data: sobra, error: erroSobra } = await consultaDeNegocios()
        .or(filtroDepoisDoCursor({ created_at: ultimaDoTeto.created_at, id: ultimaDoTeto.id }, "asc"))
        .limit(1);
      if (erroSobra) throw new Error(`audiência: negócios — ${erroSobra.message}`);
      truncado = (sobra ?? []).length > 0;
      break;
    }
  }
  return { ids: [...new Set(linhasDeNegocio.map((l) => l.contact_id))], truncado };
}

/**
 * Os contatos cujas COMPRAS casam com os critérios. Lê os pedidos efetivos da
 * organização inteira (keyset, como os negócios) e resume por contato em
 * memória: o PostgREST não agrupa. Quem não tem pedido efetivo não aparece no
 * resumo e por isso nunca casa (`casaCompra`).
 */
async function contatosPorCompra(
  admin: SupabaseClient,
  organizationId: string,
  criterios: CriteriosDeAudiencia,
  agora: Date,
): Promise<string[]> {
  type Pedido = {
    contact_id: string;
    status: string;
    ordered_at: string;
    total_cents: number | string;
    created_at: string;
    id: string;
  };
  const pedidos: Pedido[] = [];
  let cursor: CursorDeLeitura | null = null;
  for (;;) {
    let pagina = admin
      .from("orders")
      .select("contact_id, status, ordered_at, total_cents, created_at, id")
      .eq("organization_id", organizationId)
      .in("status", STATUS_DE_COMPRA_EFETIVA as unknown as string[])
      .not("contact_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(PAGINA_DO_POSTGREST);
    if (cursor) pagina = pagina.or(filtroDepoisDoCursor(cursor, "asc"));
    const { data, error } = await pagina;
    if (error) throw new Error(`audiência: pedidos — ${error.message}`);
    const lidas = (data ?? []) as unknown as Pedido[];
    if (lidas.length === 0) break;
    const ultima = lidas[lidas.length - 1]!;
    const novo = { created_at: ultima.created_at, id: ultima.id };
    if (cursor && !avancou(cursor, novo, "asc")) {
      throw new Error("audiência: audiencia_page_did_not_advance");
    }
    cursor = novo;
    pedidos.push(...lidas);
    if (pedidos.length > TETO_DE_PEDIDOS) throw new Error("audiência: pedidos acima do teto");
  }
  const resumo = resumirPedidos(pedidos);
  return [...resumo.keys()].filter((id) => casaCompra(resumo.get(id), criterios, agora));
}

/**
 * Os ids que os critérios de NEGÓCIO e de COMPRA restringem (interseção), ou
 * `null` quando nenhum dos dois é usado. Lista vazia é recorte vazio, não
 * recorte ausente: seguir sem o `in` devolveria a organização inteira.
 */
async function idsRestritos(
  admin: SupabaseClient,
  organizationId: string,
  criterios: CriteriosDeAudiencia,
  agora: Date,
): Promise<{ ids: string[] | null; truncado: boolean }> {
  let ids: string[] | null = null;
  let truncado = false;
  if (usaNegocio(criterios)) {
    const porNegocio = await contatosPorNegocio(admin, organizationId, criterios);
    ids = porNegocio.ids;
    truncado = porNegocio.truncado;
    if (ids.length === 0) return { ids, truncado };
  }
  if (usaCompra(criterios)) {
    const porCompra = await contatosPorCompra(admin, organizationId, criterios, agora);
    if (ids === null) ids = porCompra;
    else {
      const compraram = new Set(porCompra);
      ids = ids.filter((id) => compraram.has(id));
    }
  }
  return { ids, truncado };
}

/**
 * O bloco `excluir` vira uma pergunta sobre um lote de candidatos: "quais
 * destes casam com a exclusão?". Usa os MESMOS predicados do público positivo
 * (`idsRestritos` + `consultaDeContatos`). `null` quando não há o que excluir.
 *
 * A pergunta é feita sobre os candidatos (em lotes de 100 ids), e não sobre a
 * organização inteira: os predicados de contato não precisam varrer a base.
 */
async function prepararExclusao(
  admin: SupabaseClient,
  organizationId: string,
  excluir: CriteriosDeAudiencia | null,
  agora: Date,
): Promise<((ids: string[]) => Promise<Set<string>>) | null> {
  if (!excluir || !temRecorte(excluir)) return null;
  const restritos = await idsRestritos(admin, organizationId, excluir, agora);
  // Exclusão truncada deixaria passar quem devia sair: falha fechada.
  if (restritos.truncado) throw new Error("audiência: exclusão por negócio acima do teto");
  const conjunto = restritos.ids ? new Set(restritos.ids) : null;
  return async (ids) => {
    const alvo = conjunto ? ids.filter((id) => conjunto.has(id)) : ids;
    if (alvo.length === 0 || !temPredicadoDeContato(excluir)) return new Set(alvo);
    const { data, error } = await buscaEmLotes<{ id: string }>(alvo, async (lote) => {
      const { data: pagina, error: erro } = await consultaDeContatos(
        admin,
        organizationId,
        excluir,
        agora,
        "id",
      ).in("id", lote);
      return { data: (pagina ?? null) as unknown as { id: string }[] | null, error: erro };
    });
    if (error) throw new Error(`audiência: exclusão — ${error.message}`);
    return new Set(data.map((l) => l.id));
  };
}

/** Tira das linhas quem a exclusão manual ou por critério pega. */
async function semExcluidos(
  linhas: LinhaDeContato[],
  excluidos: Set<string>,
  casaExclusao: ((ids: string[]) => Promise<Set<string>>) | null,
): Promise<LinhaDeContato[]> {
  const restantes = linhas.filter((l) => !excluidos.has(l.id));
  if (!casaExclusao || restantes.length === 0) return restantes;
  const fora = await casaExclusao(restantes.map((l) => l.id));
  return restantes.filter((l) => !fora.has(l.id));
}

/**
 * Os candidatos do recorte, e o recibo de truncamento.
 *
 * `truncado` só é verdadeiro quando o recorte bate o teto de
 * `TETO_DE_IDS_DE_NEGOCIO` E há pelo menos uma linha além dele — a prévia
 * avisa o operador em vez de cortar calada (#2404).
 *
 * O bloco `excluir` também tira quem foi incluído à mão, como `excluir_contatos`
 * (veto `excluidosAMao` na preparação e na elegibilidade).
 */
export async function buscarCandidatos(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    filtro: FiltroDeAudiencia;
    agora: Date;
    corpo?: string;
    /**
     * Campanha com modelo aprovado não tem texto para varrer: quem diz que os
     * campos do negócio valem a consulta é o mapa de variáveis (migration 0710).
     */
    lerCamposDoNegocio?: boolean;
  },
): Promise<{ candidatos: CandidatoDaAudiencia[]; truncado: boolean }> {
  const { organizationId, filtro, agora } = entrada;
  // O corpo entra SÓ para decidir se as colunas de campo personalizado valem a
  // consulta: texto de `{{nome}}` não puxa jsonb de 5.000 linhas em toda prévia.
  const doTexto = camposUsadosNoTexto(entrada.corpo ?? "");
  const camposDoTexto = { ...doTexto, lead: doTexto.lead || entrada.lerCamposDoNegocio === true };
  const colunasDeContato = camposDoTexto.contato ? ", custom_fields" : "";

  // ─── Os contatos que o negócio e a compra restringem ───
  const { ids: idsDoRecorte, truncado } = await idsRestritos(admin, organizationId, filtro, agora);
  if (idsDoRecorte && idsDoRecorte.length === 0) return { candidatos: [], truncado };
  const casaExclusao = await prepararExclusao(admin, organizationId, filtro.excluir, agora);

  // ─── A consulta de contatos ───
  // Dois filtros deste módulo crescem com a organização e não cabem na URL: os
  // ids do recorte (até 20.000 de negócio, ou os compradores) e a lista de
  // excluídos (até 5.000). O gateway na frente do PostgREST devolve `414` acima
  // de ~8.192 B (#2358, a mesma família do #2357 em `leadsMaisRecentes`). Por isso:
  //   * a exclusão sai da URL e vira filtro em MEMÓRIA, ANTES do corte — é o
  //     que o `.not("id","in",…)` fazia no servidor;
  //   * com recorte de negócio ou compra, a consulta é fatiada por `buscaEmLotes`;
  //   * sem ele, a consulta é única e paginada por `max_rows`, parando cedo.
  const excluidos = new Set(filtro.excluir_contatos);
  const colunas = COLUNAS_DO_CONTATO + colunasDeContato + ", created_at";

  // O select é DINÂMICO (a coluna `custom_fields` só entra quando o texto pede),
  // então o PostgREST não infere as colunas e devolve o tipo genérico: o `unknown`
  // é o preço, e `LinhaDeContato` continua sendo conferido por quem monta a linha.
  let linhas: LinhaDeContato[];
  if (!temRecorte(filtro)) {
    // Só incluídos à mão: a consulta sem predicado traria a organização
    // inteira. A audiência é exatamente quem foi incluído (bloco abaixo).
    linhas = [];
  } else if (idsDoRecorte) {
    // Cada lote traz no MÁXIMO 100 linhas (um id por contato, e os lotes do
    // `buscaEmLotes` têm 100 ids), então a união é o recorte inteiro — a
    // exclusão e o corte global acontecem UMA vez, no fim. Um `.limit` por lote
    // cortaria a união antes da exclusão em memória: um lote com muitas linhas
    // excluídas empurraria para fora quem deveria entrar.
    const { data, error } = await buscaEmLotes<LinhaDeContato>(idsDoRecorte, async (lote) => {
      const { data: pagina, error: erro } = await consultaDeContatos(
        admin,
        organizationId,
        filtro,
        agora,
        colunas,
      ).in("id", lote);
      return { data: (pagina ?? null) as unknown as LinhaDeContato[] | null, error: erro };
    });
    if (error) throw new Error(`audiência: contatos — ${error.message}`);
    linhas = await semExcluidos(data, excluidos, casaExclusao);
    // Comparação ORDINAL, não `localeCompare`: a colação ICU põe `.` antes de
    // `+`, e um `…56+00:00` (segundo exato) cairia DEPOIS de um `…56.5+00:00`,
    // o contrário do `ORDER BY` do Postgres. Com timestamp em UTC no formato do
    // PostgREST e uuid em hex minúsculo, a ordem de bytes é a do banco.
    linhas.sort((a, b) => ordinal(a.created_at, b.created_at) || ordinal(a.id, b.id));
  } else {
    // Sem recorte de negócio não há por onde fatiar: uma consulta, por keyset em
    // (`created_at`, `id`) — a página CURTA não prova nada quando o `max_rows`
    // da instalação é menor que `PAGINA_DO_POSTGREST`; só a VAZIA prova
    // (#2404). O cursor é a última linha LIDA, não a última guardada: a
    // exclusão acontece depois da leitura.
    linhas = [];
    let cursorContatos: CursorDeLeitura | null = null;
    for (;;) {
      let consulta = consultaDeContatos(admin, organizationId, filtro, agora, colunas).limit(
        PAGINA_DO_POSTGREST,
      );
      if (cursorContatos) consulta = consulta.or(filtroDepoisDoCursor(cursorContatos, "asc"));
      const { data, error } = await consulta;
      if (error) throw new Error(`audiência: contatos — ${error.message}`);
      const pagina = (data ?? []) as unknown as LinhaDeContato[];
      if (pagina.length === 0) break;
      const ultima = pagina[pagina.length - 1]!;
      const novo = { created_at: ultima.created_at, id: ultima.id };
      if (cursorContatos && !avancou(cursorContatos, novo, "asc")) {
        throw new Error("audiência: audiencia_page_did_not_advance");
      }
      cursorContatos = novo;
      linhas.push(...(await semExcluidos(pagina, excluidos, casaExclusao)));
      if (linhas.length >= filtro.limite) break;
    }
  }
  if (linhas.length > filtro.limite) linhas = linhas.slice(0, filtro.limite);

  // ─── Os incluídos à mão ───
  // Entram mesmo fora do recorte, e por isso vêm em consulta própria; os vetos
  // por pessoa continuam valendo para eles (incluir à mão não fura opt-out).
  const jaTem = new Set(linhas.map((l) => l.id));
  // Deduplicado ANTES dos lotes: o mesmo id em dois lotes voltaria duas vezes,
  // e a gravação da campanha esbarraria no contato único por campanha.
  const faltam = [...new Set(filtro.incluir_contatos)].filter((id) => !jaTem.has(id));
  if (faltam.length > 0) {
    // Em lotes pela mesma razão do recorte: até 5.000 ids não cabem numa URL.
    const { data: extras, error: erroExtras } = await buscaEmLotes<LinhaDeContato>(
      faltam,
      async (lote) => {
        const { data: pagina, error: erro } = await admin
          .from("contacts")
          .select(colunas)
          .eq("organization_id", organizationId)
          .eq("kind", "person")
          .in("id", lote);
        return { data: (pagina ?? null) as unknown as LinhaDeContato[] | null, error: erro };
      },
    );
    if (erroExtras) throw new Error(`audiência: incluídos — ${erroExtras.message}`);
    linhas.push(...(await semExcluidos(extras ?? [], new Set(), casaExclusao)));
  }

  // ─── Os campos personalizados que o TEXTO usa ───
  // Uma consulta só, e só quando o corpo tem `{{lead.x}}`: o PostgREST não
  // devolve "o mais novo de cada contato", então a ordem decrescente resolve —
  // o primeiro visto de cada contato é o negócio mais recente dele.
  const leads = camposDoTexto.lead
    ? await leadsMaisRecentes(admin, organizationId, linhas.map((l) => l.id))
    : null;

  return {
    candidatos: linhas.map((l) => ({
      contactId: l.id,
      nome: nomeDoContato(l),
      telefone: l.phone_number,
      bloqueado: l.is_blocked,
      pessoal: l.is_personal === true,
      anonimizado: l.is_anonymized,
      recusouMarketing: recusouMarketing(l.consent),
      ...(camposDoTexto.contato ? { contato: mapaDeJson(l.custom_fields) } : {}),
      ...(leads ? { lead: leads.get(l.id) ?? null } : {}),
    })),
    truncado,
  };
}

/**
 * O negócio de UM destinatário, o mais recente — a mesma régua da prévia.
 *
 * Caminho do envio de TESTE (`acoes.ts`), que lê um contato por vez: teste que
 * renderiza por outro caminho que o envio não testa nada.
 */
export async function camposDoDestinatario(
  admin: SupabaseClient,
  entrada: { organizationId: string; contactId: string; corpo: string; lerCamposDoNegocio?: boolean },
): Promise<{ lead?: CamposPersonalizados | null; contato?: CamposPersonalizados | null }> {
  const doTexto = camposUsadosNoTexto(entrada.corpo);
  const campos = { ...doTexto, lead: doTexto.lead || entrada.lerCamposDoNegocio === true };
  if (!campos.lead && !campos.contato) return {};
  const saida: { lead?: CamposPersonalizados | null; contato?: CamposPersonalizados | null } = {};
  if (campos.contato) {
    const { data, error } = await admin
      .from("contacts")
      .select("custom_fields")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (error) throw new Error(`audiência: campos do contato — ${error.message}`);
    saida.contato = mapaDeJson((data as { custom_fields?: unknown } | null)?.custom_fields);
  }
  if (campos.lead) {
    const leads = await leadsMaisRecentes(admin, entrada.organizationId, [entrada.contactId]);
    saida.lead = leads.get(entrada.contactId) ?? null;
  }
  return saida;
}

/**
 * O negócio mais recente de cada contato.
 *
 * `{{lead.gancho}}` é do lead mais NOVO do contato — o que o operador vê
 * quando abre a ficha. Contato sem negócio devolve SEM linha no mapa, e aí o
 * renderizador marca FALTA: a pessoa sai da lista com `variavel_ausente`,
 * visível na prévia, em vez de receber o texto pela metade.
 *
 * Os ids viajam NA URL (`contact_id=in.(…)`), e o gateway na frente do
 * PostgREST (Kong 2.8.1 no stack Supabase e no kit single-server) devolve `414`
 * acima de ~8.192 B — ver `tests/unit/busca-do-inbox-nao-estoura-a-url.test.ts`.
 * Todos de uma vez, a audiência padrão de 500 contatos dava ~19,7 KB e a
 * preparação INTEIRA caía. Por isso `buscaEmLotes` (100 uuids ≈ 3,7 KB por URL).
 *
 * Dentro do lote vêm TODAS as linhas, paginadas pelo `max_rows`: um `.limit`
 * global cortava quem tem o negócio mais antigo, e o contato saía da lista com
 * o campo preenchido. Cada contato cai num lote só, então a ordem decrescente
 * dele sobrevive à concatenação.
 */
async function leadsMaisRecentes(
  admin: SupabaseClient,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Map<string, CamposPersonalizados | null>> {
  const mapa = new Map<string, CamposPersonalizados | null>();
  if (contactIds.length === 0) return mapa;
  const { data, error } = await buscaEmLotes(contactIds, async (lote) => {
    const linhas: Array<{
      contact_id: string;
      custom_fields: unknown;
      created_at: string;
      id: string;
    }> = [];
    // Keyset em (`created_at`, `id`) DECRESCENTE, como a ordem pedida: a página
    // curta não prova nada quando o `max_rows` da instalação é menor que
    // `PAGINA_DO_POSTGREST`; só a VAZIA prova (#2404).
    let cursor: CursorDeLeitura | null = null;
    for (;;) {
      let consulta = admin
        .from("crm_leads")
        .select("contact_id, custom_fields, created_at, id")
        .eq("organization_id", organizationId)
        .in("contact_id", lote)
        .not("contact_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGINA_DO_POSTGREST);
      if (cursor) consulta = consulta.or(filtroDepoisDoCursor(cursor, "desc"));
      const { data: pagina, error: erro } = await consulta;
      if (erro) return { data: null, error: erro };
      const lidas = (pagina ?? []) as unknown as typeof linhas;
      if (lidas.length === 0) return { data: linhas, error: null };
      const ultima = lidas[lidas.length - 1]!;
      const novo = { created_at: ultima.created_at, id: ultima.id };
      if (cursor && !avancou(cursor, novo, "desc")) {
        return { data: null, error: { message: "audiencia_page_did_not_advance" } };
      }
      cursor = novo;
      linhas.push(...lidas);
    }
  });
  if (error) throw new Error(`audiência: negócios dos contatos — ${error.message}`);
  for (const linha of data) {
    if (mapa.has(linha.contact_id)) continue; // ordem decrescente: o primeiro é o mais novo
    mapa.set(linha.contact_id, mapaDeJson(linha.custom_fields));
  }
  return mapa;
}

/** Lê `custom_fields` sem confiar no shape — é jsonb livre. */
function mapaDeJson(valor: unknown): CamposPersonalizados | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  return valor as CamposPersonalizados;
}


/**
 * Quem o veto "já em campanha" tira do recorte — por DOIS critérios, que medem
 * coisas diferentes.
 *
 * Opcionalmente ignora uma campanha (a que está sendo preparada): sem isso, uma
 * preparação repetida excluiria como "já em campanha" os destinatários que ela
 * mesma gravou na tentativa anterior.
 *
 *   (1) PASSADO — RECEBEU nos últimos `DIAS_SEM_REPETIR_A_CADENCIA` dias. O fato
 *       medido é a mensagem ter SAÍDO (`sent_at`), e ele independe do estado da
 *       campanha: cancelar a campanha não desfaz a mensagem que a pessoa leu, e
 *       por isso campanha cancelada que já falou CONTINUA contando.
 *
 *   (2) PRESENTE — está na FILA ATIVA (`NA_FILA_DE_DESPACHO`) de uma campanha NÃO
 *       TERMINAL. Não é sobre o passado: é para duas campanhas não mandarem o
 *       primeiro contato para a mesma pessoa na mesma semana, de números
 *       possivelmente diferentes. Só aqui o estado da campanha importa, e quem
 *       responde "ainda vai falar?" é `STATUS_TERMINAIS`, derivado da máquina de
 *       estados.
 *
 * ═══ As duas voltas erradas, registradas para quem for mexer ═══
 *
 * • "linha em campanha VIVA" media (2) e era usado como se medisse (1). Caiu com
 *   a 9039: a campanha de entrada contínua nunca conclui, então por aquele
 *   critério todo contato que ela tocasse ficaria vetado de qualquer campanha
 *   futura, para sempre — ela esterilizaria o modo lista do tenant.
 * • "elegível nos últimos 30 dias, menos `cancelled`" tentou medir (1) com o
 *   dado de (2). Erra nas DUAS direções: veta quem está `pending` e nunca recebeu
 *   nada, e LIBERA quem recebeu e depois teve a campanha cancelada — justamente
 *   o caso que a janela de 30 dias existe para impedir.
 *
 * Com os dois separados, "cancelada antes de falar" sai do veto por si: não tem
 * `sent_at` e não tem linha viva. Nenhum predicado olha `cancelled`.
 *
 * ⚠️ `eligibility_status = 'eligible'` fica nos dois ramos, e NÃO é inerte — o
 * comentário anterior afirmava que era. `fecharPorOptOut`
 * (`lib/campanhas/resposta.ts`) marca `excluded` linhas que JÁ RECEBERAM
 * (`sent`/`delivered`/`read`/`replied`), então existe linha com `sent_at` na
 * janela e `eligible = false`, que o ramo (1) não veta. Hoje sem dano: aquele
 * caminho só roda com `contacts.is_blocked`, e bloqueio é veto mais forte. Vira
 * fail-open calado no dia em que alguém separar "bloqueado" de "recusou
 * marketing". Racional completo em `entrada-por-etapa.db.ts`.
 *
 * ⚠️ LIMITE CONHECIDO, anterior a esta mudança: 1.000 LINHAS POR RAMO.
 *
 * `max_rows = 1000` (`supabase/config.toml`) trunca a resposta do PostgREST sem
 * erro nenhum, e conjunto truncado veta MENOS gente do que devia — em silêncio.
 * O gatilho é concreto: um tenant que tenha enviado mais de 1.000 abordagens em
 * 30 dias, alcançável em semanas com teto diário alto (o teto da régua sozinho
 * permite 500/dia). A janela de 30 dias estreitou muito a exposição — antes eram
 * TODOS os destinatários de todas as campanhas vivas —, mas não a eliminou.
 *
 * ⚠️ E o conserto mais curto NÃO É PAGINAÇÃO. `rodada.ts` revalida bloqueio,
 * anonimização, opt-out e supressão imediatamente antes de cada envio, mas NÃO
 * revalida "já em campanha" — então o truncamento atravessa o snapshot e chega ao
 * envio. Uma chamada de `estaEmOutraCampanha` por destinatário na rodada fecha as
 * duas coisas de uma vez: o truncamento E o snapshot velho (lista preparada em
 * segunda, despachada em quinta, com a pessoa abordada por outra campanha na
 * quarta). É ponto por destinatário, sem conjunto, logo sem `max_rows`.
 *
 * Fora desta fatia de propósito: mexer no caminho de envio exige o olhar do
 * @Cassio_SecRev sobre a rodada inteira, e o que esta fatia entrega é quem ENTRA.
 */
export async function contatosJaEmCampanha(
  admin: SupabaseClient,
  organizationId: string,
  exceto?: string,
): Promise<Set<string>> {
  const desde = new Date(Date.now() - DIAS_SEM_REPETIR_A_CADENCIA * 86_400_000).toISOString();

  // (1) RECEBEU na janela. `gte` sobre `sent_at` já descarta quem não recebeu:
  // NULL não passa num `>=`.
  let abordados = admin
    .from("campaign_recipients")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .eq("eligibility_status", "eligible")
    .gte("sent_at", desde);
  if (exceto) abordados = abordados.neq("campaign_id", exceto);
  const { data: jaFalou, error: erroFalou } = await abordados;
  if (erroFalou) throw new Error(`audiência: abordados — ${erroFalou.message}`);

  // (2) ESTÁ NA FILA de campanha que ainda vai falar. Pelo embed `!inner`, e não
  // por uma lista de ids de campanha: aquela lista cresce com o tempo (a
  // contínua nunca conclui) e em algumas centenas a URL do PostgREST estoura. O
  // predicado de status tem tamanho FIXO, então a URL não cresce — mesmo padrão
  // de `lib/cadencia/saidas.handler.ts` e o racional de `lib/leads/radar-de-risco.ts`.
  let naFila = admin
    .from("campaign_recipients")
    .select("contact_id, campaigns!inner(status)")
    .eq("organization_id", organizationId)
    .eq("eligibility_status", "eligible")
    .in("status", NA_FILA_DE_DESPACHO as unknown as string[])
    .not("campaigns.status", "in", `(${STATUS_TERMINAIS.join(",")})`);
  if (exceto) naFila = naFila.neq("campaign_id", exceto);
  const { data: aCaminho, error: erroFila } = await naFila;
  if (erroFila) throw new Error(`audiência: na fila — ${erroFila.message}`);

  return new Set(
    [...(jaFalou ?? []), ...(aCaminho ?? [])].map((r) => (r as { contact_id: string }).contact_id),
  );
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Aspas para o literal de array do Postgres — etiqueta com vírgula quebraria o `{a,b}`. */
function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}


/**
 * Quem já desligou o marketing desta empresa NA PLATAFORMA (erro `131050` num
 * envio anterior de campanha). A plataforma não avisa por webhook à parte: o
 * único rastro é a falha. Mandar de novo não entrega, não é cobrado e só
 * aumenta a conta de falhas do número — então a pessoa sai da lista com
 * `recusou_marketing`, o mesmo motivo de quem recusou pelo cadastro.
 *
 * Os dois formatos do rastro: o oficial direto grava o código em
 * `last_error_code`; o parceiro grava o rótulo dele ali e o código no começo
 * do detalhe (`"131050 — …"`).
 */
export async function contatosQueRecusaramMarketingNaPlataforma(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("campaign_recipients")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .or("last_error_code.eq.131050,last_error_detail.like.131050*")
    .limit(10_000);
  if (error) throw new Error(`audiência: recusas de marketing na plataforma — ${error.message}`);
  return new Set(((data ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id));
}
