/**
 * O transporte do canal Verdash — HTTP contra o FZAP, e nada além disso.
 *
 * Todo o vocabulário do provider (nome de rota, nome de campo, forma da
 * resposta) está confinado aqui e no adapter, que é o que
 * `docs/doctrine/restricao-de-canal.md` exige e o `scripts/lint-channels.ts`
 * cobra.
 *
 * ─── O contrato, MEDIDO contra o servidor real (v1.32.0) ────────────────────
 *
 * Autenticação: header `token`, com o token DA INSTÂNCIA. Confirmado no
 * `securitySchemes` do OpenAPI que o próprio servidor publica:
 *
 *     ApiKeyAuth: { type: apiKey, in: header, name: token }
 *
 * Resposta, em TODAS as rotas, no mesmo envelope:
 *
 *     { code: 200, success: true, data: { ... } }
 *
 * O `success: false` pode vir COM 200 — por isso quem lê precisa olhar os dois,
 * e não só `res.ok`. Ler apenas o status HTTP transformaria recusa do provider
 * em "enviado com sucesso", que é a falha-em-verde que a doutrina do repo
 * proíbe.
 */
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { samePhone } from "@/lib/channels/phone-variants";
import type { ChannelGroup } from "@/lib/channels/types";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

import { verdashFunctionsUrl } from "./credentials";
import type { VerdashCredentials } from "./credentials";

/** O envelope que toda rota do FZAP devolve. */
export interface FzapEnvelope<T = unknown> {
  code?: number;
  success?: boolean;
  data?: T;
  error?: string;
}

/**
 * Teto de espera. Sem ele, um servidor que pendura a conexão pendura junto o
 * cron de saúde — e a varredura deixa de rodar para TODAS as sessões, não só
 * para a que travou.
 */
const TIMEOUT_MS = 20_000;

/**
 * Faz o pedido e devolve o envelope já validado.
 *
 * LANÇA com `verdash_...` e o motivo do provider quando a coisa dá errado: é o
 * `code`/`error` dele que distingue "número não existe no WhatsApp" de "token
 * revogado" de "instância desconectada", e sem isso o operador lê só "falhou".
 */
