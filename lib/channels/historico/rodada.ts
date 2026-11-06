/**
 * Uma RODADA da importação do histórico do WhatsApp (#999).
 *
 * Lê o acervo do servidor do canal e grava contato, conversa e mensagens do
 * passado SEM nenhum efeito de mensagem nova: não chama o roteador do webhook,
 * nem os efeitos pós-entrada (IA, demanda, campanha, follow-up), nem o carimbo
 * da conversa (`last_message_*`, não lidas), nem `emit_event`. A única data que
 * a conversa recebe é a de nascimento: a conversa CRIADA pela importação nasce
 * com `last_message_at` da lista do canal (ver `garantirContatoEConversa`). O que os
 * gatilhos de `messages` fariam, a 0760 corta pela chave
 * `metadata.historico_importado = 'true'` que o mapeador põe em toda linha.
 * Mídia (só imagem e áudio): logo depois de gravar cada página, `resolverMidias`
 * pede ao canal a URL; com URL, grava `media_url` e emite `media.persist_requested`
 * (o worker guarda no storage e, por causa da chave do histórico, NÃO deriva);
 * sem URL (`erro: true`), marca `indisponivel` e não tenta de novo. Sem URL e
 * sem erro, ou tempo esgotado no download, conta `tentativas_midia` e vira
 * `indisponivel` na 3ª; até lá a página não se firma e é refeita. Vídeo,
 * documento e figurinha ficam `fora_do_escopo`, sem chamada. Se o teto de
 * chamadas ou o prazo acabar no meio das mídias da página, a rodada para ANTES
 * de firmar o cursor dela: a página é refeita, as mensagens que esta importação
 * já gravou não são inseridas nem contadas de novo, e só as mídias ainda
 * `pendente` são tentadas.
 * Auditoria é de quem chama (as rotas).
 *
 * ─── Rodadas curtas que retomam ─────────────────────────────────────────────
 *
 * Cada rodada faz no máximo `teto.conversas` conversas OU `teto.mensagens`
 * mensagens OU `teto.chamadas` chamadas ao canal (o que vier primeiro), e só
 * começa uma chamada ao canal (página ou download) com tempo para ela antes de
 * `opcoes.prazo` (ver `prazo.ts`); sem tempo, para como no teto. Grava
 * o cursor
 * `{ indiceConversa, offsetMensagens, desde }`:
 *   - `indiceConversa` é a POSIÇÃO da conversa na lista do canal (ordenada por
 *     id; ver `paginaDeConversas`), contando grupo e status, que ficam de fora;
 *   - `offsetMensagens` é o offset do canal dentro dessa conversa (ordem do
 *     mais antigo para o mais novo, garantida pelo cliente);
 *   - `desde` (epoch em segundos) é fixado na PRIMEIRA rodada: recalcular a
 *     cada rodada faria a janela deslizar e o offset apontar para outro lugar.
 *
 * O offset avança por `lidas`, o que o canal DEVOLVEU antes do schema local
 * (`paginaDeMensagens`): avançar pelo pedido pularia mensagens quando o canal
 * devolve menos, e avançar pelo que sobrou do schema repetiria. A conversa só
 * termina com `lidas === 0`: página inteira recusada pelo schema não é fim.
 *
 * Refazer um pedaço (rodada interrompida antes de gravar o cursor) é seguro: a
 * mensagem já gravada é reconhecida pelo `external_id` e não é inserida de novo.
 *
 * ─── Conferir a conversa inteira antes de gravar ────────────────────────────
 *
 * Cada conversa é lida DUAS vezes. A primeira passada (`conferida` falso no
 * cursor) só pergunta pela trava de apagamento a pedido, página a página, e
 * não grava nada; a segunda grava. Se a identidade marcada só aparece na 3ª
 * página, nada da conversa entrou: desfazer depois (apagar linhas, correr
 * atrás da mídia que o worker já guardou) seria código destrutivo para um
 * caso que a ordem resolve. O preço é o dobro de páginas pedidas ao canal,
 * que só alonga a importação em rodadas. A passada de gravação segue
 * perguntando, para a marca criada entre as duas passadas.
 *
 * ─── O que cada contador conta ──────────────────────────────────────────────
 *
 * `mensagens_gravadas` conta no insert e nunca recua: a linha existe. A linha
 * leva `metadata.importacao_id`, e a página refeita reconhece por ela o que ESTA
 * importação já gravou: isso não é "existente" nem gravada de novo, não conta.
 * `mensagens_existentes` é só o que já estava no CRM por outro caminho (o ao
 * vivo, outra importação); ele e `mensagens_ignoradas` voltam ao valor do início
 * da página quando a página é largada para ser refeita, senão a refeita os
 * contaria de novo (medido na prova de 21/10: 77 "existentes" para ~72 ao vivo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getWahaClient } from "@/lib/waha/client";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { criarFonteIzzy } from "@/lib/channels/historico/fonte-izzy";
import { ehReacao, parseChatId, type WahaPayload } from "@/lib/waha/ingest";
import { MARGEM_PARA_CHAMADA_MS } from "@/lib/channels/historico/prazo";
import { FonteAdiada, mensagemDeErro, type FonteDeHistorico, type Importacao } from "@/lib/channels/historico/comum";
import { garantirContatoEConversa, gravarMensagens } from "@/lib/channels/historico/rodada-gravar";
import { resolverMidias } from "@/lib/channels/historico/rodada-midia";
import { titularApagadoNaPagina } from "@/lib/channels/historico/rodada-titular";

export interface TetoDaRodada {
  conversas: number;
  mensagens: number;
  /**
   * Chamadas ao canal por rodada (páginas de conversas + páginas de mensagens).
   * Sem ele, uma conta com centenas de conversas antigas ou de grupos faria a
   * rodada andar a lista inteira, já que essas não contam como conversa feita.
   */
  chamadas?: number;
}

