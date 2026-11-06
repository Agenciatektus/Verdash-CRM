/**
 * A PRIMEIRA DAS QUATRO TRANCAS DAS SAÍDAS DA CAMPANHA, MEDIDA NA ROTA (9046).
 *
 * ## Por que este arquivo existe (P1.1 do @Cassio_SecRev)
 *
 * A 9046 afirma que uma configuração de saída ilegível PARA a régua em quatro
 * lugares. Três tinham teste unitário; o primeiro — o Zod das rotas — tinha só
 * leitura de código. E ele é justamente o único que falha em SILÊNCIO.
 *
 * O modo de falha, concreto: `saidas` entra em `criarCampanhaSchema` pelo spread
 * `...baseDaCampanha`, nunca nominalmente. Um refactor que a tirasse de lá, ou um
 * erro de digitação na chave do payload, passava pelo TypeScript (os hooks
 * tipavam o corpo como `Record<string, unknown>`), passava pelo Zod (que
 * descarta campo desconhecido em `z.object`), e a rota gravava `null`. Resposta:
 * **200**. O operador vê a seção preenchida na tela, clica Salvar, não lê erro
 * nenhum, e a campanha roda no padrão — que é o padrão de defeito que já custou
 * caro aqui: "schema aceita campo que ninguém grava: 200, desfaz o clique, sem
 * erro".
 *
 * A metade de TIPO está fechada em `lib/campanhas/schemas.ts`
 * (`CorpoDeCriarCampanha`/`CorpoDeEditarCampanha`, `z.input` dos schemas): chave
 * errada agora é erro de compilação. Este arquivo fecha a metade de
 * COMPORTAMENTO, que nenhum tipo pega: que o valor chega ao INSERT/UPDATE, que o
 * ilegível é recusado com 422 e sem escrita, e que `saidas` caiu no lado
 * CONTEÚDO do `mexeEmConteudo` — hoje garantido só por estar numa deny-list que
 * nada vigia.
 *
 * A rota é exercitada de verdade (Zod, gate de estado, escrita), com o banco em
 * dublê. Zero PII.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CAMP = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "66666666-6666-4666-8666-666666666666";

/** A escolha realista do operador: pare quando o card entrar nesta etapa. */
const ESCOLHA = { etiquetas: ["Reunião agendada"], etapas: [ETAPA], ao_fechar: true, humano_assumir: true };

let inserido: Record<string, unknown> | null;
let atualizado: Record<string, unknown> | null;
let statusNoBanco: string;

/** A linha que `carregarCampanha` devolve no PATCH. */
function linha(): Record<string, unknown> {
  return {
    id: CAMP,
    organization_id: ORG,
    name: "Reativação de lojistas",
    status: statusNoBanco,
    channel_session_id: CANAL,
    message_body: "Oi {{nome}}",
    message_variants: [],
    base_legal: "consent",
    lia_ref: null,
    pipeline_id: FUNIL,
    passos: [],
    saidas: null,
    followup_pointer_id: null,
    entrada_continua: false,
    entrada_etapa_id: null,
    audience_filter: {},
    audience_version: 1,
    content_version: 1,
    scheduled_at: null,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: null,
    teto_horario: null,
    description: null,
  };
}

/**
 * Banco em dublê: só o que estas duas rotas tocam. O verbo é lembrado POR
 * CADEIA, porque `campaigns` é consultada e escrita no mesmo PATCH e as duas
 * terminam em `maybeSingle` — sem isso, a leitura de `carregarCampanha`
 * devolveria a linha da escrita e o gate de estado mediria o dublê.
 */
function banco() {
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    let verbo = "select";
    let valores: Record<string, unknown> | null = null;
    const encadeia = () => q;
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) q[m] = encadeia;
    q.insert = (v: Record<string, unknown>) => {
      verbo = "insert";
      valores = v;
      if (tabela === "campaigns") inserido = v;
      return q;
    };
    q.update = (v: Record<string, unknown>) => {
      verbo = "update";
      valores = v;
      if (tabela === "campaigns") atualizado = v;
      return q;
    };
    const resposta = () => {
      // `provider` decide o modo da campanha (texto livre no QR): sem ele o canal «não envia campanhas».
      if (tabela === "channel_sessions") return { data: { id: CANAL, provider: "waha" }, error: null };
      if (tabela === "campaigns") {
        if (verbo === "insert") return { data: { ...linha(), ...valores, id: CAMP }, error: null };
        if (verbo === "update") return { data: { ...linha(), ...valores, id: CAMP }, error: null };
        return { data: linha(), error: null };
      }
      return { data: null, error: null };
    };
    q.maybeSingle = async () => resposta();
    q.single = async () => resposta();
    return q;
  };
  return { from } as never;
}

const CORPO_MINIMO = {
  name: "Reativação de lojistas",
  channel_session_id: CANAL,
  message_body: "Oi {{nome}}",
  base_legal: "consent" as const,
};

