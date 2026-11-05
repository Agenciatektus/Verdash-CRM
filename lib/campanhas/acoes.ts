/**
 * As AÇÕES da campanha — preparar, iniciar, agendar, pausar, retomar, cancelar,
 * duplicar e testar.
 *
 * Moram aqui, e não em oito rotas, porque as oito fazem a mesma coisa em volta:
 * carregar a campanha da organização certa, perguntar à máquina de estados se a
 * transição vale, escrever, auditar. Espalhado, esse "em volta" diverge — e o
 * dia em que uma rota esquecer de conferir o estado é o dia em que uma campanha
 * cancelada volta a enviar.
 *
 * Cada função devolve `{ ok: false, codigo, mensagem, status }` em vez de lançar:
 * a rota traduz para `fail()` sem interpretar exceção, e o motivo chega ao
 * operador com o texto real (Regra nº 1).
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiErrorCode } from "@/lib/api/errors";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { logger } from "@/lib/logger";

import { baloesDaCampanha, enviarEmBaloes, pausaEntreBaloes } from "./baloes";
import { baseLegalValida, motivoParaExcluir, recusouMarketing } from "./elegibilidade";
import { ehEntradaContinua, problemaNaEntradaContinua } from "./entrada-continua";
import { ehStatusDaCampanha, podeTransitar } from "./maquina-de-estados";
import { passosGuardados, problemaNosPassos } from "./passos";
import { ehObjetoDeSaidas, problemaNasSaidas } from "./saidas-da-campanha";
import { prepararCampanha, resumoDaEtapaDeEntrada } from "./preparacao";
import { encerrarReguaDaCampanha, publicarReguaDaCampanha } from "./regua";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { camposDoDestinatario } from "./consulta-de-audiencia";
import { codigoDaPlataforma, fraseDaFalha } from "@/lib/channels/erro-da-plataforma";
import {
  camposDoNegocioUsados,
  type ConteudoDoEnvio,
  resolverValoresDaCampanha,
  textoDoModeloParaAConversa,
  variaveisDaCampanhaSchema,
} from "./modelo";
import { conferirModeloDaCampanha } from "./modelo-da-conexao";
import type { ModeloPreparado } from "./preparacao";
import { renderizarVariacao, spintaxDasVariantes, variantesDaCampanha } from "./renderizador";
import type { ModoDaMensagem, StatusDaCampanha, VelocidadeDaCampanha } from "./tipos";

export interface CampanhaCarregada {
  id: string;
  organization_id: string;
  name: string;
  status: StatusDaCampanha;
  channel_session_id: string;
  message_body: string | null;
  /** As variações EXTRAS (migration 9034). Vazio = campanha de um texto só. */
  message_variants: string[] | null;
  base_legal: string;
  lia_ref: string | null;
  /** Onde o card de quem responde nasce (0378) — e, com passos, o funil da régua (9037). */
  pipeline_id: string | null;
  /** A régua do 2º toque em diante (9037). Vazia = campanha de uma mensagem só. */
  passos: unknown;
  /**
   * Quando a régua para de falar com cada pessoa (9046). `null` = o operador
   * nunca abriu a seção, e vale o padrão de sempre. CRU, como `passos`: quem o
   * lê é `lerSaidasDaCampanha`, que RECUSA o ilegível em vez de devolver padrão.
   */
  saidas: unknown;
  /** O pointer de follow-up publicado para esta campanha (9037). */
  followup_pointer_id: string | null;
  /**
   * O modo de público (migration 9039). `false` = LISTA (o snapshot congelado,
   * default e comportamento de toda campanha anterior a ela); `true` =
   * CONTÍNUO, e quem entra em `entrada_etapa_id` é abordado. Racional em
   * `lib/campanhas/entrada-continua.ts`.
   */
  entrada_continua: boolean;
  entrada_etapa_id: string | null;
  audience_filter: unknown;
  audience_version: number;
  content_version: number;
  scheduled_at: string | null;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
  description: string | null;
  /** Migration 0710: `template` = modelo aprovado pelo número oficial. */
  message_mode: ModoDaMensagem;
  provider_template_name: string | null;
  provider_template_language: string | null;
  provider_template_variables: unknown;
  /** Migration 0711: `rapida` = rajada na rodada (só com modelo). */
  velocidade: VelocidadeDaCampanha;
  /** Migration 0765: texto sai em balões, um por parágrafo. */
  split_messages: boolean;
}

export type Recusa = { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };
export type Desfecho<T = unknown> = ({ ok: true } & T) | Recusa;

const COLUNAS =
  "id, organization_id, name, status, channel_session_id, message_body, message_variants, " +
  "base_legal, lia_ref, pipeline_id, passos, saidas, followup_pointer_id, " +
  "entrada_continua, entrada_etapa_id, " +
  "audience_filter, audience_version, content_version, scheduled_at, description, " +
  "intervalo_segundos, janela_inicio_hora, janela_fim_hora, teto_diario, teto_horario, " +
  "message_mode, provider_template_name, provider_template_language, provider_template_variables, velocidade, split_messages";

