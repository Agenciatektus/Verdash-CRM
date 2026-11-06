/**
 * O service worker do app (`public/notify-sw.js`): a navegação que falha por rede
 * recebe a tela "sem conexão"; nada mais é interceptado, e NADA é guardado em cache
 * (nem página, nem API, nem dado de cliente). O push e a bandeja continuam no mesmo
 * arquivo, porque a assinatura de push fica presa a este script.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const FONTE = readFileSync("public/notify-sw.js", "utf8");

type Ouvinte = (evento: unknown) => void;

function carregar(fetchFalso: () => Promise<Response>) {
  const ouvintes = new Map<string, Ouvinte>();
  const self = {
    addEventListener: (tipo: string, fn: Ouvinte) => ouvintes.set(tipo, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    navigator: { language: "es-AR" },
    location: { origin: "https://crm.exemplo.com.br" },
  };
  runInNewContext(FONTE, { self, fetch: fetchFalso, Response, String, Promise, URL });
  return ouvintes;
}

function navegar(ouvintes: Map<string, Ouvinte>, modo: string, metodo = "GET") {
  let resposta: Promise<Response> | null = null;
  ouvintes.get("fetch")!({
    request: { mode: modo, method: metodo },
    respondWith: (r: Promise<Response>) => {
      resposta = r;
    },
  });
  return resposta as Promise<Response> | null;
}

describe("service worker do app: tela sem conexão", () => {
  it("navegação sem rede devolve a página sem conexão, no idioma do aparelho, sem cache", async () => {
    const ouvintes = carregar(() => Promise.reject(new TypeError("Failed to fetch")));
    const resposta = await navegar(ouvintes, "navigate")!;
    expect(resposta.status).toBe(503);
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    const html = await resposta.text();
    expect(html).toContain("Sin conexión");
    expect(html).toContain("Intentar de nuevo");
  });

  it("navegação com rede passa direto (a resposta é a do servidor)", async () => {
    const doServidor = new Response("ok", { status: 200 });
    const ouvintes = carregar(() => Promise.resolve(doServidor));
    expect(await navegar(ouvintes, "navigate")).toBe(doServidor);
  });

  it("API, imagem e POST não passam pelo service worker", () => {
    const ouvintes = carregar(() => Promise.reject(new Error("não devia buscar")));
    expect(navegar(ouvintes, "cors")).toBeNull();
    expect(navegar(ouvintes, "no-cors")).toBeNull();
    expect(navegar(ouvintes, "navigate", "POST")).toBeNull();
  });

  it("não usa Cache Storage e mantém push, bandeja e clique", () => {
    expect(FONTE).not.toMatch(/\bcaches\b/);
    const ouvintes = carregar(() => Promise.reject(new Error()));
    for (const tipo of ["install", "activate", "notificationclick", "push", "fetch"]) {
      expect(ouvintes.has(tipo), tipo).toBe(true);
    }
  });
});