async function post(corpo: unknown) {
  const { POST } = await import("@/app/api/v1/campaigns/route");
  return POST(
    new NextRequest("https://crm.exemplo/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }) as never,
  );
}

async function patch(corpo: unknown) {
  const { PATCH } = await import("@/app/api/v1/campaigns/[id]/route");
  return PATCH(
    new NextRequest(`https://crm.exemplo/api/v1/campaigns/${CAMP}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CAMP }) },
  );
}

async function codigo(r: Response): Promise<string | undefined> {
  const corpo = (await r.json()) as { error?: { code?: string } };
  return corpo.error?.code;
}

beforeEach(() => {
  vi.clearAllMocks();
  inserido = null;
  atualizado = null;
  statusNoBanco = "draft";
  vi.mocked(createAdminClient).mockReturnValue(banco());
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" } as never,
    org: { orgId: ORG, name: "Org", role: "manager" } as never,
  }));
});

describe("POST /api/v1/campaigns: as saídas chegam ao banco", () => {
  it("grava o OBJETO que o operador escolheu, não `null`", async () => {
    // É esta asserção que o `Record<string, unknown>` dos hooks deixava passar:
    // com a chave errada, a resposta era 201 e a coluna ficava nula.
    const r = await post({ ...CORPO_MINIMO, saidas: ESCOLHA });
    expect(r.status).toBe(201);
    expect(inserido?.saidas).toEqual(ESCOLHA);
  });

  it("sem `saidas` grava NULO — a distinção «escolheu × herdou» existe de fato", async () => {
    // A coluna é nulável justamente para isso, e as telas só mandam o campo
    // quando a seção foi mexida. Se este caso virasse o objeto do padrão, a
    // justificativa escrita na migration deixaria de ser verdade.
    const r = await post(CORPO_MINIMO);
    expect(r.status).toBe(201);
    expect(inserido).not.toBeNull();
    expect(inserido?.saidas).toBeNull();
  });

  it("`saidas` ilegível é 422 e NÃO grava nada", async () => {
    const r = await post({ ...CORPO_MINIMO, saidas: { ao_fechar: "sim" } });
    expect(r.status).toBe(422);
    expect(await codigo(r)).toBe("validation_failed");
    expect(inserido).toBeNull();
  });

  it("`saidas` com campo desconhecido é 422 — `strictObject` não adivinha metade", async () => {
    const r = await post({ ...CORPO_MINIMO, saidas: { ...ESCOLHA, ao_responder: false } });
    expect(r.status).toBe(422);
    expect(inserido).toBeNull();
  });
});

describe("PATCH /api/v1/campaigns/[id]: as saídas são CONTEÚDO", () => {
  it("rascunho com `saidas` legível é 200 e o UPDATE leva o objeto", async () => {
    const r = await patch({ saidas: ESCOLHA });
    expect(r.status).toBe(200);
    expect(atualizado?.saidas).toEqual(ESCOLHA);
  });

  it("`saidas` ilegível é 422 e NÃO grava nada", async () => {
    const r = await patch({ saidas: { ao_fechar: "sim" } });
    expect(r.status).toBe(422);
    expect(await codigo(r)).toBe("validation_failed");
    expect(atualizado).toBeNull();
  });

  it("`null` é aceito: voltar ao padrão é escolha legítima", async () => {
    const r = await patch({ saidas: null });
    expect(r.status).toBe(200);
    expect(atualizado?.saidas).toBeNull();
  });

  it("campanha JÁ PREPARADA recusa mudar as saídas (409) — elas são CONTEÚDO", async () => {
    // A régua no ar executa o SNAPSHOT de `cadence_settings`. Aceitar a troca com
    // a campanha de pé deixaria a tela mostrando «pare na etapa Fechamento» e o
    // pointer executando a política anterior — divergência da pior espécie,
    // porque a tela continua certa de si.
    //
    // Hoje isso é garantido só por `saidas` estar fora de `CAMPOS_DE_RITMO`, uma
    // deny-list que nada vigiava: quem a movesse para lá por engano não
    // encontraria vermelho nenhum.
    statusNoBanco = "ready";
    const r = await patch({ saidas: ESCOLHA });
    expect(r.status).toBe(409);
    expect(await codigo(r)).toBe("campanha_nao_editavel");
    expect(atualizado).toBeNull();
  });

  it("CONTROLE: a mesma campanha `ready` aceita mudar o RITMO (200)", async () => {
    // Sem este caso, o 409 acima passaria também se `ready` recusasse tudo — e
    // aí ele não estaria medindo a classificação de `saidas`, só o estado.
    statusNoBanco = "ready";
    const r = await patch({ teto_diario: 40 });
    expect(r.status).toBe(200);
    expect(atualizado?.teto_diario).toBe(40);
  });
});