export async function carregarCampanha(
  admin: SupabaseClient,
  organizationId: string,
  campanhaId: string,
): Promise<Desfecho<{ campanha: CampanhaCarregada }>> {
  const { data } = await admin
    .from("campaigns")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("id", campanhaId)
    .maybeSingle();
  if (!data) {
    return {
      ok: false,
      codigo: "campanha_nao_encontrada",
      mensagem: "Campanha não encontrada.",
      status: 404,
    };
  }
  const campanha = data as unknown as CampanhaCarregada;
  if (!ehStatusDaCampanha(campanha.status)) {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: `A campanha está num estado que este sistema não conhece ("${campanha.status}").`,
      status: 409,
    };
  }
  return { ok: true, campanha };
}

function recusaDeTransicao(de: StatusDaCampanha, para: StatusDaCampanha): Recusa | null {
  const r = podeTransitar(de, para);
  return r.pode ? null : { ok: false, codigo: "campanha_estado_invalido", mensagem: r.motivo, status: 409 };
}

/** O que toda campanha precisa ter antes de qualquer envio — inclusive o de teste. */
function faltaParaEnviar(c: CampanhaCarregada): Recusa | null {
  if (c.message_mode === "template") {
    if ((c.provider_template_name ?? "").trim() === "" || (c.provider_template_language ?? "").trim() === "") {
      return {
        ok: false,
        codigo: "campanha_conteudo_invalido",
        mensagem: "Escolha o modelo aprovado antes de preparar a campanha.",
        status: 422,
      };
    }
  } else if ((c.message_body ?? "").trim() === "") {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: "Escreva a mensagem antes de preparar a campanha.",
      status: 422,
    };
  }
  // O {a|b} é conferido AQUI, antes de qualquer transição de estado: deixar
  // para a preparação faria a campanha entrar em `preparing`, voltar para
  // rascunho e devolver o erro — três escritas para dizer o que se sabia antes
  // da primeira. E o teste de envio passa pelo mesmo motor, então ele também
  // precisa do texto resolvível.
  const quebradas = spintaxDasVariantes(variantesDaCampanha(c.message_body, c.message_variants));
  if (quebradas.length > 0) {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem:
        `Variação ${quebradas.map((i) => i + 1).join(", ")}: o {a|b} não fecha. ` +
        "Confira as chaves antes de enviar.",
      status: 422,
    };
  }
  // OS PASSOS, no MESMO gate do texto e da base legal. Deixar a conferência
  // para a publicação da régua faria a campanha entrar em `preparing`, gravar a
  // lista de destinatários inteira e só então descobrir que falta o funil — três
  // escritas para dizer o que se sabia antes da primeira.
  const dosPassos = problemaNosPassos(passosGuardados(c.passos), { pipelineId: c.pipeline_id });
  if (dosPassos) {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: dosPassos, status: 422 };
  }
  // AS SAÍDAS (9046), no MESMO gate, e por isso valendo para preparar, iniciar,
  // agendar e testar de uma vez. Campanha que nunca abriu a seção (`saidas` nula,
  // que é toda campanha anterior à 9046) sai daqui com `null`: nada muda para
  // ela. Quem é barrado é a campanha cujo jsonb não dá para ler — e barrar é o
  // lado certo de errar, porque a alternativa é publicar a régua com o padrão no
  // lugar da escolha do operador e insistir com quem ele mandou parar.
  const dasSaidas = problemaNasSaidas(c.saidas);
  if (dasSaidas) {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: dasSaidas, status: 422 };
  }
  // A ENTRADA CONTÍNUA (9039), no MESMO gate — e por isso ela vale para
  // preparar, iniciar, agendar e testar de uma vez. Campanha em modo lista sai
  // daqui sem mudança nenhuma: `problemaNaEntradaContinua` devolve `null` na
  // primeira linha quando a flag está desligada.
  //
  // Aqui é também onde a campanha contínua que PERDEU a etapa (alguém a apagou,
  // e a FK da 9039 anulou a referência) é barrada: ela já havia parado de
  // abordar — o gatilho não casa etapa nula — e a próxima ação diz por quê.
  const daEntrada = problemaNaEntradaContinua(c);
  if (daEntrada) {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: daEntrada, status: 422 };
  }
  if (!baseLegalValida({ baseLegal: c.base_legal, liaRef: c.lia_ref })) {
    return {
      ok: false,
      codigo: "campanha_base_legal_invalida",
      mensagem:
        "Interesse legítimo exige a referência da avaliação (LIA). Sem ela não há como responder " +
        "a quem perguntar com base em quê recebeu a mensagem.",
      status: 422,
    };
  }
  return null;
}

/**
 * O modelo da campanha oficial, conferido AGORA — entre salvar e preparar a
 * plataforma pode ter pausado o modelo, ou alguém pode ter apagado a definição.
 * A mesma conferência de salvar (`conferirModeloDaCampanha`). Campanha de texto
 * devolve `{ ok: true }` sem modelo.
 */
