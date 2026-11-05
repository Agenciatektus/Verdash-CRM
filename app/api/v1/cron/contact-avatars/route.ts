/**
 * contact-avatars — baixa e mantém atualizada a foto de perfil dos contatos.
 *
 * POR QUE UM CRON, E NÃO NA INGESTÃO
 * O webhook de entrada precisa responder rápido: baixar e subir uma imagem no meio
 * dele atrasaria a gravação da mensagem e, num pico, faria o canal reenfileirar.
 * Aqui vale a mesma regra do resto do repo — trabalho pesado sai do caminho
 * quente e vira varredura periódica.
 *
 * POR QUE O ARQUIVO, E NÃO A URL
 * O canal devolve uma URL assinada do CDN do WhatsApp, com `oe=<expiração>` no
 * fim. Medido numa instalação real: 9 dias. Guardar a URL faria todo avatar
 * sumir da tela em pouco mais de uma semana, sem erro nenhum. Então o arquivo
 * vai para o bucket privado `whatsapp-media`, como já se faz com a mídia das
 * mensagens, e a tela pede URL assinada na hora.
 *
 * ORDEM DA VARREDURA: `avatar_updated_at nulls first` — quem nunca teve foto
 * entra antes de quem só está desatualizado. O rosto que falta incomoda mais
 * que o rosto velho.
 *
 * DE QUAL CONEXÃO
 * A foto vem da conexão por onde o contato FALA — e não de qualquer conexão
 * ativa da empresa. Antes, a rota escolhia a primeira `channel_sessions`
 * `WORKING` da organização (sem ordem, sem ligação com o contato). Quando a
 * empresa tem WhatsApp E Instagram/Facebook ligados, o banco às vezes devolvia
 * a linha social (`waha_session_name` nulo, provider `zernio_social`): o `ref`
 * saía nulo, o cron gravava "sem foto" e só revisitava o contato em 7 dias.
 * Medido: 40 de 163 contatos de uma empresa marcados "sem foto", e o WhatsApp
 * devolvia foto para eles quando perguntado direto. Agora, para cada contato, lê
 * a conversa mais recente dele, pega a sessão dessa conversa (só se `WORKING`
 * e não arquivada), resolve o `sessionRef` dessa sessão e pede a foto ao adapter
 * dela. Conversa cuja sessão está parada, arquivada, sem `sessionRef` ou com
 * adapter sem `fetchProfilePictureUrl` → carimba sem foto, sem tentar outra.
 *
 * A regra é: conversa do contato; sem conversa nenhuma, a conexão de mensagem
 * da empresa que sabe buscar foto. O contato SEM conversa é comum (POST
 * /contacts, importação de contatos e de leads, webhook de entrada, importação
 * B2B, a linha de voz) e não tem conversa para indicar a conexão. Para ele, e só
 * para ele, a rota lista as conexões de mensagem `WORKING` da empresa, em ordem
 * de criação, e fica com a primeira que sabe buscar foto. Quem descarta a social
 * é essa checagem de capacidade (`fetchProfilePictureUrl` presente), não o
 * `sessionRef`, que na social existe. O defeito antigo era pegar UMA conexão
 * qualquer, sem ordem e sem perguntar se ela busca foto.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { DEFAULT_CHANNEL_PROVIDER, getAdapterOpcional, type ChannelProvider } from "@/lib/channels";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  baixarFotoDePerfil,
  destinatarioDaFoto,
  filtroDaVarreduraDeFotos,
  providersDaFoto,
} from "@/lib/channels/contact-avatar";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels/session-ref";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Contatos por invocação. Baixar imagem é I/O: cap baixo evita segurar o cron. */
const SCAN_LIMIT = 25;
/** Revisita a foto a cada 7 dias — gente troca de foto, mas não toda hora. */
const REFRESH_AFTER_DAYS = 7;
/**
 * Orçamento da rodada. O scheduler dá 60 s a esta rota; passado este prazo o
 * cron para de PEGAR contato novo. O que já está em curso termina dentro dos
 * prazos próprios (canal: 10 s na plataforma, 15 s no WAHA; download: 10 s), e
 * 25 + 15 + 10 + consultas fica abaixo dos 60.
 */
const PRAZO_DO_LOTE_MS = 25_000;

interface ContactRow {
  id: string;
  organization_id: string;
  wa_identity: string | null;
  instagram_igsid: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  avatar_storage_path: string | null;
}

/**
 * Identidade do contato → o chatId que o adapter espera.
 *
 * MESMA ORDEM de `resolveWahaChatId` (lib/waha/send.ts) e de `chatIdOf`
 * (session-reconciler): `wa_lid` primeiro, `wa_identity` depois, telefone por
 * último. Esta função só lia `wa_identity` — que é GERADA com o telefone antes
 * do lid (migration 0122). Num número BR cujo wa_id não tem o nono dígito, isso
 * produzia `55AA9BBBBCCCC@c.us`, endereço inexistente: o provider devolvia
 * `profilePictureURL: null`, o job carimbava "sem foto" e o avatar nunca vinha.
 * O lid não depende do telefone, por isso vem na frente.
 */
