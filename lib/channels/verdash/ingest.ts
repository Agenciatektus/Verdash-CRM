/**
 * Ingestão do canal Verdash: webhook → contato, conversa, mensagem.
 *
 * A leitura do payload é do módulo puro ao lado (`./webhook.ts`); aqui moram os
 * EFEITOS.
 *
 * ─── Por que este canal TAMBÉM grava a thread ───────────────────────────────
 *
 * A primeira versão não gravava `provider_conversation_id`, com o argumento de
 * que aqui o endereço é o telefone e se deriva do contato. **Estava errado, e o
 * erro apareceu em produção no segundo dia.**
 *
 * Dois motivos, e o segundo é o que quebra de verdade:
 *
 * 1. Em LID mode (a Hidden Number Migration do WhatsApp), o chat NÃO é um
 *    telefone: chega como `162379946016868@lid`. Reconstruir um telefone para
 *    responder é inventar um endereço que o servidor não conhece.
 *
 * 2. O telefone que guardamos passa por `canonicalPhoneBR`, que escolhe a
 *    variante MAIS LONGA — isto é, ACRESCENTA o nono dígito. É a convenção de
 *    armazenamento do repo e está certa para o cadastro. Só que uma linha antiga
 *    é conhecida pelo WhatsApp SEM o nono dígito, e aí o que gravamos deixa de
 *    ser um endereço válido:
 *
 *      SenderAlt do webhook : 556684057837@s.whatsapp.net   (12 dígitos)
 *      contato no CRM       : +5566984057837                (13, canônico)
 *      envio                : 500 "no LID found for 5566984057837@s.whatsapp.net"
 *
 * O JID do chat não tem esses dois problemas: é o endereço que o próprio
 * servidor usou para nos entregar a mensagem. Guardá-lo é guardar a resposta
 * em vez de recalculá-la — e recalcular, aqui, dá errado.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * O FZAP reentrega o que não recebeu 200, e reentrega o MESMO evento. A chave é
 * `(organization_id, external_id)` no INSERT, com captura do `23505` — igual aos
 * dois canais irmãos. Sem isso, uma retentativa duplica a mensagem no inbox.
 *
 * ─── A mídia tem relógio correndo ───────────────────────────────────────────
 *
 * A URL que o FZAP resolve expira em ~30 minutos. O `emit_event` de persistência
 * é disparado na mesma requisição justamente por isso: o worker precisa baixar
 * os bytes ENQUANTO a URL vale. Adiar isso para um cron significaria mídia
 * perdida — e, diferente de quase tudo, mídia perdida não se recupera depois: o
 * FZAP não guarda o arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { extrairAtribuicaoVerdash } from "./atribuicao-de-anuncio";

import { aplicarAlteracaoDeMensagem } from "../alteracao-de-mensagem";

import { insertMessage, marcarConversa, pedirPersistenciaDaMidia } from "./gravacao";
import { ingerirGrupo } from "./grupo";
import { aplicarEventoDeConexao, eventoDeConexao, horaDoEvento } from "./eventos-conexao";
import { parseVerdashInbound, type VerdashInboundMessage } from "./webhook";

export interface VerdashIngestResult {
  /** `updated` = edição ou apagada aplicada sobre uma mensagem que já existia. */
  status: "ingested" | "duplicate" | "ignored" | "updated";
  conversationId?: string;
  messageId?: string;
  /** Por que foi ignorado — vai para o log, e é o que se lê quando "sumiu". */
  reason?: string;
}

/**
 * Identidade → `wa_identity`, o MESMO vocabulário dos outros canais
 * (`phone:+E164` | `lid:<digits>`).
 *
 * Reusar o prefixo é o que faz a pessoa ser o mesmo contato quando ela aparece
 * por mais de um canal. Um terceiro prefixo criaria dois contatos para uma
 * pessoa só.
 */
export function waIdentityFrom(msg: VerdashInboundMessage): string | null {
  if (msg.identity.phone) return `phone:${canonicalPhoneBR(msg.identity.phone)}`;
  if (msg.identity.lid) return `lid:${msg.identity.lid}`;
  return null;
}