export async function modeloDaCampanha(
  admin: SupabaseClient,
  c: CampanhaCarregada,
): Promise<Desfecho<{ modelo?: ModeloPreparado }>> {
  if (c.message_mode !== "template") return { ok: true };
  const variaveis = variaveisDaCampanhaSchema.safeParse(c.provider_template_variables ?? {});
  if (!variaveis.success) {
    return {
      ok: false,
      codigo: "campanha_modelo_variaveis",
      mensagem: "O mapa de variáveis do modelo está ilegível. Escolha as origens de novo.",
      status: 422,
    };
  }
  const conferencia = await conferirModeloDaCampanha(
    admin,
    {
      organizationId: c.organization_id,
      channelSessionId: c.channel_session_id,
      name: c.provider_template_name ?? "",
      language: c.provider_template_language ?? "",
    },
    variaveis.data,
  );
  if (!conferencia.ok) {
    return { ok: false, codigo: conferencia.codigo, mensagem: conferencia.mensagem, status: 422 };
  }
  return {
    ok: true,
    modelo: { definicao: conferencia.definicao, contrato: conferencia.contrato, variaveis: variaveis.data },
  };
}

/** Já saiu alguma mensagem desta campanha? Reconstruir snapshot depois disso é proibido. */
async function jaEnviou(admin: SupabaseClient, campanhaId: string): Promise<boolean> {
  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .not("sent_at", "is", null);
  return (count ?? 0) > 0;
}