export async function fzapRequest<T = unknown>(
  creds: VerdashCredentials,
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; timeoutMs?: number } = {
    method: "GET",
  },
): Promise<T> {
  const url = `${creds.baseUrl.replace(/\/+$/, "")}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        // O token DA INSTÂNCIA. Ver `./credentials.ts` para por que não existe
        // caminho neste arquivo que aceite o admin token do servidor.
        token: creds.token,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as FzapEnvelope<T> | null;

  if (!res.ok || json?.success === false) {
    // O `error` do provider entra no texto quando existe. NUNCA o corpo cru
    // inteiro: a resposta de `/session/status` carrega o token da instância, e
    // um erro que vaze isso para o log de aplicação desfaz o motivo de tudo
    // isto existir.
    const detalhe = json?.error ?? res.statusText ?? "";
    throw new Error(`verdash_request_failed: ${res.status} ${detalhe}`.trim());
  }

  return json?.data as T;
}

/**
 * O JID de verdade de um telefone — perguntado ao WhatsApp, não deduzido.
 *
 * ─── Por que não dá para deduzir ────────────────────────────────────────────
 *
 * O nono dígito não é regra universal no Brasil. Ele existe para celular em
 * boa parte do país, NÃO existe em fixo, e há linha antiga que o WhatsApp
 * continua conhecendo sem ele. Some a isso o LID mode, em que o endereço nem
 * é telefone. Qualquer regra que a gente escreva aqui vai estar errada para
 * alguma faixa — e errada de um jeito que só aparece quando um atendente tenta
 * responder e a mensagem não sai.
 *
 * `POST /user/check` aceita várias grafias de uma vez e responde quais estão no
 * WhatsApp, com o JID de cada uma. Então em vez de decidir, perguntamos: manda
 * as variantes (com e sem o nono dígito) e usa a que o servidor reconhecer.
 *
 * Isso só roda quando NÃO há thread conhecida — responder a quem já escreveu
 * usa o endereço por onde a mensagem chegou, que é mais barato e mais certo.
 *
 * `null` quando nenhuma variante está no WhatsApp: aí quem chama decide, e o
 * desfecho honesto é falhar dizendo que o número não tem WhatsApp, em vez de
 * mandar para um endereço inventado e receber um erro que não explica nada.
 */
export async function resolverJidDoTelefone(
  creds: VerdashCredentials,
  variantes: string[],
): Promise<string | null> {
  const numeros = [
    ...new Set(variantes.map((v) => v.replace(/\D/g, "")).filter((v) => v.length >= 8)),
  ];
  if (numeros.length === 0) return null;

  try {
    const data = await fzapRequest<{
      users?: Array<{ query?: string; isInWhatsapp?: boolean; jid?: string; lId?: string }>;
    }>(creds, "/user/check", { method: "POST", body: { phone: numeros } });

    const achado = (data?.users ?? []).find((u) => u?.isInWhatsapp && (u?.lId || u?.jid));
    if (!achado) return null;

    // O LID na frente do telefone, quando o servidor devolve os dois.
    //
    // Medido contra a instância real: perguntar por `5566984057837` (a grafia
    // do cadastro, com o nono dígito) devolve
    //   jid: 556684057837@s.whatsapp.net   ← o telefone de verdade, sem o 9
    //   lId: 162379946016868@lid           ← o endereço nativo da conta
    //
    // Os dois estão certos, mas esta conta opera em LID mode — TODA conversa
    // chega com `Chat` em `@lid` —, e foi tentando entregar num
    // `@s.whatsapp.net` que o servidor respondeu `no LID found`. Preferir o LID
    // é falar o idioma que a conta já está falando.
    return achado.lId ?? achado.jid ?? null;
  } catch {
    // Consulta que falha não pode impedir o envio: quem chama segue com o
    // telefone que tinha. Pior caso, volta ao comportamento anterior.
    return null;
  }
}

/**
 * A conexão pareada está de pé? Pergunta feita à VERDASH, não ao FZAP.
 *
 * ─── Por que existe uma função só para isto ─────────────────────────────────
 *
 * No modo pareado o token que guardamos é um token de MÁQUINA que a Verdash
 * emitiu — ele vale para a API dela, e o servidor de WhatsApp nunca o viu.
 * Entregá-lo ao FZAP, que é o que `fzapRequest` faz, ganha 401, e o 401 o
 * adapter lê como "a credencial da instância foi recusada": a conexão aparece
 * como caída na tela enquanto mensagem entra e sai normalmente. Foi o defeito
 * medido no número do Felipe (Lior) em 24/09/2026 — alarme crítico numa linha
 * saudável, que é o tipo de aviso que ensina o operador a ignorar a cor.
 *
 * Perguntar à Verdash também responde MELHOR: ela distingue o soluço de socket
 * (rotina do whatsmeow, segundos) da queda de verdade, distinção que o
 * `/session/status` do FZAP não faz.
 *
 * Lança com o mesmo vocabulário de `fzapRequest` (`verdash_unreachable`,
 * `verdash_request_failed: <status>`) de propósito: o `checkHealth` classifica
 * os dois modos pelo mesmo `catch`, e dois vocabulários fariam o ramo pareado
 * cair no ramo "não sei" a cada recusa.
 */
export async function verdashStatusPareado(
  creds: VerdashCredentials,
): Promise<{ conectada?: boolean; reconectando?: boolean; status?: string }> {
  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-status-instancia`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-crm-token": creds.token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { conectada?: boolean; reconectando?: boolean; status?: string };
  } | null;

  if (!res.ok || json?.success !== true) {
    // Só o `error` nomeado da Verdash entra no texto, nunca o corpo cru — a
    // mesma razão de `fzapRequest`: resposta de status carrega credencial.
    const detalhe = json?.error ?? res.statusText ?? "";
    throw new Error(`verdash_request_failed: ${res.status} ${detalhe}`.trim());
  }

  return json.data ?? {};
}

/** O que a Verdash sabe do anúncio de um contato (campos de `tracker_leads`). */
export interface AtribuicaoDaVerdash {
  ad_id: string | null;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  ctwa_clid: string | null;
}

/**
 * Pergunta à Verdash de qual anúncio vieram estes telefones (modo PAREADO).
 *
 * No pareado o CRM recebe a mensagem do FZAP com só o id do anúncio e o clique;
 * o NOME da campanha e do conjunto vem do enriquecimento, que a Verdash faz e o
 * CRM não alcança (o token de máquina só serve para pedir envio). Daí esta
 * consulta, com o mesmo `x-crm-token` do envio e do status.
 *
 * Lança com o vocabulário de `verdashStatusPareado`. Quem chama decide se a
 * falha derruba algo: na ficha do contato ela só deixa o nome da campanha para
 * depois.
 */