export async function ingestVerdashInbound(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    payload: unknown;
    requestId?: string;
  },
): Promise<VerdashIngestResult> {
  const evento = eventoDeConexao(input.payload);
  if (evento) {
    return aplicarEventoDeConexao(admin, {
      organizationId: input.organizationId,
      channelSessionId: input.channelSessionId,
      evento,
      emIso: horaDoEvento(input.payload),
    });
  }
  const msg = parseVerdashInbound(input.payload);
  if (!msg) return { status: "ignored", reason: "evento_sem_interesse" };

  // Grupo só entra se o operador o LIGOU em Conexões › Grupos; o resto é descartado em
  // `lib/grupos/ingest.ts`, como no canal por QR. Sem contato por participante, sem lead,
  // sem IA (salvo a chave por grupo): o inbox continua sendo de atendimento.
  if (msg.isGroup) return ingerirGrupo(admin, input, msg);

  // Sinal de protocolo, anúncio de álbum, reação retirada: não é conversa, e
  // gravá-lo era o que punha balão VAZIO no inbox (ver `./conteudo.ts`).
  if (msg.ignorar) return { status: "ignored", reason: msg.ignorar };

  // Edição e apagada ALTERAM a original. Gravá-las como mensagem nova criava um
  // balão vazio, deixava o texto antigo na original e — por ser INSERT de
  // entrada — acordava a IA para responder a nada.
  // A autoria é conferida em `aplicarAlteracaoDeMensagem` (o WhatsApp não a
  // confere por nós): só o autor, na mesma sessão e conversa, altera.
  if (msg.alteracao) {
    const r = await aplicarAlteracaoDeMensagem(admin, {
      organizationId: input.organizationId,
      channelSessionId: input.channelSessionId,
      direcao: msg.direction,
      alvo: msg.alteracao.alvo,
      chat: { jid: msg.chat, phone: msg.identity.phone, lid: msg.identity.lid },
      acao: msg.alteracao.acao,
      texto: msg.alteracao.acao === "editar" ? msg.alteracao.texto : null,
    });
    if (r.aplicada) return { status: "updated", conversationId: r.conversationId, messageId: r.messageId };
    // Recusa por autoria/conversa é o sinal de edição forjada: vai para o log,
    // só com a sessão e o motivo (nada do contato nem do texto).
    if (!r.motivo.endsWith("_sem_original")) {
      logger.warn("[verdash] alteração de mensagem recusada", {
        channelSessionId: input.channelSessionId,
        motivo: r.motivo,
      });
    }
    return { status: "ignored", reason: r.motivo };
  }

  const identity = waIdentityFrom(msg);
  if (!identity) {
    // Sem âncora utilizável, criar contato anônimo faria a próxima mensagem da
    // MESMA pessoa virar um segundo contato.
    return { status: "ignored", reason: "sem_identidade_utilizavel" };
  }

  const contactId = await upsertContact(admin, input.organizationId, msg, identity);
  if (!contactId) return { status: "ignored", reason: "contato_nao_resolvido" };

  // De qual anúncio a pessoa veio. Só ENTRADA: a mensagem que SAIU não carrega o
  // clique de ninguém. A regra de primeiro toque é do banco, então reenvio e
  // segunda conversa não reescrevem a origem; a falha é logada lá e não derruba
  // a entrada (o provider reenviaria).
  if (msg.direction === "inbound") {
    const atribuicao = extrairAtribuicaoVerdash(input.payload);
    if (atribuicao) {
      await estamparAtribuicaoDoContato(admin, input.organizationId, contactId, atribuicao);
    }
  }

  const { data: convData, error: convErr } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: input.organizationId,
    p_contact: contactId,
    p_session: input.channelSessionId,
  });
  if (convErr || !convData) return { status: "ignored", reason: "conversa_nao_resolvida" };
  const conversationId = convData as string;

  // O ENDEREÇO DE RESPOSTA, guardado como o servidor o entregou.
  //
  // Só quando muda: cada UPDATE em conversations vira evento do Realtime para
  // cada pessoa conectada. O filtro é `isdistinct` (IS DISTINCT FROM), não
  // `neq`: em SQL `NULL <> 'valor'` é NULL, e um `neq` nunca alcançaria a
  // conversa recém-criada, que é justamente a que precisa do campo.
  await admin
    .from("conversations")
    .update({ provider_conversation_id: msg.chat })
    .eq("id", conversationId)
    .filter("provider_conversation_id", "isdistinct", msg.chat);

  const inserted = await insertMessage(admin, {
    organizationId: input.organizationId,
    conversationId,
    contactId,
    channelSessionId: input.channelSessionId,
    msg,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId };

  await marcarConversa(admin, conversationId, msg);
  if (msg.attachments[0]?.url) {
    await pedirPersistenciaDaMidia(admin, input.organizationId, conversationId, inserted);
  }
  await efeitosDaEntrada(admin, input, msg, contactId, conversationId, inserted);

  // SAÍDA vinda do webhook = alguém respondeu o cliente POR FORA do CRM (do
  // celular, ou pela própria Verdash). A IA para nesta conversa: continuar
  // respondendo por cima de um humano que assumiu é a pior coisa que um agente
  // pode fazer. O eco do nosso PRÓPRIO envio já saiu como `"duplicate"` acima,
  // então não cai aqui.
  if (msg.direction === "outbound") {
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: input.organizationId,
      conversationId,
      canal: "verdash",
    });
  }

  return { status: "ingested", conversationId, messageId: inserted };
}

