import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A MENSAGEM QUE O CLIENTE EDITOU OU APAGOU.
 *
 * ─── O defeito, relatado olhando a tela ─────────────────────────────────────
 *
 * O dono editou uma mensagem no celular e o inbox seguiu mostrando o texto
 * antigo. Nenhum erro em lugar nenhum: o evento chega (quando assinado), o
 * parser não o reconhece, a rota responde 200, a linha fica como estava.
 *
 * É pior que uma falha visível. Combinar preço, prazo ou endereço a partir de um
 * texto que o cliente já corrigiu gera uma divergência que ninguém rastreia
 * depois — os dois lados juram ter lido coisas diferentes, e os dois têm razão.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que a edição case pela mensagem ORIGINAL (não pelo id do evento); que apagar
 * não apague a LINHA; que uma edição de mensagem desconhecida não invente
 * conversa; e que a tela DIGA que houve edição — o texto novo sozinho mente por
 * omissão, porque se lê como se sempre tivesse dito aquilo.
 */
import { parseZernioEdicao, type ZernioEdicao } from "@/lib/channels/zernio/webhook";
import { bancoFalso, ORIGINAL_INBOUND } from "./helpers/banco-falso-de-alteracao";
import { aplicarEdicaoZernio } from "@/lib/channels/zernio/ingest";

const zEvento = (event: string, extra: Record<string, unknown> = {}) => ({
  event,
  message: { platform: "whatsapp", platformMessageId: "wamid.ABC", ...extra },
});

