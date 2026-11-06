/**
 * PREPARAR UMA CAMPANHA CONTÍNUA ZERA A FILA (P0-1 do @Cassio_SecRev).
 *
 * O invariante que a fatia da entrada contínua assume é: a fila é o que a ÚLTIMA
 * preparação montou, e a última preparação é o que o operador conferiu. No modo
 * lista quem o sustenta é o `delete` com que `prepararCampanha` começa; no modo
 * contínuo não se monta lista, e por isso o ramo havia deixado de apagar — ao
 * mesmo tempo que desligava o gate `campanha_sem_elegiveis` do Iniciar.
 *
 * O caminho que isso abria: preparação de lista de 5.000 que falha no meio cai em
 * `voltarAoRascunho` e deixa milhares de linhas `pending`, com o `rendered_body`
 * do texto ANTIGO. O operador marca entrada contínua, prepara, Inicia — e o
 * worker despacha a lista descartada, no texto que já havia sido trocado.
 * `rodada.ts` não compara `campaign_recipients.content_version` com
 * `campaigns.content_version` (só carimba a da campanha no metadado da
 * mensagem), então nada nota.
 *
 * ─── E, desde a fatia 4, O GATE DAS SAÍDAS (P1.2 do @Cassio_SecRev) ───
 *
 * O arnês daqui é o único do repositório que REGISTRA AS OPERAÇÕES NA ORDEM em
 * que `prepararAcao` as pede, e por isso é o único lugar onde se consegue provar
 * a afirmação central da 9046: que uma configuração de saída ilegível para
 * ANTES de qualquer escrita. Sem medir a lista de operações, "parou antes de
 * escrever" e "parou depois e ninguém olhou" devolvem o mesmo 422.
 */
import { describe, expect, it, vi } from "vitest";

import { prepararAcao, type CampanhaCarregada } from "./acoes";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

const ORG = "org-1";
const CAMPANHA = "camp-1";

const campanha: CampanhaCarregada = {
  id: CAMPANHA,
  organization_id: ORG,
  name: "Novos leads do site",
  status: "draft",
  channel_session_id: "canal-1",
  message_body: "Oi {{nome}}, {{saudacao}}!",
  message_variants: [],
  base_legal: "consent",
  lia_ref: null,
  pipeline_id: "funil-1",
  passos: [],
  // `null` = o operador nunca escolheu, e vale o padrão de sempre (9046).
  saidas: null,
  followup_pointer_id: null,
  entrada_continua: true,
  entrada_etapa_id: "etapa-1",
  audience_filter: {},
  audience_version: 2,
  content_version: 7,
  scheduled_at: null,
  intervalo_segundos: null,
  janela_inicio_hora: 9,
  janela_fim_hora: 18,
  teto_diario: 50,
  teto_horario: null,
  description: null,
  message_mode: "text",
  provider_template_name: null,
  provider_template_language: null,
  provider_template_variables: null,
  velocidade: "gradual",
  split_messages: false,
};

interface Operacao {
  tabela: string;
  verbo: string;
  filtros: Array<[string, unknown]>;
}

/**
 * Cliente mínimo: cada tabela responde de uma FILA de resultados, consumida na
 * ordem em que `prepararAcao` a consulta, e toda operação fica registrada. Não
 * imita o PostgREST — imita só o que este caminho usa.
 */