/**
 * Os efeitos de negócio da mensagem que acabou de entrar.
 *
 * Delega no passo COMPARTILHADO (`lib/channels/pos-entrada.ts`) em vez de
 * reimplementar: opt-out, nascimento do lead e despacho do agente são regra do
 * produto, não característica deste transporte. Foi exatamente uma cópia
 * privada dentro de outro ingest que deixou um canal sem os três.
 *
 * Só para ENTRADA: o eco de um envio nosso (ou do celular do operador) não pede
 * para sair, não abre demanda e não acorda o agente.
 */
async function efeitosDaEntrada(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; requestId?: string },
  msg: VerdashInboundMessage,
  contactId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  if (msg.direction !== "inbound") return;

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId,
    conversationId,
    messageId,
    channelSessionId: input.channelSessionId,
    texto: msg.text,
    nomeDoContato: msg.identity.displayName,
    requestId: input.requestId,
    origem: "verdash_webhook",
    // Canal hospedado: o transporte muda, a rede do cliente continua WhatsApp.
    rede: "whatsapp",
  });
}

async function upsertContact(
  admin: SupabaseClient,
  organizationId: string,
  msg: VerdashInboundMessage,
  identity: string,
): Promise<string | null> {
  const kind = identity.startsWith("phone:") ? "phone" : "lid";
  const valor = identity.slice(identity.indexOf(":") + 1);
  const phone = msg.identity.phone ? canonicalPhoneBR(msg.identity.phone) : null;

  // Reusa a RPC dos canais irmãos: ela já resolve numa transação a corrida de
  // dois webhooks simultâneos, e escrever um segundo upsert seria criar um
  // segundo lugar onde a mesma corrida pode voltar.
  //
  // `p_phone` vai TAMBÉM quando a âncora é lid: sem isso, um contato que já
  // existia só com número vira um segundo cadastro quando o WhatsApp passa a
  // mandar o identificador opaco.
  const { data, error } = await admin.rpc("fn_upsert_wa_contact", {
    p_org: organizationId,
    p_kind: kind,
    p_phone: phone,
    p_lid: kind === "lid" ? valor : null,
    p_chat_id: msg.chat,
    p_notify: msg.identity.displayName,
  });
  if (error) return null;
  const contactId = (data as string) ?? null;
  if (!contactId) return null;

  // O telefone entra mesmo quando a âncora foi o id opaco — a RPC só grava
  // `phone_number` no kind phone, e descartá-lo deixa o contato sem número: o
  // envio para em `missing_phone_number` e a tela não tem o que mostrar ao
  // atendente que precisa saber com quem está falando.
  //
  // `is null` no filtro: só preenche o que está vazio. Sobrescrever apagaria
  // uma correção feita à mão na tela.
  if (phone) {
    await admin.from("contacts").update({ phone_number: phone }).eq("id", contactId).is("phone_number", null);
  }

  return contactId;
}