export async function verdashAtribuicaoPareada(
  creds: VerdashCredentials,
  telefones: string[],
  prazoMs: number = TIMEOUT_MS,
): Promise<Map<string, AtribuicaoDaVerdash | null>> {
  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-atribuicao-do-lead`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-crm-token": creds.token, "content-type": "application/json" },
      body: JSON.stringify({ telefones }),
      signal: AbortSignal.timeout(prazoMs),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { resultados?: { telefone?: string; atribuicao?: AtribuicaoDaVerdash | null }[] };
  } | null;

  if (!res.ok || json?.success !== true) {
    const detalhe = json?.error ?? res.statusText ?? "";
    throw new Error(`verdash_request_failed: ${res.status} ${detalhe}`.trim());
  }

  const saida = new Map<string, AtribuicaoDaVerdash | null>();
  for (const r of json.data?.resultados ?? []) {
    if (typeof r.telefone === "string") saida.set(r.telefone, r.atribuicao ?? null);
  }
  return saida;
}

/** O aviso de quem é o dono do envio de conversões (ver `lib/conversoes/aviso-ao-canal.ts`). */
export type AvisoDeConversoes =
  | { ativo: false }
  | { ativo: true; pixel_id: string; eventos: string[] };

/**
 * Avisa à Verdash que o CRM é (ou deixou de ser) o dono do envio de conversões.
 *
 * Com `ativo: true` a Verdash para de enviar o que o CRM já envia; o aviso VENCE
 * em 48 h se não for reafirmado (o cron diário reafirma). Mesmo `x-crm-token` e
 * mesmo vocabulário de erro de `verdashAtribuicaoPareada`; o token nunca entra
 * em mensagem de erro nem em log.
 */
export async function verdashConversoesStatus(
  creds: VerdashCredentials,
  aviso: AvisoDeConversoes,
  prazoMs: number = TIMEOUT_MS,
): Promise<{ ativo: boolean }> {
  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-conversoes-status`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-crm-token": creds.token, "content-type": "application/json" },
      body: JSON.stringify(aviso),
      redirect: "error",
      signal: AbortSignal.timeout(prazoMs),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { ativo?: boolean };
  } | null;

  if (!res.ok || json?.success !== true) {
    const detalhe = json?.error ?? res.statusText ?? "";
    throw new Error(`verdash_request_failed: ${res.status} ${detalhe}`.trim());
  }

  return { ativo: json.data?.ativo === true };
}

/** Um lead do módulo de tráfego pago do FZAP (só o que a atribuição usa). */
interface LeadDoFzap {
  senderPhone?: string | null;
  chatJid?: string | null;
  adId?: string | null;
  adName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adCtwaClid?: string | null;
  createdAt?: string | null;
}

const soDigitos = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");

/**
 * De qual anúncio veio este telefone, perguntado AO FZAP (modo DIRETO).
 *
 * No canal direto o CRM tem o token da instância, e o módulo de tráfego pago do
 * FZAP já devolve o lead enriquecido (campanha, conjunto, anúncio). No canal
 * pareado o token só serve para pedir envio, e quem responde é
 * `verdashAtribuicaoPareada`.
 *
 * A busca é pelos 8 ÚLTIMOS dígitos, de propósito: o FZAP grava o número como o
 * WhatsApp o conhece, com ou sem o nono dígito, e `search` pelo número inteiro
 * não acha o que está na outra grafia (medido em produção em 24/10/2026). O que
 * volta é filtrado aqui pelas duas grafias, então um número parecido de outra
 * pessoa não entra. Lança com o vocabulário do canal; `null` quando nenhum lead
 * do telefone tem sinal de anúncio.
 */