function supabaseFake(filas: Record<string, Array<Record<string, unknown>>>) {
  const ops: Operacao[] = [];
  const client = {
    from: (tabela: string) => {
      const fila = filas[tabela] ?? [];
      const op: Operacao = { tabela, verbo: "select", filtros: [] };
      ops.push(op);
      const resultado = () => fila.shift() ?? { data: null, error: null };
      const encadeavel: Record<string, unknown> = {};
      for (const verbo of ["select", "update", "delete", "insert"]) {
        encadeavel[verbo] = () => {
          if (verbo !== "select" || op.verbo === "select") op.verbo = verbo;
          return encadeavel;
        };
      }
      for (const metodo of ["eq", "neq", "gte", "lte", "in", "not", "or", "order", "limit", "is", "contains", "overlaps"]) {
        encadeavel[metodo] = (coluna: string, valor: unknown) => {
          op.filtros.push([coluna, valor]);
          return encadeavel;
        };
      }
      encadeavel.maybeSingle = () => Promise.resolve(resultado());
      encadeavel.single = () => Promise.resolve(resultado());
      encadeavel.then = (fn: (r: unknown) => unknown) => Promise.resolve(resultado()).then(fn);
      return encadeavel;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, ops };
}

/** As respostas do caminho feliz, na ordem em que `prepararAcao` as pede. */
function filasDoCaminhoFeliz(erroDaLimpeza?: { message: string }) {
  return {
    campaign_recipients: [
      { count: 0, data: [], error: null }, // jaEnviou
      { data: null, error: erroDaLimpeza ?? null }, // o delete da fila
      { data: [], error: null }, // contatosJaEmCampanha, dentro da prévia
    ],
    campaigns: [
      { data: [{ id: CAMPANHA }], error: null }, // CAS draft → preparing
      { data: null, error: null }, // preparing → ready
    ],
    crm_stages: [{ data: { pipeline_id: "funil-1" }, error: null }], // etapaForaDoFunil
    crm_leads: [{ data: [], error: null }], // buscarCandidatos
    campaign_suppressions: [{ data: [], error: null }], // hashesExcluidos
  };
}

describe("preparar em modo contínuo", () => {
  it("APAGA a lista que sobrou de uma preparação de lista, filtrando organização e campanha", async () => {
    const { client, ops } = supabaseFake(filasDoCaminhoFeliz());
    const r = await prepararAcao(client, campanha, new Date("2026-10-06T12:00:00Z"), "user-1");

    expect(r.ok).toBe(true);
    const apagou = ops.find((o) => o.tabela === "campaign_recipients" && o.verbo === "delete");
    expect(apagou, "o ramo contínuo tem de apagar a fila").toBeDefined();
    // Com `organization_id` E `campaign_id`: o client é admin e ignora RLS, então
    // um delete sem a organização é delete de outro tenant esperando acontecer.
    expect(apagou!.filtros).toEqual([
      ["organization_id", ORG],
      ["campaign_id", CAMPANHA],
    ]);
  });

  it("apaga ANTES de medir a prévia", async () => {
    // A ordem importa para o número que vai ao snapshot: medir primeiro e apagar
    // depois daria uma contagem de um estado que deixou de existir.
    const { client, ops } = supabaseFake(filasDoCaminhoFeliz());
    await prepararAcao(client, campanha, new Date("2026-10-06T12:00:00Z"), "user-1");
    const iDelete = ops.findIndex((o) => o.tabela === "campaign_recipients" && o.verbo === "delete");
    const iPrevia = ops.findIndex((o) => o.tabela === "crm_leads");
    expect(iDelete).toBeGreaterThanOrEqual(0);
    expect(iPrevia).toBeGreaterThan(iDelete);
  });

  it("falha na limpeza volta ao rascunho e RECUSA — nunca segue com resto de fila", async () => {
    const { client, ops } = supabaseFake(
      filasDoCaminhoFeliz({ message: "deadlock detected" }),
    );
    const r = await prepararAcao(client, campanha, new Date("2026-10-06T12:00:00Z"), "user-1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Código PRÓPRIO: `campanha_sem_audiencia` descreveria "o recorte não achou
    // ninguém" e mandaria o operador mexer no filtro, que não tem nada com isto.
    expect(r.codigo).toBe("campanha_fila_nao_limpa");
    // E a mensagem do PostgREST NÃO vai para o recibo (doutrina do P2-3): a
    // resposta da API é lida em tela e pode ecoar o valor que o banco recusou. O
    // texto real vai para o log do servidor.
    expect(r.mensagem).not.toContain("deadlock detected");
    // E a campanha não fica presa em `preparing`: quem tentou preparar precisa
    // poder tentar de novo.
    const voltas = ops.filter((o) => o.tabela === "campaigns" && o.verbo === "update");
    expect(voltas.length).toBeGreaterThanOrEqual(2);
    // Não chegou a medir prévia nenhuma: recusou antes.
    expect(ops.some((o) => o.tabela === "crm_leads")).toBe(false);
  });

  it("campanha de LISTA não passa pelo ramo contínuo (nada neste conserto a muda)", async () => {
    // `prepararCampanha` é quem apaga no modo lista, e ele já fazia isso: o que
    // este caso protege é que o ramo novo não roubou o caminho antigo.
    const { client, ops } = supabaseFake({
      campaign_recipients: [{ count: 0, data: [], error: null }],
      campaigns: [{ data: [{ id: CAMPANHA }], error: null }],
    });
    const lista: CampanhaCarregada = {
      ...campanha,
      entrada_continua: false,
      entrada_etapa_id: null,
      audience_filter: { com_alguma_tag: ["lojista"] },
    };
    await prepararAcao(client, lista, new Date("2026-10-06T12:00:00Z"), "user-1");
    // `etapaForaDoFunil` é exclusivo do ramo contínuo: se ele apareceu, o ramo
    // errado rodou.
    expect(ops.some((o) => o.tabela === "crm_stages")).toBe(false);
  });
});

/**
 * O GATE DAS SAÍDAS PARA ANTES DE ESCREVER (P1.2 do @Cassio_SecRev).
 *
 * `faltaParaEnviar` roda na PRIMEIRA linha de `prepararAcao`, antes do `jaEnviou`
 * e antes do CAS `draft → preparing`. Então a recusa por saída ilegível não deve
 * deixar rastro nenhum: nem `status: 'preparing'`, nem pointer, nem destinatário.
 *
 * A asserção que importa é `ops` VAZIO. O 422 sozinho não distingue "parou antes
 * de escrever" de "parou depois de escrever e ninguém olhou" — e é justamente a
 * segunda que deixaria a campanha presa em `preparing`, ou com um pointer órfão
 * cujo nome determinístico travaria toda tentativa seguinte (o 23505 que a 9037
 * documenta).
 */
describe("saída ilegível recusa preparar SEM escrever nada (9046)", () => {
  /** A mesma campanha contínua do resto do arquivo, agora com régua. */
  const comRegua: CampanhaCarregada = {
    ...campanha,
    passos: [{ id: "p1", tipo: "mensagem", variantes: ["Passou por aqui?"] }],
  };

  it("`saidas` que o Zod não lê devolve 422 e NENHUMA operação de banco", async () => {
    const { client, ops } = supabaseFake(filasDoCaminhoFeliz());
    const r = await prepararAcao(
      client,
      // `ao_fechar: "sim"` é o erro realista: texto onde o schema quer booleano.
      { ...comRegua, saidas: { ao_fechar: "sim" } },
      new Date("2026-10-06T12:00:00Z"),
      "user-1",
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.codigo).toBe("campanha_conteudo_invalido");
    // A frase diz onde consertar, e é a mesma que o editor rotula.
    expect(r.mensagem).toContain("Quando a régua para");
    // ⚠️ A ASSERÇÃO DA FATIA: zero escrita, e zero LEITURA também — a recusa é
    // pura, decidida antes do primeiro `from()`.
    expect(ops, `não deveria tocar o banco, e tocou: ${JSON.stringify(ops)}`).toEqual([]);
  });

  // ⚠️ OS CONTROLES POSITIVOS VÃO SEM PASSOS, de propósito. Com passos a
  // preparação segue para `publicarReguaDaCampanha`, que consulta
  // `followup_flow_pointers` — tabela que este arnês não modela, então a
  // recusa viria da FILA VAZIA do fake e não do código, e o controle mediria o
  // arnês. O gate das saídas não depende de passos (`problemaNasSaidas` olha só
  // a coluna), então tirá-los não enfraquece o que estes dois casos provam.

  it("CONTROLE POSITIVO: com `saidas` legível, a preparação escreve", async () => {
    // Sem este caso, o anterior passaria também num arnês que nunca registra
    // operação nenhuma — "lista vazia" seria vacuidade, não prova.
    const { client, ops } = supabaseFake(filasDoCaminhoFeliz());
    const r = await prepararAcao(
      client,
      {
        ...campanha,
        saidas: { etiquetas: ["Reunião agendada"], etapas: [], ao_fechar: true, humano_assumir: true },
      },
      new Date("2026-10-06T12:00:00Z"),
      "user-1",
    );

    expect(r.ok, `recusou: ${r.ok ? "" : r.mensagem}`).toBe(true);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.tabela === "campaigns" && o.verbo === "update")).toBe(true);
  });

  it("`saidas` NULA (toda campanha anterior à 9046) passa o gate", async () => {
    const { client } = supabaseFake(filasDoCaminhoFeliz());
    const r = await prepararAcao(client, campanha, new Date("2026-10-06T12:00:00Z"), "user-1");
    expect(r.ok, `recusou: ${r.ok ? "" : r.mensagem}`).toBe(true);
  });
});
