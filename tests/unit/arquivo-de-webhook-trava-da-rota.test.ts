import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRAVA: O CAMINHO REAL DE GRAVAÇÃO DO ARQUIVO DE WEBHOOK SAI ENXUTO.
 *
 * O teste do módulo (`arquivo-de-webhook-enxuto.test.ts`) prova a função. Este
 * prova o CAMINHO: chama a rota de verdade (`POST /api/v1/webhooks/channel/
 * [token]`) com um evento do canal Verdash carregando token e mídia inteira, e
 * olha o que chegou ao `insert` de `webhook_events_log`. Só o banco, a cifra e
 * a ingestão são dublês; a rota e o arquivador são os do produto.
 *
 * Existe porque o conserto de 28/09 (PR #42) foi medido em produção em
 * 05/10/2026 deixando passar 7.291 tokens e mídia de álbum. Se uma subida do
 * upstream reescrever a rota para gravar o corpo cru, trocar o arquivador, ou
 * criar outro escritor da tabela, um destes casos reprova.
 */

const TOKEN = "TOK-DA-INSTANCIA-trava-91b2";
const SEGREDO = "s3gredo-do-header-trava";
const MIDIA = "QUJD".repeat(100_000);

const gravado: { inserts: Array<Record<string, unknown>> } = { inserts: [] };

function adminFalso() {
  return {
    from(tabela: string) {
      if (tabela === "channel_sessions") {
        const resposta = {
          data: {
            id: "sessao-1",
            organization_id: "org-1",
            provider: "verdash",
            display_name: null,
            phone_number: null,
            webhook_secret_encrypted: "cifrado",
            archived_at: null,
          },
          error: null,
        };
        const cadeia = { select: () => cadeia, eq: () => cadeia, maybeSingle: async () => resposta };
        return cadeia;
      }
      if (tabela === "webhook_events_log") {
        return {
          insert(linha: Record<string, unknown>) {
            gravado.inserts.push(linha);
            return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error(`tabela inesperada no teste: ${tabela}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFalso() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => SEGREDO }));
vi.mock("@/lib/channels/inbound", () => ({
  acceptsInboundWebhook: () => true,
  verifyInboundWebhookSignature: () => true,
  inboundPayloadBelongsToSession: async () => true,
  handleInboundWebhook: async () => ({ ok: true, body: { status: "ok" } }),
}));

async function postar(corpo: string) {
  const { POST } = await import("@/app/api/v1/webhooks/channel/[token]/route");
  const req = new Request("https://crm.exemplo/api/v1/webhooks/channel/tokendarota123", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": SEGREDO, token: TOKEN },
    body: corpo,
  });
  return POST(req as never, { params: Promise.resolve({ token: "tokendarota123" }) });
}

function vazou(texto: string): string[] {
  const achados: string[] = [];
  if (texto.includes(TOKEN)) achados.push("token");
  if (texto.includes(SEGREDO)) achados.push("segredo");
  if (texto.includes("QUJDQUJDQUJDQUJD")) achados.push("midia");
  return achados;
}

const EVENTOS: Record<string, unknown> = {
  "item de álbum no topo": {
    type: "Message",
    token: TOKEN,
    album: { albumId: "ALB-1", role: "item" },
    base64: MIDIA,
    event: { Info: { ID: "A1", Chat: "5511999999999@s.whatsapp.net" }, Message: { imageMessage: {} } },
  },
  "formato desconhecido aninhado": {
    type: "Message",
    data: { items: [{ album: { role: "item" }, base64: MIDIA, instanceToken: TOKEN }] },
  },
};

describe("a rota do canal grava o arquivo enxuto", () => {
  beforeEach(() => {
    gravado.inserts = [];
  });

  for (const [nome, evento] of Object.entries(EVENTOS)) {
    it(`${nome}: nada de token, segredo ou mídia na linha gravada`, async () => {
      const cru = JSON.stringify(evento);
      expect(vazou(cru), "controle: a entrada crua precisa vazar").not.toEqual([]);

      const resposta = await postar(cru);
      expect(resposta.status).toBe(200);
      expect(gravado.inserts, "a rota não gravou o arquivo").toHaveLength(1);
      const linha = gravado.inserts[0]!;
      expect(linha.provider).toBe("verdash");
      expect(vazou(JSON.stringify(linha))).toEqual([]);
      expect(String(linha.raw_body).length).toBeLessThan(8 * 1024);
    });
  }
});

describe("ninguém novo grava em webhook_events_log sem passar pelo arquivador", () => {
  /**
   * Escritores conhecidos. Cada um é decisão consciente: o do canal passa pelo
   * arquivador enxuto; os demais são rotas de provedor com formato próprio
   * (WAHA relê `payload_parsed` no replay; captação genérica e Nuvemshop não
   * trazem mídia). Escritor NOVO reprova até alguém decidir se ele enxuga.
   */
  const CONHECIDOS = new Set([
    "lib/channels/arquivo-de-webhook.ts",
    "app/api/v1/webhooks/waha/route.ts",
    "app/api/v1/webhooks/waha/[token]/route.ts",
    "app/api/v1/webhooks/in/[token]/route.ts",
    "app/api/v1/webhooks/nuvemshop/[event]/route.ts",
    "app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts",
    "app/api/v1/webhooks/nuvemshop/customer-redact/route.ts",
    "app/api/v1/webhooks/nuvemshop/store-redact/route.ts",
    // Upstream 1.81 (cobrança do revendedor §2.4): grava só `{id,type}` do aviso
    // da Stripe/Asaas (ou `{}` na recusa), sem cabeçalho, sem token e sem mídia.
    "app/api/v1/webhooks/cobranca/[provedor]/route.ts",
    // MercadoPhone (PDV): grava só tipo, id e NOMES das chaves (`arquivoSemPii`, lista do que
    // se guarda), `headers: {}` (sem o `mp-auth-code`, que é o token); venda não traz mídia.
    "app/api/v1/webhooks/mercadophone/route.ts",
  ]);
  const RAIZ = path.resolve(__dirname, "../..");

  function arquivosTs(dir: string): string[] {
    const out: string[] = [];
    for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, nome.name);
      if (nome.isDirectory()) {
        if (nome.name === "node_modules" || nome.name.startsWith(".")) continue;
        out.push(...arquivosTs(p));
      } else if (/\.tsx?$/.test(nome.name) && !/\.test\.tsx?$/.test(nome.name)) {
        out.push(p);
      }
    }
    return out;
  }

  it("todo insert/upsert na tabela está na lista de escritores conhecidos", () => {
    const escritores = ["app", "lib"]
      .flatMap((d) => arquivosTs(path.join(RAIZ, d)))
      .filter((f) =>
        /from\(\s*["']webhook_events_log["']\s*\)\s*\.(insert|upsert)\(/.test(fs.readFileSync(f, "utf8")),
      )
      .map((f) => path.relative(RAIZ, f).split(path.sep).join("/"));
    const novos = escritores.filter((f) => !CONHECIDOS.has(f));
    expect(novos, "escritor novo do arquivo de webhook: ele enxuga token e mídia?").toEqual([]);
    expect(escritores, "o arquivador do canal deixou de gravar").toContain("lib/channels/arquivo-de-webhook.ts");
  });

  it("o arquivador grava raw_body, payload_parsed e headers a partir do enxuto", () => {
    const s = fs.readFileSync(path.join(RAIZ, "lib/channels/arquivo-de-webhook.ts"), "utf8");
    expect(s).toMatch(/=\s*arquivoEnxuto\(entrada\.rawBody\)/);
    expect(s).toMatch(/headers:\s*cabecalhosParaArquivo\(entrada\.headers[,)]/);
    expect(s).not.toMatch(/raw_body:\s*entrada\.rawBody/);
  });
});