export async function fzapAtribuicaoDireta(
  creds: VerdashCredentials,
  telefone: string,
  prazoMs: number = TIMEOUT_MS,
): Promise<AtribuicaoDaVerdash | null> {
  const digitos = soDigitos(telefone);
  if (digitos.length < 8) return null;

  const r = await fzapRequest<{ items?: LeadDoFzap[] }>(
    creds,
    `/paid-traffic/leads?search=${digitos.slice(-8)}&limit=10&page=1`,
    { method: "GET", timeoutMs: prazoMs },
  );
  const itens = Array.isArray(r?.items) ? r.items : [];

  const pontos = (l: LeadDoFzap) =>
    (l.adId ? 4 : 0) +
    (l.campaignName ? 2 : 0) +
    (l.adSetName ? 1 : 0) +
    (l.adName ? 1 : 0) +
    (l.adCtwaClid ? 1 : 0);

  let melhor: LeadDoFzap | null = null;
  for (const l of itens) {
    const doLead = soDigitos(l.senderPhone) || soDigitos((l.chatJid ?? "").split("@")[0]);
    if (!doLead || !samePhone(`+${digitos}`, `+${doLead}`)) continue;
    const p = pontos(l);
    if (p === 0) continue;
    if (
      !melhor ||
      p > pontos(melhor) ||
      (p === pontos(melhor) && (l.createdAt ?? "") < (melhor.createdAt ?? ""))
    ) {
      melhor = l;
    }
  }
  if (!melhor) return null;
  return {
    ad_id: melhor.adId ?? null,
    ad_name: melhor.adName ?? null,
    adset_id: melhor.adSetId ?? null,
    adset_name: melhor.adSetName ?? null,
    campaign_id: melhor.campaignId ?? null,
    campaign_name: melhor.campaignName ?? null,
    ctwa_clid: melhor.adCtwaClid ?? null,
  };
}

/**
 * Manda a mensagem — e decide por onde ela sai.
 *
 * ─── Os dois caminhos, e por que existem ────────────────────────────────────
 *
 * PAREADO (`vinculoId` presente): pede o envio à Verdash, com um token de
 * máquina que vale para uma instância. O token do servidor de WhatsApp nunca
 * esteve aqui, revogar é um clique na tela de lá, e o número OFICIAL da Meta
 * funciona pelo mesmo caminho — porque quem escolhe entre Cloud API e o
 * servidor não-oficial é a Verdash, não o CRM.
 *
 * DIRETO (`vinculoId` nulo): fala com o servidor de WhatsApp usando o token da
 * própria instância. É como o primeiro número entrou no ar, continua
 * funcionando, e tem um salto a menos — mas carrega o token aqui dentro, com o
 * custo que isso tem na hora de revogar.
 *
 * Quem chama não escolhe: a sessão é que sabe qual é o seu modo.
 */