describe("leitura do evento (Zernio)", () => {
  it("reconhece edição e traz o corpo novo", () => {
    const e = parseZernioEdicao(zEvento("message.edited", { content: "preço novo: 300" }));
    expect(e).toMatchObject({ externalId: "wamid.ABC", tipo: "edited", body: "preço novo: 300" });
  });

  it("reconhece apagamento — que não tem corpo a trazer", () => {
    const e = parseZernioEdicao(zEvento("message.deleted"));
    expect(e).toMatchObject({ externalId: "wamid.ABC", tipo: "deleted" });
  });

  it("mensagem nova NÃO entra por aqui — tem outro caminho", () => {
    // Misturá-las faria uma edição criar conversa do nada.
    expect(parseZernioEdicao(zEvento("message.received"))).toBeNull();
    expect(parseZernioEdicao(null)).toBeNull();
  });

  it("edição de outra plataforma é ignorada", () => {
    // A mesma conta serve Instagram e Facebook; não há linha nossa para corrigir.
    expect(
      parseZernioEdicao({
        event: "message.edited",
        message: { platform: "instagram", platformMessageId: "x" },
      }),
    ).toBeNull();
  });

  it("traz quem alterou e em qual conversa, para a guarda de autoria", () => {
    const e = parseZernioEdicao({
      event: "message.edited",
      message: { platform: "whatsapp", platformMessageId: "wamid.ABC", direction: "outgoing", conversationId: "zconv-1", content: "x" },
      conversation: { participantId: "5513900000000" },
    });
    expect(e).toMatchObject({ direction: "outbound", conversationId: "zconv-1", phone: "+5513900000000" });
  });

  it("sem id da mensagem não há o que corrigir", () => {
    expect(parseZernioEdicao({ event: "message.edited", message: { platform: "whatsapp" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const ed = (over: Partial<ZernioEdicao> = {}): ZernioEdicao => ({
  externalId: "wamid.ABC",
  tipo: "edited",
  body: "preço novo: 300",
  direction: "inbound",
  conversationId: "zconv-1",
  phone: "+5513900000000",
  ...over,
});

// A original que o banco falso devolve é de ENTRADA, na sessão `sess-1`, na
// conversa cujo `provider_conversation_id` é `zconv-1`.
const bancoZernio = (over: Parameters<typeof bancoFalso>[0] = {}) =>
  bancoFalso({ conversa: { provider_conversation_id: "zconv-1" }, ...over });

describe("aplicar na linha que já existe", () => {
  it("edição sobrescreve o corpo e carimba quando", async () => {
    const banco = bancoZernio();
    expect(await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed())).toBe("aplicado");
    expect(banco.update()?.valor).toMatchObject({ body: "preço novo: 300" });
    expect(banco.update()?.valor).toHaveProperty("edited_at");
  });

  it("apagar NÃO apaga a linha — carimba `revoked_at`", async () => {
    // Sumir com a linha deixaria a resposta seguinte respondendo ao nada, e
    // levaria junto o histórico de quem atendeu.
    const banco = bancoZernio();
    await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed({ tipo: "deleted", body: null }));
    expect(banco.update()?.valor).toHaveProperty("revoked_at");
    // E não mexe no corpo: quem decide o que mostrar é a tela.
    expect(banco.update()?.valor).not.toHaveProperty("body");
  });

  it("edição sem corpo novo não ZERA o texto", async () => {
    const banco = bancoZernio();
    await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed({ body: null }));
    expect(banco.update()?.valor).not.toHaveProperty("body");
    expect(banco.update()?.valor).toHaveProperty("edited_at");
  });

  it("procura por organização E id externo, e altera pelo id da linha conferida", async () => {
    const banco = bancoZernio();
    await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed({ tipo: "deleted", body: null }));
    const leitura = banco.chamadas.find((c) => c.tabela === "messages" && c.op === "select");
    expect(Object.fromEntries(leitura!.filtros)).toMatchObject({ organization_id: "org-1", external_id: "wamid.ABC" });
    expect(banco.update()?.filtros).toEqual([["id", "msg-orig"], ["organization_id", "org-1"]]);
  });

  it("mensagem desconhecida devolve `sem_alvo`, sem inventar linha", async () => {
    const banco = bancoZernio({ original: null });
    expect(await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed())).toBe("sem_alvo");
    expect(banco.inseriu()).toBe(false);
  });

  it("⛔ contato editando mensagem que a EMPRESA mandou: recusado, nada muda", async () => {
    const banco = bancoZernio({ original: { ...ORIGINAL_INBOUND, direction: "outbound" } });
    expect(await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed())).toBe("recusado");
    expect(banco.update()).toBeUndefined();
  });

  it("⛔ evento de outra sessão: recusado, nada muda", async () => {
    const banco = bancoZernio();
    expect(await aplicarEdicaoZernio(banco.admin, "org-1", "sess-OUTRA", ed())).toBe("recusado");
    expect(banco.update()).toBeUndefined();
  });

  it("⛔ alvo de outra conversa: recusado, nada muda", async () => {
    const banco = bancoZernio({ contato: { phone_number: "+5511988887777", wa_lid: null } });
    expect(
      await aplicarEdicaoZernio(banco.admin, "org-1", "sess-1", ed({ conversationId: "zconv-OUTRA" })),
    ).toBe("recusado");
    expect(banco.update()).toBeUndefined();
  });
});

describe("os elos que somem sem barulho", () => {
  it("o seam aplica a edição ANTES da ingestão", () => {
    // Deixá-la cair no `ingest` faria uma edição criar conversa e contato do
    // nada, com um texto sem nada antes dele.
    const fonte = readFileSync("lib/channels/inbound.ts", "utf8");
    expect(fonte).toMatch(/await aplicarEdicaoZernio\(/);
    expect(fonte.indexOf("parseZernioEdicao")).toBeLessThan(fonte.indexOf("ingestZernioInbound(admin"));
  });

  it("WAHA casa pela mensagem ORIGINAL, não pelo id do evento", () => {
    // `editedMessageId`/`revokedMessageId` apontam para a mensagem que mudou; o
    // `id` do payload é o do próprio evento. Casar pelo `id` não acharia nada —
    // e o silêncio pareceria "funcionou".
    const fonte = readFileSync("lib/waha/ingest.ts", "utf8");
    expect(fonte).toMatch(/p\.editedMessageId/);
    expect(fonte).toMatch(/p\.revokedMessageId/);
    expect(fonte).toMatch(/eventType === "message\.edited"/);
    expect(fonte).toMatch(/eventType === "message\.revoked"/);
  });

  it("o canal por QR ASSINA os dois eventos — sem isso nada chega", () => {
    // Este é o elo mais silencioso de todos: o código trata os eventos
    // perfeitamente e o transporte nunca os envia. Medido antes desta mudança —
    // `WHATSAPP_HOOK_EVENTS` não tinha nenhum dos dois, e a mensagem editada
    // pelo dono simplesmente nunca chegou ao CRM.
    for (const arquivo of ["docker-compose.prod.yml", "docker-compose.yml"]) {
      const compose = readFileSync(arquivo, "utf8");
      const linha = compose.split("\n").find((l) => l.includes("WHATSAPP_HOOK_EVENTS")) ?? "";
      expect(linha, `${arquivo} não assina message.edited`).toContain("message.edited");
      expect(linha, `${arquivo} não assina message.revoked`).toContain("message.revoked");
    }
  });

  it("as colunas novas chegam à tela — sem elas a bolha nunca sabe", () => {
    // O `select` do handler é a única porta: coluna fora dele não chega, e
    // `conv as unknown as Joined` faz isso NÃO ser erro de tipo.
    const fonte = readFileSync("app/api/v1/messages/_handler.ts", "utf8");
    expect(fonte).toMatch(/edited_at, revoked_at/);
  });

  it("a bolha DIZ que foi editada, e esconde o texto da apagada", () => {
    // A bolha foi dividida (fase 3.5): quem lê `revoked_at` é `MessageBubble`,
    // quem escreve "apagada" é o corpo, e quem diz "editada" é a meta.
    const fonte = [
      "components/inbox/MessageBubble.tsx",
      "components/inbox/bolha/CorpoDaBolha.tsx",
      "components/inbox/bolha/MetaDaBolha.tsx",
    ].map((arquivo) => readFileSync(arquivo, "utf8")).join("\n");
    expect(fonte).toMatch(/revoked_at/);
    expect(fonte).toMatch(/editada/);
    expect(fonte).toMatch(/Esta mensagem foi apagada/);
    const regua = readFileSync("lib/messaging/apagada.ts", "utf8");
    expect(regua).toMatch(/Esta mensagem foi apagada pelo contato/);
  });
});
