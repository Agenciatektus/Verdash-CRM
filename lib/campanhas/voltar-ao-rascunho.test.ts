/**
 * EDITAR UMA CAMPANHA PRONTA invalida o snapshot — e só com 0 enviados.
 *
 * A transição `ready → draft` existe na máquina de estados como "o caminho de
 * editar", e seu guarda é delegado ao chamador: quem já ENVIOU não pode
 * reescrever a mensagem que a pessoa recebeu. Este arnês prova as duas pontas —
 * que o guarda recusa quando saiu mensagem, e que o caminho feliz APAGA a lista
 * e volta ao rascunho com CAS.
 *
 * O dublê é o mesmo de `preparar-entrada-continua.test.ts`: cada tabela responde
 * de uma FILA, consumida na ordem em que a ação a consulta, e toda operação fica
 * registrada — é o que distingue "parou antes de escrever" de "escreveu e
 * ninguém olhou".
 */
import { describe, expect, it } from "vitest";

import { voltarAoRascunhoAcao, type CampanhaCarregada } from "./acoes";

const ORG = "org-1";
const CAMPANHA = "camp-1";

const campanha: CampanhaCarregada = {
  id: CAMPANHA,
  organization_id: ORG,
  name: "Lista de lojistas",
  status: "ready",
  channel_session_id: "canal-1",
  message_body: "Oi {{nome}}!",
  message_variants: [],
  base_legal: "consent",
  lia_ref: null,
  pipeline_id: null,
  passos: [],
  saidas: null,
  followup_pointer_id: null,
  entrada_continua: false,
  entrada_etapa_id: null,
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
      for (const metodo of ["eq", "neq", "gte", "lte", "in", "not", "or", "order", "limit", "is"]) {
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

const AGORA = new Date("2026-10-20T12:00:00Z");

describe("voltarAoRascunhoAcao", () => {
  it("RECUSA quando já saiu mensagem, e não toca na lista nem no estado", async () => {
    const { client, ops } = supabaseFake({
      // jaEnviou: 3 destinatários com `sent_at` preenchido.
      campaign_recipients: [{ count: 3, data: null, error: null }],
    });

    const r = await voltarAoRascunhoAcao(client, campanha, AGORA, "user-1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Código PRÓPRIO: `campanha_nao_editavel` (409) diria "este estado não aceita
    // edição"; este é "já enviou, nem reabrir resolve" (422), e orienta Duplicar.
    expect(r.codigo).toBe("campanha_ja_enviou");
    expect(r.status).toBe(422);
    expect(r.mensagem.toLowerCase()).toContain("duplique");
    // Recusou ANTES de apagar ou atualizar: a única operação é a contagem.
    expect(ops.some((o) => o.verbo === "delete")).toBe(false);
    expect(ops.some((o) => o.tabela === "campaigns" && o.verbo === "update")).toBe(false);
  });

  it("com 0 enviados, APAGA o snapshot (org + campanha) e volta a `draft` com CAS", async () => {
    const { client, ops } = supabaseFake({
      campaign_recipients: [
        { count: 0, data: null, error: null }, // jaEnviou
        { data: null, error: null }, // o delete da lista
      ],
      campaigns: [{ data: [{ id: CAMPANHA }], error: null }], // CAS ready → draft
    });

    const r = await voltarAoRascunhoAcao(client, campanha, AGORA, "user-1");

    expect(r.ok, `recusou: ${r.ok ? "" : r.mensagem}`).toBe(true);

    // APAGOU a lista, filtrando organização E campanha — delete sem a organização
    // num client admin é delete de outro tenant esperando acontecer.
    const apagou = ops.find((o) => o.tabela === "campaign_recipients" && o.verbo === "delete");
    expect(apagou, "o Editar tem de apagar a lista preparada").toBeDefined();
    expect(apagou!.filtros).toEqual([
      ["organization_id", ORG],
      ["campaign_id", CAMPANHA],
    ]);

    // VOLTOU com compare-and-set: o update só casa quem ainda está em `ready`.
    const voltou = ops.find((o) => o.tabela === "campaigns" && o.verbo === "update");
    expect(voltou, "o Editar tem de escrever status = draft").toBeDefined();
    expect(voltou!.filtros).toContainEqual(["status", "ready"]);
  });

  it("de um estado que não é `ready`, recusa pela máquina de estados sem tocar no banco", async () => {
    const { client, ops } = supabaseFake({});
    const r = await voltarAoRascunhoAcao(client, { ...campanha, status: "running" }, AGORA, "user-1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("campanha_estado_invalido");
    expect(r.status).toBe(409);
    expect(ops).toEqual([]);
  });

  it("se o CAS perde a corrida (já saiu de `ready`), NÃO apaga a lista", async () => {
    // Outra ação (um Iniciar, por exemplo) venceu e tirou a campanha de `ready`
    // entre o carregamento e o nosso update: o CAS não casa nenhuma linha. O
    // delete do snapshot vem DEPOIS do CAS de propósito — fazê-lo antes (como na
    // 1ª versão) esvaziaria a lista de uma campanha que acabou de começar a rodar.
    const { client, ops } = supabaseFake({
      campaign_recipients: [{ count: 0, data: null, error: null }], // jaEnviou: 0
      campaigns: [{ data: [], error: null }], // CAS no-op: ninguém mais em `ready`
    });

    const r = await voltarAoRascunhoAcao(client, campanha, AGORA, "user-1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    // O coração do conserto: perdeu o CAS, então NÃO chegou a apagar a lista.
    expect(ops.some((o) => o.tabela === "campaign_recipients" && o.verbo === "delete")).toBe(false);
  });
});