function chatIdDoContato(c: ContactRow): string | null {
  if (c.wa_lid) return `${c.wa_lid}@lid`;
  if (c.wa_identity?.startsWith("lid:")) return `${c.wa_identity.slice(4)}@lid`;
  if (c.wa_identity?.startsWith("phone:")) {
    return `${c.wa_identity.slice(6).replace(/\D/g, "")}@c.us`;
  }
  if (c.phone_number) return `${c.phone_number.replace(/\D/g, "")}@c.us`;
  return null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000).toISOString();

  // Nunca buscados (null) OU buscados há mais de REFRESH_AFTER_DAYS.
  //
  // `is_anonymized` fora é OBRIGATÓRIO, não otimização: sem esse filtro, um
  // contato anonimizado por pedido LGPD voltaria a ser varrido no refresh
  // seguinte e o cron BAIXARIA O ROSTO DELE DE NOVO — reintroduzindo, sozinho e
  // periodicamente, o dado pessoal que acabara de ser apagado. A anonimização é
  // declarada irreversível no produto; esta linha é o que sustenta isso.
  const { data: contatos, error: queryError } = await admin
    .from("contacts")
    .select(
      "id, organization_id, wa_identity, wa_lid, phone_number, instagram_igsid, avatar_storage_path",
    )
    // Contato só de Instagram (IGSID, sem telefone) também tem rosto. Um `or`
    // só, com o AND escrito (ver `filtroDaVarreduraDeFotos`).
    .eq("is_anonymized", false)
    .or(filtroDaVarreduraDeFotos(cutoff))
    .order("avatar_updated_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[contact-avatars] query failed", { detail: queryError.message, requestId });
    return fail("internal_error", queryError.message, 500, { requestId });
  }

  const rows = (contatos ?? []) as ContactRow[];
  let atualizados = 0;
  let semFoto = 0;
  let falhas = 0;
  let adiados = 0;
  const inicio = Date.now();

  for (const [indice, c] of rows.entries()) {
    // Estourou o orçamento: os que sobraram ficam para a próxima rodada, sem
    // carimbo (não foram tentados) e no topo da fila, como devem.
    if (Date.now() - inicio > PRAZO_DO_LOTE_MS) {
      adiados = rows.length - indice;
      break;
    }
    const chatId = chatIdDoContato(c);
    // Carimba mesmo sem conseguir resolver o chatId: sem isso o contato voltaria
    // em TODA rodada do cron, para sempre, batendo no canal à toa.
    //
    // `is_anonymized = false` no UPDATE não repete o filtro do SELECT — fecha uma
    // corrida. Entre a seleção do lote e esta gravação há I/O de rede por contato
    // (canal, download, upload), e a anonimização em escopo de tenant percorre
    // centenas de contatos enquanto isto roda. Se o pedido LGPD alcançar este
    // contato no meio do caminho, sem esta cláusula o cron gravaria o rosto de
    // volta num contato JÁ anonimizado — e o filtro do SELECT nunca mais o
    // escolheria para corrigir. Devolve as linhas afetadas para que quem chamou
    // saiba se a gravação valeu.
    const carimbar = async (path: string | null): Promise<boolean> => {
      const { data: afetadas } = await admin
        .from("contacts")
        .update({
          ...(path !== null ? { avatar_storage_path: path } : {}),
          avatar_updated_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .eq("is_anonymized", false)
        .select("id");
      return (afetadas ?? []).length > 0;
    };

    // Carimba a TENTATIVA antes de qualquer I/O. É o backoff: quem falha, estoura
    // prazo ou é morto pelo scheduler no meio não volta no topo da fila
    // (`nulls first`) em toda rodada prendendo o lote dos outros; tenta de novo
    // na janela de 7 dias. O resultado não decide nada aqui: a guarda da
    // anonimização que importa é a da gravação do caminho, lá embaixo.
    await carimbar(null);

    if (!chatId && !c.instagram_igsid) {
      semFoto++;
      continue;
    }

    try {
      // A sessão POR ONDE ESTE CONTATO CONVERSOU. Pegar "a primeira sessão da
      // organização" pedia a foto ao número errado em quem tem vários números
      // ou WhatsApp + Instagram — e o Instagram nem acha o IGSID de outra conta.
      const { data: conversa } = await admin
        .from("conversations")
        .select("channel_session_id")
        .eq("organization_id", c.organization_id)
        .eq("contact_id", c.id)
        .not("channel_session_id", "is", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const sessaoDaConversa = (conversa as { channel_session_id?: string | null } | null)
        ?.channel_session_id;

      const consultaSessao = () => {
        const q = admin
          .from("channel_sessions")
          .select(CHANNEL_SESSION_REF_COLUMNS)
          .eq("organization_id", c.organization_id)
          .eq("status", "WORKING")
          // Só canais que acham ESTE contato (IGSID → Instagram; wa_identity →
          // WhatsApp). Também mantém fora a linha de chamada de voz (spec 18),
          // que nasce `WORKING` ao parear e não tem referência de mensagem.
          .in("provider", providersDaFoto(c));
        // Contato sem conversa (importado, por exemplo) cai na sessão compatível
        // mais recente da MESMA organização — o recorte de tenant vem do `eq`
        // acima, e a ordem torna a escolha determinística.
        return sessaoDaConversa
          ? q.eq("id", sessaoDaConversa)
          : q.order("created_at", { ascending: false }).order("id", { ascending: true });
      };
      // Sessão arquivada não é canal: o mesmo recorte de `resolveVerdashCreds`.
      const { data: sessao } = await queryTolerantToMissingArchived(
        () => consultaSessao().is(ARCHIVED_AT, null).limit(1).maybeSingle(),
        () => consultaSessao().limit(1).maybeSingle(),
      );
      const linhaSessao = sessao as unknown as ChannelSessionRef | null;
      const ref = linhaSessao ? resolveSessionRef(linhaSessao) : null;
      if (!ref) {
        semFoto++;
        continue;
      }

      // Pelo adapter, nunca falando com o canal direto: a doutrina
      // `restricao-de-canal` proíbe nomear provider fora de lib/channels/, e o
      // `pnpm lint:channels` reprova o build se acontecer (foi o que pegou a
      // primeira versão desta rota). Testar a PRESENÇA do método é como se
      // pergunta "este canal sabe fazer isso?" sem perguntar qual canal é.
      // Opcional: canal conhecido sem adapter local é categoria, não falha — sai pelo
      // mesmo caminho de quem não sabe buscar foto. Provider fora da matriz continua
      // lançando, que é o barulho que se quer.
      const provider =
        (linhaSessao?.provider as ChannelProvider | undefined) ?? DEFAULT_CHANNEL_PROVIDER;
      const adapter = getAdapterOpcional(provider);
      if (!adapter?.fetchProfilePictureUrl) {
        semFoto++;
        continue;
      }
      const recipient = destinatarioDaFoto(provider, c, chatId);
      if (!recipient) {
        semFoto++;
        continue;
      }
      const profilePictureURL = await adapter.fetchProfilePictureUrl({
        organizationId: c.organization_id,
        sessionRef: ref,
        recipient,
      });
      if (!profilePictureURL) {
        // Contato sem foto ou com privacidade fechada: estado normal, não erro.
        semFoto++;
        continue;
      }

      // Cercado: allowlist de host, IP conferido, redirecionamento à mão, prazo,
      // teto durante a leitura e `image/*` (ver `baixarFotoDePerfil`). Recusa
      // lança e cai no `catch`, contada como falha.
      const { buffer: buf, mime } = await baixarFotoDePerfil(profilePictureURL);
      if (buf.byteLength === 0) {
        falhas++;
        continue;
      }

      // Caminho estável por contato: `upsert` sobrescreve a foto antiga em vez
      // de acumular um arquivo órfão por refresh (7 dias × N contatos viraria
      // lixo pago no bucket).
      const path = `${c.organization_id}/avatars/${c.id}.jpg`;
      const { error: upErr } = await admin.storage
        .from("whatsapp-media")
        .upload(path, buf, { contentType: mime, upsert: true });
      if (upErr) {
        falhas++;
        continue;
      }

      const gravou = await carimbar(path);
      if (!gravou) {
        // O contato foi anonimizado enquanto baixávamos a foto dele. O arquivo
        // já subiu, então bloquear a gravação não basta: sem isto o objeto ficaria
        // no bucket sem ponteiro nenhum — pior que o defeito original, porque
        // invisível. Devolvemos à fila de redação, o mesmo caminho que a cascata
        // usa, e o worker de limpeza remove.
        await admin.from("storage_redaction_queue").upsert(
          {
            organization_id: c.organization_id,
            bucket: "whatsapp-media",
            object_path: path,
            status: "pending",
            attempts: 0,
            processed_at: null,
            error_message: null,
          },
          { onConflict: "bucket,object_path" },
        );
        logger.warn("[contact-avatars] anonimizado durante a busca; foto devolvida à fila", {
          contact_id: c.id,
          organization_id: c.organization_id,
          requestId,
        });
        semFoto++;
        continue;
      }
      atualizados++;
    } catch (err) {
      // A tentativa já foi carimbada no começo (backoff); aqui só se conta.
      falhas++;
      logger.warn("[contact-avatars] contato falhou", {
        contact_id: c.id,
        detail: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok(
    {
      scanned: rows.length,
      updated: atualizados,
      no_picture: semFoto,
      failed: falhas,
      deferred: adiados,
    },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