export async function verdashEnviar(
  creds: VerdashCredentials,
  input: {
    rota: string;
    body: Record<string, unknown>;
    /** Como o pedido fica quando quem transporta é a Verdash. */
    pareado: {
      phone: string;
      tipo: string;
      texto?: string;
      mediaUrl?: string;
      filename?: string;
      replyTo?: string;
    };
  },
): Promise<{ id?: string }> {
  if (!creds.vinculoId) {
    return fzapRequest<{ id?: string }>(creds, input.rota, { method: "POST", body: input.body });
  }

  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-enviar-mensagem`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        // O token de máquina vai num header PRÓPRIO, não em `Authorization`:
        // a função da Verdash não usa JWT, e misturar os dois faria o gateway
        // dela tentar validar um token que não é dela.
        "x-crm-token": creds.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone: input.pareado.phone,
        tipo: input.pareado.tipo,
        ...(input.pareado.texto !== undefined ? { texto: input.pareado.texto } : {}),
        ...(input.pareado.mediaUrl ? { media_url: input.pareado.mediaUrl } : {}),
        ...(input.pareado.filename ? { filename: input.pareado.filename } : {}),
        ...(input.pareado.replyTo ? { reply_to: input.pareado.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    detalhe?: string;
    data?: { message_id?: string };
  } | null;

  if (!res.ok || json?.success !== true) {
    // 401 aqui é o caso que mais vai acontecer com o tempo: alguém revogou o
    // acesso na Verdash. Nomear isso poupa uma investigação inteira.
    if (res.status === 401) {
      throw new Error(
        "verdash_acesso_revogado: a Verdash não reconhece mais este CRM nesta linha.",
      );
    }
    const detalhe = json?.detalhe ?? json?.error ?? res.statusText;
    throw new Error(`verdash_request_failed: ${res.status} ${detalhe}`.trim());
  }

  return { id: json?.data?.message_id ?? undefined };
}

/**
 * Baixa mídia que o cliente mandou, com as guardas de saída do repo.
 *
 * A URL vem do PAYLOAD do webhook, e é payload de fora. Sem guarda, um
 * `http://169.254.169.254/...` faria o servidor buscar metadado de nuvem — e o
 * pedido leva credencial junto, então o SSRF aqui não é só "buscou o que não
 * devia": é ENTREGAR a chave ao host que o payload escolheu.
 *
 * O par é o mesmo que `lib/automation/actions/call-webhook.ts` já usa: o
 * textual recusa de graça o que dá (esquema, http em produção, IPv6 literal,
 * faixa privada) e o outro paga o DNS e julga o IP resolvido, fechando o
 * rebinding.
 *
 * EXCEÇÃO deliberada: quando a URL aponta para a própria base do FZAP, a guarda
 * de IP é dispensada. A instalação da Tektus fala com o FZAP por IP privado da
 * rede interna da VPS (é o certo: não sai para a internet), e a guarda recusa
 * faixa privada por construção. Dispensar só para o host que nós mesmos
 * configuramos no `.env` não abre o SSRF, porque esse host não vem do payload.
 *
 * ─── E a exceção precisa comparar ORIGEM, não prefixo de string ─────────────
 *
 * A primeira versão fazia `url.startsWith(creds.baseUrl)`, e isso é furado de
 * três jeitos — medidos no parser de URL, não deduzidos:
 *
 *   https://fzap.verdash.com.br@evil.com/x        → hostname: evil.com
 *   https://fzap.verdash.com.br:8081@169.254.169.254/  → hostname: 169.254.169.254
 *   https://fzap.verdash.com.br.evil.com/x        → hostname: fzap.verdash.com.br.evil.com
 *
 * Os três passam pelo prefixo e pulam AS DUAS guardas. E o `fetch` abaixo manda
 * `token: creds.token` — o token da instância — para o host que o payload
 * escolheu. É exatamente o desfecho que o parágrafo acima descreve como o que
 * esta função existe para impedir.
 *
 * `origin` compara esquema, host e porta de uma vez; o userinfo é recusado à
 * parte, porque `new URL()` o guarda fora da origem.
 */
export async function fzapFetchMedia(
  creds: VerdashCredentials,
  url: string,
): Promise<{ buffer: Buffer; mime: string }> {
  let alvo: URL;
  let base: URL;
  try {
    alvo = new URL(url);
    base = new URL(creds.baseUrl);
  } catch {
    throw new Error("verdash_media_url_invalida");
  }
  const daPropriaBase = alvo.origin === base.origin && alvo.username === "" && alvo.password === "";
  if (!daPropriaBase) {
    assertSafeOutboundUrl(url);
    await assertDestinoResolvidoSeguro(alvo.hostname);
  }

  const res = await fetch(url, {
    headers: { token: creds.token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // 404 costuma ser mídia já descartada pelo servidor e 401 token — desfechos
    // diferentes, e o status é o que distingue os dois para quem investigar.
    throw new Error(`verdash_media_failed: ${res.status} ${res.statusText}`.trim());
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // O `content-type` da resposta manda sobre a dica do webhook: é o que o
  // arquivo REALMENTE é, e é ele que vai no `contentType` do upload.
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return { buffer, mime };
}

/**
 * Prazo da foto, menor que o `TIMEOUT_MS` geral: roda dentro do orçamento do
 * lote do cron de fotos (60 s do scheduler), e a função da Verdash já se limita
 * a 8 s no FZAP.
 */
const TIMEOUT_DA_FOTO_MS = 10_000;

/**
 * A foto de perfil do contato no MODO PAREADO (WhatsApp ou Instagram da
 * Verdash), pedida à função `crm-foto-perfil` com o token de máquina do vínculo.
 * O token do FZAP e o do Instagram ficam lá; aqui só chega a URL.
 *
 * Contrato (Verdash `supabase/functions/crm-foto-perfil/handler.ts`):
 * `POST {destinatario}` → `{success: true, data: {url: string | null}}`.
 *
 * LANÇA em recusa ou rede, em vez de devolver `null`: `null` significa "o
 * contato não tem foto", e uma queda da plataforma não pode se passar por isso.
 * A mensagem do erro nunca leva a URL nem o destinatário (PII).
 */
export async function fotoDoContatoPareado(
  creds: VerdashCredentials,
  destinatario: string,
): Promise<string | null> {
  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-foto-perfil`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-crm-token": creds.token, "Content-Type": "application/json" },
      body: JSON.stringify({ destinatario }),
      signal: AbortSignal.timeout(TIMEOUT_DA_FOTO_MS),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { url?: unknown };
  } | null;
  if (!res.ok || json?.success !== true) {
    throw new Error(`verdash_request_failed: ${res.status} ${json?.error ?? ""}`.trim());
  }
  return typeof json.data?.url === "string" && json.data.url ? json.data.url : null;
}

const JID_DE_GRUPO = /^[\d-]+@g\.us$/;

/**
 * Lê a lista de `/group/list` do FZAP (direto) ou de `crm-listar-grupos` da Verdash (pareado).
 * O FZAP muda o envelope entre versões (`data: [...]`, `data.Groups`, `data.groups`) e o nome
 * entre `Name`/`name`; o que não for JID de grupo fica de fora.
 */
export function gruposDaLista(data: unknown): ChannelGroup[] {
  const d = data as Record<string, unknown> | unknown[] | null;
  const lista = Array.isArray(d)
    ? d
    : Array.isArray(d?.groups)
      ? (d.groups as unknown[])
      : Array.isArray(d?.Groups)
        ? (d.Groups as unknown[])
        : [];
  const out: ChannelGroup[] = [];
  for (const item of lista) {
    const g = (item ?? {}) as Record<string, unknown>;
    const chatId = String(g.chatId ?? g.JID ?? g.jid ?? "");
    if (!JID_DE_GRUPO.test(chatId)) continue;
    const nome = String(g.subject ?? g.Name ?? g.name ?? "").trim().slice(0, 200);
    out.push({ chatId, subject: nome || null, ...detalhesDoGrupo(g) });
  }
  return out;
}

/**
 * Contagens, papel e tipo. Pareado, a Verdash já devolve pronto (`adminCount`, `tipo`…);
 * direto, vêm do FZAP cru e saem dos participantes, pela mesma regra do `crm-listar-grupos`.
 * Os participantes são lidos só para contar: nunca saem desta função. No modo direto o
 * telefone da sessão não está à mão, então `papel` fica `null`.
 */
function detalhesDoGrupo(g: Record<string, unknown>): Omit<ChannelGroup, "chatId" | "subject"> {
  const gente = (Array.isArray(g.participants) ? g.participants : Array.isArray(g.Participants) ? g.Participants : []) as Array<
    Record<string, unknown>
  >;
  const ehAdmin = (p: Record<string, unknown>) =>
    p.isSuperAdmin === true || p.IsSuperAdmin === true || p.isAdmin === true || p.IsAdmin === true;
  const total = g.participantCount ?? g.ParticipantCount;
  const pai = String(g.linkedParentJid ?? g.LinkedParentJID ?? "");
  const tipo =
    g.tipo === "grupo" || g.tipo === "comunidade" || g.tipo === "grupo_da_comunidade"
      ? g.tipo
      : g.isParent === true || g.IsParent === true
        ? "comunidade"
        : pai.endsWith("@g.us")
          ? "grupo_da_comunidade"
          : "grupo";
  return {
    participantCount: typeof total === "number" ? total : gente.length || null,
    adminCount: typeof g.adminCount === "number" ? g.adminCount : gente.filter(ehAdmin).length,
    papel: g.papel === "dono" || g.papel === "admin" || g.papel === "membro" ? g.papel : null,
    isAnnounce: g.isAnnounce === true || g.IsAnnounce === true,
    tipo,
  };
}

/** Grupos do número. Pareado pergunta à Verdash (o token daqui não vale no FZAP); direto, ao FZAP. */
export async function verdashListarGrupos(creds: VerdashCredentials): Promise<ChannelGroup[]> {
  // 35 s: o `/group/list` traz todos os participantes (vários MB num número comercial).
  if (!creds.vinculoId) return gruposDaLista(await fzapRequest(creds, "/group/list", { method: "GET", timeoutMs: 35_000 }));

  const url = `${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-listar-grupos`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-crm-token": creds.token },
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`verdash_unreachable: ${detalhe.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { groups?: unknown };
  } | null;
  if (!res.ok || json?.success !== true) {
    throw new Error(`verdash_request_failed: ${res.status} ${json?.error ?? ""}`.trim());
  }
  return gruposDaLista(json.data?.groups);
}