/** 3 conversas OU 300 mensagens OU 20 chamadas ao canal por rodada, o que vier primeiro. */
export const TETO_PADRAO: Required<TetoDaRodada> = { conversas: 3, mensagens: 300, chamadas: 20 };

export interface CursorDaImportacao {
  indiceConversa: number;
  offsetMensagens: number;
  /** Epoch em segundos; fixado na primeira rodada. */
  desde?: number;
  /**
   * A conversa de `indiceConversa` já passou inteira pela trava de apagamento
   * a pedido: `offsetMensagens` é da passada de gravação. Falso (ou ausente):
   * é da passada de conferência, que não grava.
   */
  conferida?: boolean;
}

export interface OpcoesDaRodada {
  /**
   * Epoch em ms. A rodada não começa chamada ao canal sem `MARGEM_PARA_CHAMADA_MS`
   * pela frente: para com o cursor firme e a próxima segue. Sem ele, sem prazo.
   */
  prazo?: number;
  /** Relógio (epoch em ms); os testes passam um de mentira. */
  relogio?: () => number;
}

export type StatusDaImportacao = "previa" | "rodando" | "concluida" | "erro" | "cancelada";

export interface ResultadoDaRodada {
  /**
   * `rodando`/`concluida`/`erro` vêm desta rodada. Outro valor (`cancelada`,
   * por exemplo) é o que a linha tinha quando a rodada foi gravar e encontrou
   * a importação fora de `rodando`: a rodada não sobrescreve.
   */
  status: StatusDaImportacao;
  gravadas: number;
  existentes: number;
}

/** Página de mensagens pedida ao canal; menor quando o teto está perto. */
const PAGINA_DE_MENSAGENS = 100;
/** Página de conversas: processada inteira em memória (grupo, status e conversa
 * antiga são pulados sem nova chamada). */
const PAGINA_DE_CONVERSAS = 50;
const SEGUNDOS_POR_DIA = 86_400;

