/**
 * Adapter do canal Verdash — o WhatsApp que o cliente JÁ TEM conectado na
 * Verdash, falando com o CRM sem parear um segundo aparelho.
 *
 * Burro como os irmãos: traduz formato e nada mais. Um `if` sobre janela de
 * 24h, cap diário ou horário aqui dentro significaria que o desenho vazou —
 * essas regras vivem na cadeia `before_send` (doutrina `restricao-de-canal.md`).
 *
 * ─── O que este canal é, por baixo ──────────────────────────────────────────
 *
 * whatsmeow, igual ao canal por QR: WhatsApp pessoal/business comum, sem WABA,
 * sem template aprovado, sem custo por mensagem — e COM risco de banimento por
 * volume, que é o preço dessa liberdade. As capabilities em `../capabilities.ts`
 * dizem exatamente isso, e são iguais às do canal por QR por esse motivo, não
 * por cópia.
 *
 * ─── A diferença que vale a pena entender ───────────────────────────────────
 *
 * O canal por QR pareia um número NOVO: o cliente lê um QR no CRM e passa a ter
 * mais uma conexão viva do mesmo WhatsApp. Este aqui NÃO pareia nada — ele se
 * pendura na conexão que já existe na Verdash. O cliente não escaneia QR
 * nenhum: ele escolhe, numa lista, a instância que já é dele.
 *
 * O preço disso é que a conexão não é nossa: quem derruba, reconecta ou migra o
 * número é a Verdash. Por isso `checkHealth` pergunta ao FZAP em vez de assumir,
 * e por isso o adapter nunca conecta nem desconecta — mexer na conexão de outro
 * sistema é como dois donos brigam pelo mesmo número.
 *
 * ─── Medido contra o servidor real, não lido da doc ─────────────────────────
 *
 * Todos os campos abaixo saíram do OpenAPI que a instância v1.32.0 publica em
 * `/static/api/spec.yml`, conferido endpoint por endpoint. Os que mais enganam:
 *
 *  - O campo de mídia tem o NOME DO TIPO (`image`, `video`, `audio`,
 *    `document`, `sticker`), não um `attachmentUrl` genérico. Copiar o formato
 *    do canal intermediado manda o corpo errado e ganha 400.
 *  - `fileName` é camelCase, e `caption` existe em quase todos.
 *  - `ptt: true` no áudio CONVERTE para ogg/opus no servidor, e ainda gera a
 *    onda sonora e a duração. É por isso que a capability deste canal é
 *    `server-convert` e não `opus-only`: aqui não é preciso converter antes.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import {
  fzapFetchMedia,
  fzapRequest,
  resolverJidDoTelefone,
  verdashEnviar,
  verdashStatusPareado,
  fotoDoContatoPareado,
  verdashListarGrupos,
} from "../verdash/client";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { DETALHE_NUMERO_EM_CONFLITO, DETALHE_QR_RESCAN_NATIVO } from "../health";
import {
  LIMITE_DESCONECTADA_MS,
  estadoNativo,
  marcarDesconectada,
  marcarJaConectou,
  msDesconectada,
} from "../verdash/estado-nativo";
import { enviarComConsulta } from "../verdash/envio-idempotente";
import { preencherTelefoneNativo } from "../verdash/telefone-nativo";
import { fzapPublicBaseUrl, resolveVerdashCreds } from "../verdash/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/** Só dígitos. `+55 (66) 8127-6920` → `556681276920`. */
function soDigitos(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * O corpo do envio, por tipo de mensagem.
 *
 * Separado do `send` porque é a parte que muda quando o provider cresce, e
 * porque um `switch` de oito ramos no meio de uma função de transporte esconde
 * o que o transporte faz.
 */
function corpoDoEnvio(
  env: OutboundEnvelope,
  to: string,
): { rota: string; body: Record<string, unknown> } {
  const base: Record<string, unknown> = { phone: to };

  // A CITAÇÃO. `contextInfo.stanzaId` recebe o id que o WhatsApp conhece — o
  // `external_id` da linha citada, nunca o `id` da nossa tabela, que o provider
  // nunca viu. Só entra quando existe: citação é enfeite, nunca condição de
  // envio, e recusar a mensagem por falta dela seria trocar o produto pelo
  // enfeite.
  if (env.replyToExternalId) {
    base.contextInfo = {
      stanzaId: env.replyToExternalId,
      // `participant` é quem ESCREVEU a mensagem citada. Numa conversa 1:1 é o
      // próprio destinatário; em grupo o autor certo viria da linha citada, e
      // como não o carregamos, a citação em grupo pode sair sem autor.
      // Degradação aceitável: a mensagem vai, a setinha é que fica pobre.
      participant: `${to.includes("@") ? to.split("@")[0] : to}@s.whatsapp.net`,
    };
  }

  const url = env.media?.url;
  const caption = env.media?.caption ?? env.body ?? undefined;
  const fileName = env.media?.filename ?? undefined;

  switch (env.kind) {
    case "text":
      return { rota: "/chat/send/text", body: { ...base, body: env.body ?? "" } };
    case "image":
      return {
        rota: "/chat/send/image",
        body: {
          ...base,
          image: url,
          ...(caption ? { caption } : {}),
          ...(fileName ? { fileName } : {}),
        },
      };
    case "video":
      return {
        rota: "/chat/send/video",
        body: { ...base, video: url, ...(caption ? { caption } : {}) },
      };
    case "audio":
      // `ptt: true` = BOLHA DE VOZ, não anexo de música. E, diferente do canal
      // intermediado, aqui a flag também CONVERTE: pode ir mp3 que o servidor
      // entrega ogg/opus com onda sonora e duração.
      return { rota: "/chat/send/audio", body: { ...base, audio: url, ptt: true } };
    case "sticker":
      return { rota: "/chat/send/sticker", body: { ...base, sticker: url } };
    case "contact": {
      const c = env.contact;
      if (!c) throw new Error("verdash_contact_sem_dados: kind 'contact' sem o cartão preenchido.");
      return {
        rota: "/chat/send/contact",
        body: { ...base, name: c.fullName, vcard: c.vcard, contactPhone: c.phoneNumber },
      };
    }
    case "location":
      // O envelope do CRM não carrega latitude/longitude, e inventar coordenada
      // manda o cliente para o lugar errado — falhar com o motivo nomeado é o
      // desfecho honesto.
      throw new Error("verdash_location_nao_suportado: o envelope não carrega coordenadas.");
    default:
      // `document` e o que vier depois: anexo com nome de arquivo.
      return {
        rota: "/chat/send/document",
        body: {
          ...base,
          document: url,
          ...(fileName ? { fileName } : {}),
          ...(caption ? { caption } : {}),
        },
      };
  }
}

export const verdashAdapter: ChannelAdapter = {
  provider: "verdash",

  /**
   * Grupo vai pelo JID (`…@g.us`); pessoa vai em dígitos.
   *
   * O FZAP documenta o campo como "phone number or group JID" e aceita os dois
   * na mesma chave, então não há ramo de rota — só de formato.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return input.groupChatId ?? null;

    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const bruto = doIdentity ?? input.phoneNumber ?? null;
    if (bruto) {
      const digitos = soDigitos(bruto);
      if (digitos.length > 0) return digitos;
    }

    // Contato conhecido só pelo identificador opaco do WhatsApp (@lid).
    // Devolver `null` aqui diria "não há como falar com esta pessoa", e é
    // falso: acabamos de receber mensagem dela. O JID de lid é endereço válido
    // para o whatsmeow.
    const lid =
      input.waLid ??
      (input.waIdentity?.startsWith("lid:") ? input.waIdentity.slice("lid:".length) : null);
    if (lid) return lid.includes("@") ? lid : `${lid}@lid`;

    return null;
  },

  /**
   * SEMPRE `true`, pelo mesmo motivo do canal intermediado: a credencial vive
   * na SESSÃO (cifrada no banco), não no ambiente, e este método é síncrono —
   * não pode consultar o banco.
   *
   * Responder pelo env aqui diria "não configurado" para toda instalação que
   * conectou pela tela, e o handler gravaria `queued` para sempre, sem erro,
   * com o canal funcionando. Foi exatamente esse o defeito medido no canal
   * irmão.
   *
   * O custo é que quem desiste passa a ser o `send` — e ele LANÇA, em vez de
   * devolver `{externalId: null}`, para o handler gravar `failed` com motivo em
   * vez de um `sent` sem id, que diria "enviado" para algo que nunca saiu.
   */
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "verdash_not_configured",
    sendFailed: "verdash_error",
    unknownError: "verdash_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: envelope.organizationId,
      instanceName: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "verdash_not_configured: esta sessão não tem token da instância gravado. " +
          "Reconecte o canal pela tela de conexões.",
      );
    }

    // ─── O ENDEREÇO: a thread primeiro, o telefone como reserva ───────────
    //
    // `providerConversationId` é o JID que o servidor usou para nos entregar a
    // mensagem — `5566…@s.whatsapp.net` no modo antigo, `1623…@lid` em LID
    // mode. É o endereço que sabidamente funciona, porque acabou de funcionar.
    //
    // O telefone derivado do contato fica como reserva, para a conversa que
    // ainda não tem thread conhecida (um envio que o CRM inicia). E ele é
    // reserva, não preferência, por um motivo medido em produção: o telefone
    // guardado passa por `canonicalPhoneBR`, que ACRESCENTA o nono dígito, e
    // uma linha antiga é conhecida pelo WhatsApp sem ele — o envio morria com
    // `500 no LID found for 5566984057837@s.whatsapp.net`, com o contato certo
    // e o endereço errado.
    let destino = envelope.providerConversationId?.trim() || envelope.to;

    // ─── Sem thread conhecida, PERGUNTE o endereço em vez de deduzi-lo ─────
    //
    // Este é o caso de uma conversa que o CRM inicia: não houve mensagem de
    // entrada, então não há JID gravado, e o que sobra é o telefone do
    // cadastro. Montar o JID a partir dele é apostar que aquela linha usa o
    // nono dígito — e o nono dígito NÃO é regra universal no Brasil: não existe
    // em fixo, não existe em toda faixa, e há linha antiga que o WhatsApp
    // conhece sem ele.
    //
    // `resolverJidDoTelefone` manda as variantes e usa a que o servidor
    // reconhece. Custa uma chamada, só na primeira mensagem de cada conversa —
    // depois disso o eco grava a thread e este caminho não roda mais.
    if (!envelope.providerConversationId && !destino.includes("@")) {
      const resolvido = await resolverJidDoTelefone(creds, phoneLookupVariants(destino));
      if (resolvido) destino = resolvido;
    }

    const { rota, body } = corpoDoEnvio(envelope, destino);

    // NATIVA: envio idempotente. O `id` do CRM vai no corpo e, em timeout/502, o
    // status do envio é consultado antes de qualquer nova tentativa. A vinculada
    // não passa por aqui (o token dela nem é do FZAP).
    // Formato do id do WhatsApp (hex maiúsculo, sem hífens): o uuid do CRM vira 32 hex.
    const idDoEnvio = envelope.clientMessageId?.trim().replace(/-/g, "").toUpperCase() || null;
    const nativo =
      idDoEnvio && !creds.vinculoId
        ? await estadoNativo(admin, envelope.organizationId, envelope.sessionRef)
        : null;
    if (nativo?.nativa) {
      // Reconectando há pouco: o FZAP recusaria. Não há liberação automática de
      // `queued` para este canal (o resgate só alcança WAHA), então falha rápido e claro.
      const caida = msDesconectada(nativo);
      if (nativo.status === "STARTING" && caida !== null && caida < LIMITE_DESCONECTADA_MS) {
        throw new Error(
          "verdash_nativo_reconectando: o WhatsApp deste canal está reconectando. " +
            "Tente de novo em alguns minutos.",
        );
      }
      body.id = idDoEnvio;
    }

    await envelope.beforeSend?.();
    // Quem decide o transporte é a SESSÃO, não este método: canal conectado por
    // código pede o envio à Verdash; canal conectado por token fala direto com
    // o servidor de WhatsApp. Ver `verdashEnviar`.
    const enviar = () =>
      verdashEnviar(creds, {
        rota,
        body,
        pareado: {
          phone: destino,
          tipo: envelope.kind,
          texto: envelope.body ?? envelope.media?.caption ?? undefined,
          mediaUrl: envelope.media?.url,
          filename: envelope.media?.filename ?? undefined,
          replyTo: envelope.replyToExternalId ?? undefined,
        },
      });
    const data = nativo?.nativa && idDoEnvio ? await enviarComConsulta(creds, idDoEnvio, enviar) : await enviar();

    // O id do whatsmeow, o MESMO que volta no `Info.ID` do webhook — por isso
    // este canal não precisa de `echoExternalIds`: os dois lados falam a mesma
    // forma, e o eco casa por comparação direta.
    return { externalId: data?.id ?? null };
  },

  /**
   * "digitando…" no aparelho do cliente, antes da 1ª bolha do turno da IA.
   *
   * LANÇA quando o transporte recusa, como o contrato do método manda: a
   * decisão de engolir é de quem chama (o indicador é decoração; a mensagem é o
   * produto), e engolir aqui esconderia de todo chamador futuro que a chamada
   * nem chega.
   */
  async signalTyping(
    input: ChannelTenantScope & { sessionRef: string; recipient: string },
  ): Promise<void> {
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) return;
    await fzapRequest(creds, "/chat/presence", {
      method: "POST",
      body: { phone: input.recipient, state: "composing" },
    });
  },

  /**
   * A foto de perfil do contato.
   *
   * A URL devolvida é do CDN do WhatsApp e EXPIRA — quem chama baixa e
   * persiste; guardar a URL faria a foto sumir sozinha depois.
   *
   * Contato sem foto (ou com privacidade fechada) faz o servidor responder
   * erro, e isso NÃO é falha: é a resposta. Por isso o `catch` devolve `null`
   * em vez de propagar — o contrato do método já diz que `null` significa "não
   * há".
   */
  async fetchProfilePictureUrl(
    input: ChannelTenantScope & { sessionRef: string; recipient: string },
  ): Promise<string | null> {
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) return null;
    // Pareado: quem tem o token do FZAP é a Verdash, então a foto vem por ela.
    // Fora do `try` de propósito: queda da plataforma lança, e o cron conta
    // como falha em vez de "contato sem foto".
    if (creds.vinculoId) return fotoDoContatoPareado(creds, input.recipient);
    try {
      // Pelo host PÚBLICO: o FZAP monta o `publicDownloadUrl` com o host que
      // recebeu o pedido, e pela rede interna o link sairia interno (recusado
      // pela allowlist). É o que a `crm-foto-perfil` da Verdash faz.
      const publico = { ...creds, baseUrl: fzapPublicBaseUrl() };
      const data = await fzapRequest<{ publicDownloadUrl?: string }>(publico, "/user/avatar", {
        method: "POST",
        body: { phone: input.recipient, preview: false },
      });
      // Só `publicDownloadUrl`, o host público. O `url` pode apontar para a rede
      // interna do FZAP, e o cron não baixa de lá (allowlist em `contact-avatar.ts`).
      return data?.publicDownloadUrl ?? null;
    } catch {
      return null;
    }
  },

  /**
   * `lid:123…` → `+5566…`, quando o whatsmeow já tiver visto o par.
   *
   * Só para identidade OPACA: `phone:` já traz o número, e perguntar gastaria
   * uma chamada para receber de volta o que já se tem.
   *
   * `null` significa "ainda não sei", não "não existe" — o mapa do whatsmeow se
   * preenche com o uso, e quem chama pode tentar de novo depois.
   */
  async resolvePhoneForIdentity(
    input: ChannelTenantScope & { sessionRef: string; identity: string },
  ): Promise<string | null> {
    if (!input.identity.startsWith("lid:")) return null;
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) return null;

    const lid = input.identity.slice("lid:".length);
    try {
      const data = await fzapRequest<{ jid?: string }>(
        creds,
        `/user/lid/reverse?lid=${encodeURIComponent(lid.includes("@") ? lid : `${lid}@lid`)}`,
      );
      const jid = data?.jid;
      if (!jid) return null;
      const digitos = soDigitos(jid.split("@")[0] ?? "");
      return digitos ? `+${digitos}` : null;
    } catch {
      // 404 aqui é "o mapa ainda não tem este par" — resposta, não falha.
      return null;
    }
  },

  /**
   * A conexão está de pé AGORA? Pergunta feita ao FZAP, não ao banco.
   *
   * Este canal precisa disto mais que os outros, e por um motivo estrutural:
   * quem mantém a conexão é a Verdash, não o CRM. Um número que a Verdash
   * desconectou continuaria `WORKING` na nossa tabela para sempre — silêncio e
   * saúde ficariam idênticos, que é como uma desconexão real passa horas sem
   * ninguém notar.
   *
   * Os desfechos:
   *   401/403         → o token da instância foi recusado. FAILED: a credencial
   *                     existe e não vale mais (instância recriada, token
   *                     rotacionado na Verdash).
   *   404             → a instância sumiu do lado de lá. STOPPED.
   *   loggedIn:false  → o WhatsApp deslogou (número removido do aparelho).
   *                     FAILED.
   *   connected:false → o socket caiu mas a sessão vive, e a Verdash reconecta
   *                     sozinha. STARTING, não FAILED — tratar oscilação como
   *                     queda faria aviso crítico a cada reconexão, e aviso que
   *                     grita à toa ensina a ignorar aviso.
   *   inalcançável    → `reachable: false` e status NENHUM. Não sabemos, e "não
   *                     sei" não pode virar "caiu".
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    // ── PAREADO: quem responde é a Verdash, dona da conexão ────────────────
    //
    // O token desta sessão vale para a API da Verdash, não para o servidor de
    // WhatsApp. Mandá-lo ao FZAP — o que o ramo direto abaixo faz — ganha 401,
    // e o 401 vira "conexão caída" numa linha que está saudável. O envio já se
    // desvia assim há tempo (`verdashEnviar`); faltava a saúde.
    if (creds.vinculoId) {
      try {
        const v = await verdashStatusPareado(creds);
        // `reconectando` é o soluço de socket dentro da janela de debounce da
        // Verdash. STARTING e não FAILED pelo mesmo motivo do ramo direto:
        // tratar oscilação como queda faz aviso crítico a cada reconexão.
        if (v.reconectando) {
          return { reachable: true, status: "STARTING", detail: "reconectando_na_verdash" };
        }
        if (v.conectada) return { reachable: true, status: "WORKING", detail: null };
        return { reachable: true, status: "FAILED", detail: "desconectada_na_verdash" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "erro_desconhecido";
        const st = /verdash_request_failed: (\d{3})/.exec(msg)?.[1];
        // 401/403 aqui NÃO é token de instância: é o acesso deste CRM revogado
        // na tela da Verdash. Desfecho igual (FAILED), nome diferente — quem
        // for investigar precisa saber em qual das duas pontas mexer.
        if (st === "401" || st === "403") {
          return { reachable: true, status: "FAILED", detail: "acesso_revogado_na_verdash" };
        }
        // 404 aqui tem DUAS origens e elas pedem coisas opostas. Uma é a
        // Verdash dizendo que a instância sumiu — desfecho conhecido. A outra
        // é o roteador de funções dela respondendo que `crm-status-instancia`
        // não existe, que é o estado de um CRM novo apontando para uma Verdash
        // que ainda não subiu a função. Ler o segundo como "a instância parou"
        // seria inventar um desfecho a partir de uma dependência ausente, e a
        // tela mostraria "parou" numa conexão perfeita.
        //
        // Só o 404 que vem NOMEADO pela Verdash conta como instância sumida.
        if (st === "404") {
          return msg.includes("instancia_nao_encontrada")
            ? { reachable: true, status: "STOPPED", detail: "instancia_nao_existe_mais" }
            : { reachable: false, status: null, detail: "verdash_sem_endpoint_de_status" };
        }
        return { reachable: false, status: null, detail: msg.slice(0, 200) };
      }
    }

    // ── DIRETO: o token é da instância, então pergunta-se ao FZAP ──────────
    let data: { connected?: boolean; loggedIn?: boolean } | undefined;
    try {
      data = await fzapRequest<{ connected?: boolean; loggedIn?: boolean }>(
        creds,
        "/session/status",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      const status = /verdash_request_failed: (\d{3})/.exec(msg)?.[1];
      if (status === "401" || status === "403") {
        return { reachable: true, status: "FAILED", detail: "token_da_instancia_recusado" };
      }
      if (status === "404") {
        return { reachable: true, status: "STOPPED", detail: "instancia_nao_existe_mais" };
      }
      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }

    if (data?.loggedIn === false) {
      // NATIVA: a instancia nasce sem login e espera o QR. `loggedIn:false` com o
      // socket de pe e "aguardando leitura" (SCAN_QR_CODE); sem socket, o FZAP
      // reconecta sozinho (STARTING, que nao avisa). FAILED vale SO para a vinculada,
      // onde deslogar e o numero removido do aparelho.
      // Mas SO enquanto nunca chegou a WORKING: quem ja conectou e perdeu o login
      // precisa ler o QR de novo, e isso e FAILED (aviso), mesmo com o socket caido.
      const nativo = await estadoNativo(admin, input.organizationId, input.sessionRef);
      if (nativo.nativa && !nativo.jaConectou) {
        return data.connected
          ? { reachable: true, status: "SCAN_QR_CODE", detail: "aguardando_leitura_do_qr" }
          : { reachable: true, status: "STARTING", detail: "conectando_no_fzap" };
      }
      return {
        reachable: true,
        status: "FAILED",
        detail: nativo.nativa ? DETALHE_QR_RESCAN_NATIVO : "whatsapp_deslogado_na_verdash",
      };
    }
    if (data?.connected === false) {
      // NATIVA: o socket caido por mais de 10 min seguidos deixa de ser reconexao
      // normal (debounce; o push `Disconnected` grava `desconectado_em`, o vigia
      // grava na primeira observacao se o push se perdeu). Vinculada: como sempre.
      const nativo = await estadoNativo(admin, input.organizationId, input.sessionRef);
      if (nativo.nativa) {
        const caida = msDesconectada(nativo);
        if (caida === null) {
          if (nativo.id) await marcarDesconectada(admin, input.organizationId, nativo.id);
        } else if (caida > LIMITE_DESCONECTADA_MS) {
          return { reachable: true, status: "FAILED", detail: "desconectada_ha_mais_de_10_min" };
        }
      }
      return { reachable: true, status: "STARTING", detail: "reconectando_na_verdash" };
    }
    // Marca a primeira vez que a nativa esteve de pe (melhor esforco, ver estado-nativo.ts).
    await marcarJaConectou(admin, input.organizationId, input.sessionRef);
    // O telefone tenta de novo a cada ciclo enquanto estiver nulo (o jid pode demorar
    // a aparecer). Conflito de numero vira detalhe de saude visivel ao operador.
    const atual = await estadoNativo(admin, input.organizationId, input.sessionRef);
    if (atual.nativa && !atual.telefone) {
      const t = await preencherTelefoneNativo(admin, input.organizationId, input.sessionRef);
      if (t === "conflito") return { reachable: true, status: "WORKING", detail: DETALHE_NUMERO_EM_CONFLITO };
    }
    return { reachable: true, status: "WORKING", detail: null };
  },

  /** Grupos do número, para Conexões › Grupos. Sem credencial = canal não conectado. */
  async listGroups(input: ChannelTenantScope & { sessionRef: string }) {
    const creds = await resolveVerdashCreds(createAdminClient(), {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) throw new Error("verdash_sem_credencial");
    return verdashListarGrupos(creds);
  },

  /**
   * Aqui não há filtro a trocar: o webhook do FZAP já entrega toda mensagem de grupo, e quem
   * escolhe o que entra é `lib/grupos/ingest.ts` (grupo desligado é descartado). O filtro da
   * instância é da Verdash, que também lê grupos; mexer nele quebraria o tracker de lá.
   */
  async setGroupIntake() {
    return true;
  },

  /**
   * Baixa o anexo que o cliente mandou, para persistir os bytes.
   *
   * Sem isto, a mídia recebida vira linha SEM bytes e o atendente vê "imagem"
   * sem imagem — o defeito que o canal intermediado carregou por meses.
   */
  async fetchInboundMedia(
    input: ChannelTenantScope & { sessionRef: string; url: string; hintMime?: string | null },
  ): Promise<FetchedMedia> {
    const admin = createAdminClient();
    const creds = await resolveVerdashCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) throw new Error("verdash_not_configured: sem credencial para baixar a mídia.");

    const { buffer, mime } = await fzapFetchMedia(creds, input.url);
    return {
      buffer,
      mime: mime !== "application/octet-stream" ? mime : (input.hintMime ?? mime),
    };
  },
};