export async function prepararAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
  autorId: string,
): Promise<Desfecho<{ resumo: { total: number; elegiveis: number; excluidos: number } }>> {
  const recusa = recusaDeTransicao(c.status, "preparing") ?? faltaParaEnviar(c);
  if (recusa) return recusa;
  const doModelo = await modeloDaCampanha(admin, c);
  if (!doModelo.ok) return doModelo;
  if (await jaEnviou(admin, c.id)) {
    return {
      ok: false,
      codigo: "campanha_nao_editavel",
      mensagem: "Esta campanha já enviou mensagens; refazer a lista mudaria o que já foi dito.",
      status: 409,
    };
  }

  // A RÉGUA VAI AO AR ANTES DA LISTA, e isso é deliberado: a inscrição acontece
  // quando a 1ª mensagem sai, e a 1ª mensagem pode sair no minuto seguinte ao
  // Iniciar. Publicar depois deixaria uma janela em que os primeiros
  // destinatários recebem a abordagem e não entram em régua nenhuma — e eles são
  // justamente quem o operador olha para decidir se a campanha está funcionando.
  // Falha aqui NÃO entra em `preparing`: a campanha fica no rascunho, com o
  // motivo na tela.
  const regua = await publicarReguaDaCampanha(admin, { campanha: c, autorId });
  if (!regua.ok) {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: regua.mensagem, status: 422 };
  }

  // Compare-and-set: dois cliques simultâneos, e só um entra em `preparing`.
  const { data: entrou } = await admin
    .from("campaigns")
    .update({ status: "preparing" })
    .eq("id", c.id)
    .eq("status", "draft")
    .select("id");
  if ((entrou ?? []).length === 0) {
    return {
      ok: false,
      codigo: "campanha_preparando",
      mensagem: "A preparação desta campanha já está em andamento.",
      status: 409,
    };
  }

  try {
    // ═══ MODO CONTÍNUO: preparar é CONFERIR e ZERAR, não montar lista (9039) ═══
    //
    // Nenhuma linha de `campaign_recipients` NASCE aqui. O público desta
    // campanha são as pessoas que ENTRAREM na etapa depois do Iniciar, e
    // gravá-las agora seria abordar o estoque — justamente o que o corte
    // "nada retroativo" do gatilho existe para impedir. Mas a fila é APAGADA
    // (ver o bloco do `delete` abaixo): não montar lista não é o mesmo que
    // deixar de pé a lista que outra preparação montou.
    //
    // O que preparar faz, e é o que preserva a revisão da 1ª mensagem num modo
    // que não tem "antes": roda a PRÉVIA sobre a etapa escolhida com o MESMO
    // renderizador do envio, grava a contagem no snapshot (a tela a mostra
    // rotulada como "estão nesta etapa hoje", nunca como fila) e deixa a
    // campanha em `ready`. De `ready` nada sai sozinho: o clique em Iniciar é
    // que arma o gatilho.
    //
    // ⚠️ ETAPA VAZIA NÃO RECUSA, ao contrário do modo lista. Armar a campanha
    // numa etapa que ainda não tem ninguém é o caso de uso principal (etapa
    // nova, funil novo): recusar aqui barraria exatamente quem a feature serve.
    // O que a prévia dá nesse caso é o número honesto — zero —, e o texto segue
    // conferido pelo gate acima e pelo envio de teste.
    if (ehEntradaContinua(c)) {
      // A etapa é do FUNIL desta campanha? A FK composta da 9039 já garante a
      // organização; o funil não, e a incoerência seria silenciosa e torta: o
      // gatilho casa só pela etapa (abordaria gente), e a prévia filtra funil E
      // etapa (mostraria zero). Tela dizendo "ninguém" com mensagem saindo é a
      // pior combinação possível.
      const forasDoFunil = await etapaForaDoFunil(admin, c);
      if (forasDoFunil) {
        await voltarAoRascunho(admin, c.id, "etapa_fora_do_funil");
        return forasDoFunil;
      }

      // ═══ A FILA É APAGADA AQUI, e isto é um P0 do @Cassio_SecRev ═══
      //
      // O invariante que esta fatia inteira assume é: a fila é o que a ÚLTIMA
      // preparação montou, e a última preparação é o que o operador conferiu. No
      // modo lista quem o sustenta é o `delete` com que `prepararCampanha`
      // começa. O ramo contínuo não monta lista nenhuma — e, por não montar,
      // tinha deixado de apagar; o gate `campanha_sem_elegiveis` do Iniciar
      // também está desligado aqui (ali ele impediria o modo de existir). As
      // duas únicas coisas que garantiam o invariante, desligadas na mesma
      // fatia.
      //
      // O caminho que isso abria, medido no código: uma preparação de lista de
      // 5.000 que falha no lote 7 cai em `voltarAoRascunho` e deixa ~3.000
      // linhas `pending`, com o `rendered_body` do texto ANTIGO. O operador
      // desiste da lista, marca entrada contínua, prepara e Inicia. O worker
      // despacha as 3.000 mensagens descartadas, no texto que o operador já
      // havia trocado — e `rodada.ts` NUNCA compara
      // `campaign_recipients.content_version` com `campaigns.content_version`
      // (ela só carimba a da campanha no metadado da mensagem), então nada
      // nota a divergência.
      //
      // Apagar não apaga histórico: `jaEnviou`, logo acima, já recusou preparar
      // qualquer campanha de que tenha saído mensagem. O que morre aqui é
      // exclusivamente fila que nunca foi despachada.
      const { error: erroDaLimpeza } = await admin
        .from("campaign_recipients")
        .delete()
        .eq("organization_id", c.organization_id)
        .eq("campaign_id", c.id);
      if (erroDaLimpeza) {
        // Falha dura: seguir com resto de fila no banco é o cenário acima.
        //
        // ⚠️ A MENSAGEM DO POSTGREST NÃO VAI PARA O RECIBO. É a mesma doutrina que
        // o P2-3 do @Cassio_SecRev aplicou em `entrada-por-etapa.db.ts`, e ela
        // valia aqui também: a resposta da API é lida em tela e pode ecoar o
        // valor que o banco recusou. O texto real vai para o log do servidor,
        // que é onde se investiga; o `failure_code` da campanha (gravado por
        // `voltarAoRascunho`) é o rastro que fica na linha.
        logger.warn("[campanha] limpeza da fila falhou ao preparar em modo contínuo", {
          campanha: c.id,
          motivo: erroDaLimpeza.message,
        });
        await voltarAoRascunho(admin, c.id, "limpeza_da_fila");
        return {
          ok: false,
          // Código PRÓPRIO: `campanha_sem_audiencia` descreve "o recorte não
          // achou ninguém" e mandaria o operador mexer no filtro, que não tem
          // nada com isto.
          codigo: "campanha_fila_nao_limpa",
          mensagem:
            "Não foi possível limpar a fila desta campanha antes de prepará-la. " +
            "Tente de novo; se repetir, o motivo está no log do servidor.",
          status: 422,
        };
      }

      const previa = await resumoDaEtapaDeEntrada(admin, { campanha: c, agora });
      await admin
        .from("campaigns")
        .update({
          status: "ready",
          prepared_at: agora.toISOString(),
          snapshot_total: previa.total,
          snapshot_eligible: previa.elegiveis,
          snapshot_excluded: previa.excluidos,
          audience_version: c.audience_version + 1,
        })
        .eq("id", c.id)
        .eq("status", "preparing");
      return { ok: true, resumo: previa };
    }

    const resumo = await prepararCampanha(admin, {
      campanhaId: c.id,
      organizationId: c.organization_id,
      filtro: c.audience_filter,
      corpo: c.message_body ?? "",
      variacoes: c.message_variants ?? [],
      contentVersion: c.content_version,
      agora,
      ...(doModelo.modelo ? { modelo: doModelo.modelo } : {}),
    });
    if (resumo.total === 0) {
      await voltarAoRascunho(admin, c.id, "audiencia_vazia");
      return {
        ok: false,
        codigo: "campanha_sem_audiencia",
        mensagem: "O recorte não encontrou nenhum contato. Ajuste o filtro.",
        status: 422,
      };
    }
    if (resumo.elegiveis === 0) {
      await voltarAoRascunho(admin, c.id, "sem_elegiveis");
      return {
        ok: false,
        codigo: "campanha_sem_elegiveis",
        mensagem:
          "O recorte encontrou contatos, mas nenhum pode receber — veja os motivos na prévia.",
        status: 422,
      };
    }

    await admin
      .from("campaigns")
      .update({
        status: "ready",
        prepared_at: agora.toISOString(),
        snapshot_total: resumo.total,
        snapshot_eligible: resumo.elegiveis,
        snapshot_excluded: resumo.excluidos,
        audience_version: c.audience_version + 1,
      })
      .eq("id", c.id)
      .eq("status", "preparing");

    return { ok: true, resumo };
  } catch (err) {
    // A campanha não pode ficar presa em `preparing`: quem tentou preparar
    // precisa poder corrigir o filtro e tentar de novo.
    await voltarAoRascunho(admin, c.id, "erro_na_preparacao");
    return {
      ok: false,
      codigo: "campanha_sem_audiencia",
      mensagem: err instanceof Error ? err.message : String(err),
      status: 422,
    };
  }
}

/**
 * A etapa de entrada contínua pertence ao funil da campanha? `null` = sim.
 *
 * Lida com o `organization_id` da campanha, nunca com um id vindo de corpo de
 * requisição — a mesma regra de toda consulta deste módulo.
 */