/** A fonte da importação: o canal WAHA da conexão, ou o Izzy com o token guardado cifrado na linha. */
async function abrirFonte(
  admin: SupabaseClient,
  imp: Importacao,
): Promise<{ canal: FonteDeHistorico; nomeNoCanal: string }> {
  if (imp.fonte === "izzy") {
    const token = imp.credencial_cifrada ? await decryptWebhookSecret(admin, imp.credencial_cifrada) : null;
    if (!token) throw new Error("credencial_ausente");
    return { canal: criarFonteIzzy(token), nomeNoCanal: "izzy" };
  }
  const canal = getWahaClient();
  if (!canal) throw new Error("canal_nao_configurado");
  const { data: sessao, error: erroDaSessao } = await admin
    .from("channel_sessions")
    .select("waha_session_name")
    .eq("id", imp.channel_session_id)
    .eq("organization_id", imp.organization_id)
    .maybeSingle();
  if (erroDaSessao) throw new Error(`sessao_leitura: ${mensagemDeErro(erroDaSessao)}`);
  const nomeNoCanal = (sessao as { waha_session_name?: string } | null)?.waha_session_name;
  if (!nomeNoCanal) throw new Error("sessao_nao_encontrada");
  return { canal, nomeNoCanal };
}

export async function rodarUmaRodada(
  admin: SupabaseClient,
  importacaoId: string,
  teto: TetoDaRodada = TETO_PADRAO,
  opcoes: OpcoesDaRodada = {},
): Promise<ResultadoDaRodada> {
  const { data: lida, error: erroDeLeitura } = await admin
    .from("importacoes_de_historico")
    .select("*")
    .eq("id", importacaoId)
    .maybeSingle();
  if (erroDeLeitura) throw new Error(`importacao_leitura: ${mensagemDeErro(erroDeLeitura)}`);
  const imp = lida as Importacao | null;
  if (!imp) throw new Error("importacao_nao_encontrada");
  if (imp.status === "concluida") return { status: "concluida", gravadas: 0, existentes: 0 };
  if (imp.status !== "rodando") throw new Error("importacao_nao_esta_rodando");

  const cursorSalvo = imp.cursor ?? {};
  const cursor: Required<CursorDaImportacao> = {
    indiceConversa: cursorSalvo.indiceConversa ?? 0,
    offsetMensagens: cursorSalvo.offsetMensagens ?? 0,
    desde: cursorSalvo.desde ?? Math.floor(Date.now() / 1000) - imp.dias * SEGUNDOS_POR_DIA,
    conferida: cursorSalvo.conferida ?? false,
  };
  const irParaConversa = (posicao: number) => {
    cursor.indiceConversa = posicao;
    cursor.offsetMensagens = 0;
    cursor.conferida = false;
  };
  const desta = { conversas: 0, gravadas: 0, existentes: 0, ignoradas: 0 };
  // Fora de `desta` de propósito: mídia resolvida não volta a `pendente` quando a
  // rodada recua o cursor, então o contador não pode recuar junto.
  const midias = { baixadas: 0, indisponiveis: 0 };

  /**
   * Grava SÓ se a importação ainda está `rodando`: um cancelamento feito
   * durante a rodada não vira `concluida`. NÃO serializa duas execuções
   * simultâneas da mesma importação (as duas veem `rodando`); isso é de quem
   * dispara a rodada. O índice único parcial da 0761 só impede duas
   * importações `rodando` no mesmo número.
   * Devolve `null` quando gravou, ou o status que a linha tem quando não gravou.
   */
  const salvar = async (extra: Record<string, unknown>): Promise<StatusDaImportacao | null> => {
    const { data, error } = await admin
      .from("importacoes_de_historico")
      .update({
        cursor,
        conversas_feitas: (imp.conversas_feitas ?? 0) + desta.conversas,
        mensagens_gravadas: (imp.mensagens_gravadas ?? 0) + desta.gravadas,
        mensagens_existentes: (imp.mensagens_existentes ?? 0) + desta.existentes,
        mensagens_ignoradas: (imp.mensagens_ignoradas ?? 0) + desta.ignoradas,
        midias_baixadas: (imp.midias_baixadas ?? 0) + midias.baixadas,
        midias_indisponiveis: (imp.midias_indisponiveis ?? 0) + midias.indisponiveis,
        updated_at: new Date().toISOString(),
        ...extra,
        // O token do Izzy não sobrevive ao fim da importação.
        ...(extra.status === "concluida" || extra.status === "erro" ? { credencial_cifrada: null } : {}),
      } as never)
      .eq("id", importacaoId)
      .eq("status", "rodando")
      .select("id");
    if (error) throw new Error(`importacao_gravacao: ${mensagemDeErro(error)}`);
    if ((data ?? []).length > 0) return null;
    const { data: atual, error: erroDoAtual } = await admin
      .from("importacoes_de_historico")
      .select("*")
      .eq("id", importacaoId)
      .maybeSingle();
    if (erroDoAtual) throw new Error(`importacao_leitura: ${mensagemDeErro(erroDoAtual)}`);
    return (atual as { status?: StatusDaImportacao } | null)?.status ?? "cancelada";
  };

  const encerrar = async (
    status: "rodando" | "concluida" | "erro",
    extra: Record<string, unknown> = {},
  ): Promise<ResultadoDaRodada> => {
    const outro = await salvar(status === "rodando" ? extra : { status, ...extra });
    return { status: outro ?? status, gravadas: desta.gravadas, existentes: desta.existentes };
  };

  // O cursor que vale ao parar por erro é o do último ponto inteiro: o pedaço em
  // andamento é refeito na próxima (a deduplicação absorve a repetição).
  let cursorFirme = { ...cursor };
  let firmes = { ...desta };
  const firmar = () => {
    cursorFirme = { ...cursor };
    firmes = { ...desta };
  };

  const tetoDeChamadas = teto.chamadas ?? TETO_PADRAO.chamadas;
  let chamadas = 0;
  let processadas = 0;
  const relogio = opcoes.relogio ?? Date.now;
  const semTempo = () => opcoes.prazo !== undefined && opcoes.prazo - relogio() < MARGEM_PARA_CHAMADA_MS;
  // O teto e o prazo valem antes de TODA chamada ao canal (página ou download).
  const noTeto = () =>
    desta.conversas >= teto.conversas ||
    processadas >= teto.mensagens ||
    chamadas >= tetoDeChamadas ||
    semTempo();

  try {
    const { canal, nomeNoCanal } = await abrirFonte(admin, imp);

    for (;;) {
      if (noTeto()) return await encerrar("rodando");

      const offsetDaPagina = cursor.indiceConversa;
      chamadas += 1;
      const pagina = await canal.paginaDeConversas(nomeNoCanal, {
        limit: PAGINA_DE_CONVERSAS,
        offset: offsetDaPagina,
      });
      if (pagina.lidas === 0) return await encerrar("concluida", { erro: null });

      for (const conversa of pagina.conversas) {
        if (conversa.posicao < cursor.indiceConversa) continue;
        if (conversa.posicao > cursor.indiceConversa) irParaConversa(conversa.posicao);

        // Conversa sem nada dentro da janela: o canal já diz pela última
        // mensagem, e a página já está em memória (sem nova chamada).
        if (conversa.ultimaEm !== null && conversa.ultimaEm < cursor.desde) {
          irParaConversa(cursor.indiceConversa + 1);
          firmar();
          continue;
        }

        let alvo: { contactId: string; conversationId: string } | null = null;
        // Identidades desta conversa já conferidas na trava de apagamento (por rodada).
        const conferidas = new Set<string>();
        // Chat @lid: o telefone pode não vir em mensagem nenhuma do acervo, e quem
        // foi apagado só com telefone voltaria pelo lid. O canal resolve, uma vez.
        // `null` é "o canal ainda não sabe" (a tabela do lid enche com o uso) e
        // segue só com o lid: barrar isso deixaria de fora quase todo chat @lid
        // antigo. Falha de transporte LANÇA e para a rodada, como a pergunta da
        // marca: conferir só o lid porque a rede caiu não é conferir.
        let telefoneDoChat: string | null | undefined;
        for (;;) {
          if (noTeto()) return await encerrar("rodando");
          if (telefoneDoChat === undefined) {
            const lidDoChat = parseChatId(conversa.chatId).lid;
            telefoneDoChat = null;
            if (lidDoChat) {
              chamadas += 1;
              telefoneDoChat = await canal.resolvePhoneForLid(nomeNoCanal, lidDoChat, { falhaLanca: true });
              continue;
            }
          }
          const limite = Math.min(PAGINA_DE_MENSAGENS, teto.mensagens - processadas);
          chamadas += 1;
          const { mensagens, lidas } = await canal.paginaDeMensagens(nomeNoCanal, conversa.chatId, {
            limit: limite,
            offset: cursor.offsetMensagens,
            desde: cursor.desde,
          });
          // Só `lidas === 0` é fim: página inteira recusada pelo schema não é.
          if (lidas === 0) {
            if (cursor.conferida || cursor.offsetMensagens === 0) break;
            // Conferida inteira e sem marca: a passada de gravação começa do zero.
            cursor.conferida = true;
            cursor.offsetMensagens = 0;
            firmar();
            continue;
          }

          if (!cursor.conferida) {
            const aConferir = mensagens.filter((p) => p.id && !ehReacao(p));
            if (aConferir.length > 0 && (await titularApagadoNaPagina(admin, imp, conversa.chatId, telefoneDoChat, aConferir, conferidas))) {
              // Apagado a pedido: nada da conversa foi gravado; tudo o que se leu dela fica de fora.
              desta.ignoradas += cursor.offsetMensagens + lidas;
              break;
            }
            processadas += lidas;
            cursor.offsetMensagens += lidas;
            firmar();
            continue;
          }

          // O que o schema recusou também foi lido e não vira linha. Os dois
          // contadores voltam a este ponto se a página for largada para ser refeita.
          const ignoradasAntes = desta.ignoradas;
          const existentesAntes = desta.existentes;
          desta.ignoradas += lidas - mensagens.length;
          const validas: WahaPayload[] = [];
          for (const p of mensagens) {
            if (!p.id || ehReacao(p)) desta.ignoradas += 1;
            else validas.push(p);
          }
          if (validas.length > 0 && (await titularApagadoNaPagina(admin, imp, conversa.chatId, telefoneDoChat, validas, conferidas))) {
            // Marca criada depois da passada de conferência: daqui em diante, nada.
            desta.ignoradas += validas.length;
            break;
          }
          if (validas.length > 0) {
            alvo ??= await garantirContatoEConversa(admin, imp, conversa.chatId, conversa.ultimaEm, validas);
            if (!alvo) {
              // Chat que não é endereçável (nem telefone nem @lid): nada a gravar nele.
              desta.ignoradas += validas.length;
            } else {
              // Soma direto em `desta`: um erro no meio do linha a linha não perde
              // do contador as linhas que já entraram.
              await gravarMensagens(admin, imp, alvo, validas, desta);
              const completa = await resolverMidias(admin, imp, canal, nomeNoCanal, conversa.chatId, alvo.conversationId, validas, {
                noTeto,
                contarChamada: () => {
                  chamadas += 1;
                },
                midias,
              });
              if (!completa) {
                // Teto (ou prazo) no meio das mídias: a página inteira é refeita
                // na próxima rodada, então o cursor fica no último ponto firme.
                Object.assign(cursor, cursorFirme);
                desta.ignoradas = ignoradasAntes;
                desta.existentes = existentesAntes;
                return await encerrar("rodando");
              }
            }
          }
          processadas += lidas;
          // Avança pelo que o canal DEVOLVEU, não pelo que foi pedido.
          cursor.offsetMensagens += lidas;
          firmar();
        }

        desta.conversas += 1;
        irParaConversa(cursor.indiceConversa + 1);
        firmar();
        if (noTeto()) return await encerrar("rodando");
      }

      // Página esgotada: o que sobrou depois da última conversa 1:1 era grupo ou status.
      if (offsetDaPagina + pagina.lidas > cursor.indiceConversa) irParaConversa(offsetDaPagina + pagina.lidas);
      firmar();
    }
  } catch (err) {
    Object.assign(cursor, cursorFirme);
    // Fonte pediu espera (limite de chamadas, servidor sob carga): não é erro, a próxima rodada retoma.
    if (err instanceof FonteAdiada) {
      Object.assign(desta, { ...firmes, gravadas: desta.gravadas });
      return await encerrar("rodando");
    }
    // `gravadas` fica: o insert aconteceu, e a refeita não o conta de novo.
    Object.assign(desta, { ...firmes, gravadas: desta.gravadas });
    return await encerrar("erro", { erro: mensagemDeErro(err).slice(0, 500) });
  }
}

