/**
 * O texto do `send_message` na ORDEM original (ADR-0006, S7): a ferramenta saiu do
 * `inbound-turn.ts` para quatro módulos em `turno/ferramentas/`. As cercas que leem o
 * corpo do envio leem esta remontagem: `envio.ts`, depois a cadeia de
 * `guardrails-do-envio.ts` com os argumentos e o desfecho de volta no lugar da chamada.
 * Marcador ausente lança: um recorte vazio nunca passa verde.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ler = (f: string) =>
  readFileSync(join(process.cwd(), "lib/agent-engine/agent/turno/ferramentas", f), "utf8");

function encaixar(fonte: string, marcador: RegExp, trecho: string): string {
  if (!marcador.test(fonte)) throw new Error(`fonte do send_message: marcador ${marcador} sumiu`);
  return fonte.replace(marcador, () => trecho);
}

export function fonteDoSendMessage(): string {
  let cadeia = ler("guardrails-do-envio.ts");
  cadeia = encaixar(cadeia, /^.*= montarArgumentosDoEnvio\(c, r, estado,.*$/m, ler("argumentos-do-envio.ts"));
  cadeia = encaixar(cadeia, /^.*return responderAoDesfecho\(outcome,.*$/m, ler("resposta-do-envio.ts"));
  const envio = ler("envio.ts");
  if (!envio.includes("...AGENT_TOOL_DEFS.send_message")) throw new Error("fonte do send_message: envio.ts sem a ferramenta");
  return `${envio}\n${cadeia}`;
}

export function fonteDoSendTemplate(): string {
  return ler("envio-de-template.ts");
}

/** O recorte como as cercas o liam no `inbound-turn.ts`: entre os mesmos marcadores. */
export const ENVIO_S7 = `send_message: tool({\n${fonteDoSendMessage()}\nupdate_lead_state: criarUpdateLeadState(`;
export const TEMPLATE_S7 = `send_template: tool({\n${fonteDoSendTemplate()}\nsearch_knowledge: criarSearchKnowledge(`;