async function etapaForaDoFunil(
  admin: SupabaseClient,
  c: CampanhaCarregada,
): Promise<Recusa | null> {
  const { data } = await admin
    .from("crm_stages")
    .select("id, pipeline_id")
    .eq("organization_id", c.organization_id)
    .eq("id", c.entrada_etapa_id as string)
    .maybeSingle();
  const etapa = data as { pipeline_id: string | null } | null;
  if (etapa && etapa.pipeline_id === c.pipeline_id) return null;
  return {
    ok: false,
    codigo: "campanha_conteudo_invalido",
    mensagem:
      "A etapa que inicia a abordagem não é do funil escolhido nesta campanha. " +
      "Escolha uma etapa do mesmo funil.",
    status: 422,
  };
}

async function voltarAoRascunho(admin: SupabaseClient, id: string, codigo: string): Promise<void> {
  await admin
    .from("campaigns")
    .update({ status: "draft", failure_code: codigo })
    .eq("id", id)
    .eq("status", "preparing");
}

/**
 * EDITAR uma campanha PRONTA: devolvê-la ao rascunho para re-preparar o público.
 *
 * É a transição `ready → draft` que a máquina de estados prevê como "o caminho
 * de editar" — e cujo guarda ela delega ao chamador: quem já ENVIOU não pode
 * reescrever a mensagem que a pessoa recebeu. Esse guarda mora aqui.
 *
 * ⚠️ NÃO CONFUNDIR com o helper `voltarAoRascunho` acima: aquele conserta uma
 * preparação travada (`preparing → draft`, com `failure_code`) e é interno. Este
 * é a AÇÃO do operador, de `ready`, e invalida o snapshot de propósito.
 */
export async function voltarAoRascunhoAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  _agora: Date,
  _autorId: string,
): Promise<Desfecho> {
  const recusa = recusaDeTransicao(c.status, "draft");
  if (recusa) return recusa;

  // O guarda que a máquina de estados delega: já saiu mensagem desta campanha?
  // Então refazer a lista mudaria o que já foi dito a quem recebeu. O caminho de
  // editar o texto depois do primeiro envio é Duplicar, não reabrir.
  if (await jaEnviou(admin, c.id)) {
    return {
      ok: false,
      codigo: "campanha_ja_enviou",
      mensagem:
        "Esta campanha já enviou mensagens; reabri-la mudaria o texto de quem já recebeu. " +
        "Para editar e enviar de novo, duplique-a.",
      status: 422,
    };
  }

  // TRAVA O ESTADO ANTES DE APAGAR NADA — e esta ordem é o conserto, não detalhe.
  // Compare-and-set: só sai de `ready`, e só UMA transição vence. Vem ANTES do
  // delete de propósito: se um Iniciar disputa e ganha o CAS (`ready → running`),
  // o nosso update não pega linha e a gente sai SEM ter apagado a lista de uma
  // campanha que já começou a rodar. Deletar primeiro (como estava) deixava o
  // delete rodar mesmo quando o Iniciar vencia, esvaziando a fila de uma campanha
  // `running`. É a mesma ordem de `prepararAcao` (CAS `draft → preparing` antes,
  // delete depois): o estado é o cadeado, e o delete só roda com ele na mão.
  // O CAS fixo em `ready` também barra `failed → draft` (que a máquina permitiria)
  // sem tocar na lista: `failed` não casa, vira conflito, nada é apagado.
  const { data: travada } = await admin
    .from("campaigns")
    .update({ status: "draft" })
    .eq("id", c.id)
    .eq("status", "ready")
    .select("id");
  if ((travada ?? []).length === 0) return conflitoDeCorrida();

  // Agora a campanha é `draft` (ninguém mais a inicia) e o snapshot velho deixa
  // de valer: o mesmo motor de preparação o refaz do zero no próximo Preparar.
  // MESMO delete do ramo contínuo de `prepararAcao`, filtrando `organization_id`
  // E `campaign_id` — o client é admin e ignora RLS, e delete sem a organização é
  // delete de outro tenant esperando acontecer.
  const { error: erroDaLimpeza } = await admin
    .from("campaign_recipients")
    .delete()
    .eq("organization_id", c.organization_id)
    .eq("campaign_id", c.id);
  if (erroDaLimpeza) {
    // A campanha JÁ está em `draft` aqui; o pior caso é snapshot velho sobrando,
    // que o próximo Preparar recalcula. A mensagem do PostgREST NÃO vai para o
    // recibo (doutrina do P2-3 do @Cassio_SecRev): o texto real vai para o log.
    logger.warn("[campanha] limpeza da fila falhou ao voltar ao rascunho", {
      campanha: c.id,
      motivo: erroDaLimpeza.message,
    });
    return {
      ok: false,
      codigo: "campanha_fila_nao_limpa",
      mensagem:
        "A campanha voltou ao rascunho, mas não foi possível limpar a lista antiga. " +
        "Prepare de novo; se repetir, o motivo está no log do servidor.",
      status: 422,
    };
  }
  return { ok: true };
}

export async function iniciarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
  autorId: string,
): Promise<Desfecho<{ retomada: boolean }>> {
  const recusa = recusaDeTransicao(c.status, "running") ?? faltaParaEnviar(c);
  if (recusa) return recusa;
  // O modelo pode ter sido pausado pela plataforma desde a preparação — e é
  // exatamente o motivo mais comum de uma campanha oficial ter parado sozinha.
  const doModelo = await modeloDaCampanha(admin, c);
  if (!doModelo.ok) return doModelo;

  // ⚠️ O GATE DE "TEM GENTE NA LISTA" NÃO SE APLICA AO MODO CONTÍNUO (9039): ali
  // a lista está vazia por desenho, e exigir destinatário antes de iniciar
  // tornaria o modo impossível de ligar. O que o substitui é o gate de
  // `faltaParaEnviar` acima, que já exigiu funil, etapa, teto do dia e janela —
  // e esses quatro são, no contínuo, o equivalente de "sei para quem vou falar e
  // quanto por dia".
  //
  // ⚠️ E o que impede este desligamento de virar envio em massa é o `delete` do
  // ramo contínuo de `prepararAcao`: com ele, chegar em `ready` significa fila
  // VAZIA, e não "fila que ninguém mediu". Quem mexer num dos dois tem de ler o
  // outro — eles são a mesma garantia, em dois lugares.
  if (!ehEntradaContinua(c)) {
    const { count } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", c.id)
      .eq("eligibility_status", "eligible");
    if ((count ?? 0) === 0) {
      return {
        ok: false,
        codigo: "campanha_sem_elegiveis",
        mensagem: "Nenhum destinatário elegível. Prepare a campanha antes de iniciar.",
        status: 422,
      };
    }
  }

  // Republica: o RITMO se edita com a campanha em pé (tela de detalhe), e o
  // ritmo é a política da régua. Sem isto, quem desacelerou uma campanha em
  // andamento desacelerava só a 1ª mensagem — os passos seguiriam no ritmo
  // antigo, que é exatamente o que o operador tentou conter.
  const regua = await publicarReguaDaCampanha(admin, { campanha: c, autorId });
  if (!regua.ok) {
    return { ok: false, codigo: "campanha_conteudo_invalido", mensagem: regua.mensagem, status: 422 };
  }

  const retomada = c.status === "paused";
  const { data } = await admin
    .from("campaigns")
    .update({
      status: "running",
      started_at: agora.toISOString(),
      paused_at: null,
      scheduled_at: null,
      // Retomar é a decisão de quem corrigiu a causa: o motivo da pausa
      // automática (`pausarPorFalha`, na rodada) sai da tela junto.
      failure_code: null,
      failure_detail: null,
    })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  return { ok: true, retomada };
}

export async function agendarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  quando: Date,
  agora: Date,
): Promise<Desfecho> {
  const recusa = recusaDeTransicao(c.status, "scheduled") ?? faltaParaEnviar(c);
  if (recusa) return recusa;
  if (quando.getTime() <= agora.getTime()) {
    return {
      ok: false,
      codigo: "campanha_agenda_invalida",
      mensagem: "Escolha uma data no futuro — para enviar agora, use Iniciar.",
      status: 422,
    };
  }
  const { data } = await admin
    .from("campaigns")
    .update({ status: "scheduled", scheduled_at: quando.toISOString(), paused_at: null })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  return { ok: true };
}

export async function pausarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
): Promise<Desfecho> {
  const recusa = recusaDeTransicao(c.status, "paused");
  if (recusa) return recusa;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "paused", paused_at: agora.toISOString() })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();
  // Quem já estava `sending` NÃO é desfeito: a mensagem pode estar na borda
  // externa neste instante, e prometer cancelamento do que já saiu é mentir.
  //
  // A RÉGUA SEGUE, e isso é escolha: pausar para de ABORDAR gente nova, e quem
  // já foi abordado continua recebendo os passos que a campanha prometeu a ele.
  // Desligar o pointer aqui seria pior que não fazer nada: com a régua
  // desligada o worker PULA cada passo e o motor avança, então os inscritos
  // correriam a régua inteira em tiques — e um "retomar" depois os encontraria
  // no fim, sem nunca terem recebido nada. Quem quer parar tudo cancela, e o
  // cancelamento encerra as inscrições (`encerrarReguaDaCampanha`).
  return { ok: true };
}

export async function cancelarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  agora: Date,
): Promise<Desfecho<{ cancelados: number }>> {
  const recusa = recusaDeTransicao(c.status, "cancelled");
  if (recusa) return recusa;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "cancelled", cancelled_at: agora.toISOString() })
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if ((data ?? []).length === 0) return conflitoDeCorrida();

  // A campanha já está cancelada quando esta linha roda: a rodada não escolhe
  // mais esta campanha, então não há corrida com o worker por estes pendentes.
  const { data: cancelados } = await admin
    .from("campaign_recipients")
    .update({ status: "cancelled", cancelled_at: agora.toISOString() })
    .eq("campaign_id", c.id)
    .in("status", ["pending", "queued"])
    .select("id");

  // Quem JÁ recebeu a 1ª mensagem está na régua, e a régua não é destinatário
  // pendente: cancelar a campanha sem encerrá-la deixaria os passos seguintes
  // saindo por dias depois do cancelamento. É o oposto do que o botão promete.
  if (c.followup_pointer_id) {
    await encerrarReguaDaCampanha(admin, c.organization_id, c.followup_pointer_id, agora);
  }
  return { ok: true, cancelados: (cancelados ?? []).length };
}

export async function duplicarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  autorId: string,
): Promise<Desfecho<{ id: string }>> {
  const { data, error } = await admin
    .from("campaigns")
    .insert({
      organization_id: c.organization_id,
      name: `${c.name} (cópia)`.slice(0, 160),
      description: c.description,
      channel_session_id: c.channel_session_id,
      message_body: c.message_body,
      message_variants: c.message_variants ?? [],
      message_mode: c.message_mode,
      provider_template_name: c.provider_template_name,
      provider_template_language: c.provider_template_language,
      provider_template_variables: c.provider_template_variables ?? {},
      base_legal: c.base_legal,
      lia_ref: c.lia_ref,
      // Os passos vão; a RÉGUA não. O `followup_pointer_id` é de uma campanha
      // específica — herdá-lo faria a cópia publicar por cima da régua do
      // original, e os inscritos dele passariam a seguir os passos da cópia.
      passos: passosGuardados(c.passos),
      // AS SAÍDAS VÃO JUNTO (9046), e isto não é detalhe: duplicar é o caminho
      // oficial de editar o texto de uma campanha já iniciada (conteúdo só muda
      // em rascunho). Uma cópia que largasse as saídas voltaria ao padrão sem
      // dizer nada, e a cópia de «pare quando o card entrar em Fechamento»
      // passaria a insistir com quem está em fechamento — fail open silencioso,
      // no exato lugar em que o operador acha que só trocou uma palavra.
      //
      // ⚠️ ILEGÍVEL é COPIADO ilegível, e isto é deliberado: normalizar para o
      // padrão aqui seria lavar o problema. A cópia publicaria uma política mais
      // FROUXA do que a intenção que ninguém conseguiu ler, e ninguém veria —
      // enquanto o original, que refuse publicar, pelo menos não manda nada.
      // Herdado, o defeito herda também as três recusas, e o operador o conserta
      // na seção «Quando a régua para» da cópia, que é rascunho.
      //
      // A exceção é o que NÃO É OBJETO (array, string, número): o CHECK
      // `campaigns_saidas_validas` recusaria o INSERT com 23514, e um erro de
      // banco aqui viraria "não foi possível duplicar" sem motivo na tela. E não
      // há o que preservar: um array nunca descreveu configuração de saída
      // nenhuma, nem por engano.
      saidas: ehObjetoDeSaidas(c.saidas) ? c.saidas : null,
      // O funil vem junto porque os passos o EXIGEM: sem ele, a cópia de uma
      // campanha com régua nasceria impossível de preparar, e o operador leria
      // "escolha o funil" numa tela que ele não mexeu. `stage_id` e `agent_id`
      // seguem fora, como antes — mudá-los é assunto de outra fatia.
      pipeline_id: c.pipeline_id,
      // O MODO DE PÚBLICO vai junto (9039): duplicar uma campanha contínua para
      // trocar o texto é o caminho oficial de editar a mensagem dela (conteúdo
      // só muda em rascunho, e a máquina de estados não leva de `running` nem de
      // `paused` de volta para `draft`). A cópia nasce em RASCUNHO, com o
      // gatilho desarmado até alguém preparar e iniciar — herdar o modo não
      // aborda ninguém por si.
      entrada_continua: c.entrada_continua,
      entrada_etapa_id: c.entrada_etapa_id,
      audience_filter: c.audience_filter,
      intervalo_segundos: c.intervalo_segundos,
      janela_inicio_hora: c.janela_inicio_hora,
      janela_fim_hora: c.janela_fim_hora,
      teto_diario: c.teto_diario,
      teto_horario: c.teto_horario,
      velocidade: c.velocidade,
      split_messages: c.split_messages,
      created_by: autorId,
      // Nada de destinatário, resultado, agenda ou carimbo de execução: a cópia
      // é uma INTENÇÃO nova, e herdar números faria a tela mostrar entrega de
      // mensagem que esta campanha nunca mandou.
    })
    .select("id")
    .single();
  if (error || !data) {
    return {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: error?.message ?? "Não foi possível duplicar a campanha.",
      status: 422,
    };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * O teste: a MESMA conexão, o MESMO renderizador, a MESMA camada de envio.
 *
 * Um teste que passasse por outro caminho provaria o outro caminho. E ele não
 * toca nos contadores da execução oficial — não cria destinatário, não gasta
 * fila —, mas gasta o ritmo do número, porque para o WhatsApp é uma mensagem
 * como qualquer outra.
 */
export async function testarAcao(
  admin: SupabaseClient,
  c: CampanhaCarregada,
  contactId: string,
  agora: Date,
  fuso: string,
): Promise<Desfecho<{ status: string }>> {
  const recusa = faltaParaEnviar(c);
  if (recusa) return recusa;

  const { data: contato } = await admin
    .from("contacts")
    .select("id, name, display_name, phone_number, is_blocked, is_personal, is_anonymized, consent")
    .eq("organization_id", c.organization_id)
    .eq("id", contactId)
    .maybeSingle();
  if (!contato) {
    return {
      ok: false,
      codigo: "campanha_nao_encontrada",
      mensagem: "Contato de teste não encontrado nesta organização.",
      status: 404,
    };
  }
  const linha = contato as {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    is_blocked: boolean;
    is_personal: boolean;
    is_anonymized: boolean;
    consent: unknown;
  };

  // O teste respeita os MESMOS vetos: mandar teste para quem pediu para parar
  // seria furar o opt-out pela porta dos fundos.
  const motivo = motivoParaExcluir({
    contactId: linha.id,
    telefone: linha.phone_number,
    bloqueado: linha.is_blocked,
    pessoal: linha.is_personal === true,
    anonimizado: linha.is_anonymized,
    recusouMarketing: recusouMarketing(linha.consent),
  });
  if (motivo) {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: `Este contato não pode receber: ${motivo}.`,
      status: 422,
    };
  }

  const doModelo = await modeloDaCampanha(admin, c);
  if (!doModelo.ok) return doModelo;
  const modelo = doModelo.modelo;

  // O teste passa pelo MESMO motor de variação, com a mesma semente do envio
  // real (`contact_id`): o operador vê no celular a variante que AQUELE contato
  // receberia, não uma sexta versão que a campanha nunca manda.
  // Os campos personalizados que o TEXTO usa entram pelo MESMO caminho da
  // prévia: teste que não resolvia `{{lead.gancho}}` reprovaria o texto que o
  // envio manda certo. Com modelo, quem diz se o negócio entra é o mapa.
  const variantes = variantesDaCampanha(c.message_body, c.message_variants);
  const campos = await camposDoDestinatario(admin, {
    organizationId: c.organization_id,
    contactId: linha.id,
    corpo: modelo ? "" : variantes.join("\n"),
    lerCamposDoNegocio: modelo ? camposDoNegocioUsados(modelo.variaveis).length > 0 : false,
  });
  let conteudo: ConteudoDoEnvio;
  if (modelo) {
    // O MESMO resolvedor da preparação: o teste manda o que o despacho mandaria.
    const r = resolverValoresDaCampanha(modelo.contrato, modelo.variaveis, {
      nomeDoContato: nomeDoContato(linha),
      camposDoNegocio: (campos.lead ?? {}) as Record<string, unknown>,
    });
    if (!r.ok) {
      return {
        ok: false,
        codigo: "campanha_conteudo_invalido",
        mensagem: `Este contato não preenche o modelo (${r.problemas.join("; ")}) — escolha outro para o teste.`,
        status: 422,
      };
    }
    conteudo = {
      type: "template",
      template_name: modelo.definicao.name,
      template_language: modelo.definicao.language,
      template_values: r.values,
      body: textoDoModeloParaAConversa(modelo.definicao, r.values),
    };
  } else {
    const render = renderizarVariacao({
      variantes,
      semente: linha.id,
      valores: { nome: nomeDoContato(linha), ...campos },
      quando: { agora, fuso },
    });
  if (render.faltando.length > 0) {
    return {
      ok: false,
      codigo: "campanha_conteudo_invalido",
      mensagem: `Falta ${render.faltando.join(", ")} no cadastro deste contato — escolha outro para o teste.`,
      status: 422,
    };
  }
    conteudo = { type: "text", body: render.texto };
  }

  const boundary = await beginServiceAtOrigin(admin, c.organization_id, linha.id, c.channel_session_id);
  // O teste divide como a rodada divide (`baloes.ts`): quem testa precisa ver
  // no aparelho os mesmos balões que o destinatário vai receber.
  const baloes = conteudo.type === "text" ? baloesDaCampanha(conteudo.body, c.split_messages === true) : [conteudo.body];
  const { desfecho: mensagem } = await enviarEmBaloes(baloes, {
    enviar: (texto) =>
      sendMessageHandler(
    admin,
    {
      organization_id: c.organization_id,
      serviceBoundary: boundary,
      proactiveContext: { organizationId: c.organization_id, contactId: linha.id },
      actor: { type: "webhook_source", id: `campaign-test:${c.id}` },
      requestId: `campaign-test:${c.id}:${randomUUID()}`,
    } as Parameters<typeof sendMessageHandler>[1],
    {
      conversation_id: boundary.conversation_id,
          ...conteudo,
          ...(conteudo.type === "text" ? { body: texto } : {}),
      metadata: { source: "campaign_test", campaign_id: c.id },
    } as Parameters<typeof sendMessageHandler>[2],
      ),
    esperar: () => new Promise((ok) => setTimeout(ok, pausaEntreBaloes(PACING_DEFAULTS))),
  });

  const status = (mensagem as { status?: string }).status ?? "desconhecido";
  if (status === "failed") {
    // O motivo da plataforma, quando há: "falhou no canal" não diz ao operador
    // se o problema é o modelo, o número ou este contato.
    const m = mensagem as { error_code?: string | null; error_message?: string | null };
    const frase = fraseDaFalha(codigoDaPlataforma(m.error_code, m.error_message), m.error_message);
    return {
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: frase
        ? `O envio de teste falhou: ${frase}`
        : "O envio de teste falhou no canal. Verifique a conexão antes de iniciar a campanha.",
      status: 409,
    };
  }
  return { ok: true, status };
}

function conflitoDeCorrida(): Recusa {
  return {
    ok: false,
    codigo: "campanha_estado_invalido",
    mensagem: "O estado da campanha mudou enquanto esta ação era processada. Recarregue a tela.",
    status: 409,
  };
}
