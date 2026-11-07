/**
 * Conectar o canal Verdash — do lado de dentro do seam.
 *
 * ─── A diferença de UX que este canal permite, e os outros não ──────────────
 *
 * Conectar um canal são sempre DUAS pontas: a credencial, que deixa o CRM
 * FALAR com o provedor, e o webhook, que deixa o provedor falar com o CRM. Nos
 * canais por credencial existentes a segunda ponta é MANUAL — o operador copia
 * uma URL e um segredo e vai colar no painel do outro sistema. Quem faz só a
 * primeira consegue enviar e nunca recebe, e o defeito aparece horas depois
 * como "o cliente respondeu e não chegou".
 *
 * Aqui não precisa. O token da instância autoriza também a API de webhooks do
 * FZAP, então o CRM REGISTRA A VOLTA SOZINHO. O operador cola uma coisa só, e o
 * passo em que a maioria das conexões falha simplesmente não existe.
 *
 * ─── Por que o registro é ADITIVO, e por que isso importa muito ─────────────
 *
 * O FZAP aceita VÁRIOS webhooks por instância. Isso não é detalhe: a instância
 * do cliente JÁ TEM um webhook apontando para a Verdash, que é o que alimenta
 * rastreio, atribuição de anúncio e CAPI. Substituí-lo faria o CRM funcionar e
 * quebraria, em silêncio, o produto que o cliente já usava.
 *
 * Então acrescentamos o nosso ao lado, e removemos apenas os que apontam para
 * ESTA instalação do CRM (reconectar não pode empilhar duplicatas). O da
 * Verdash — e o de qualquer outro sistema — não é tocado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_VERDASH } from "../capabilities";
import { fzapRequest } from "./client";
import { verdashBaseUrl, verdashFunctionsUrl } from "./credentials";
import type { ChannelProvider } from "../types";

export const VERDASH_CHANNEL_PROVIDER: ChannelProvider = CHANNEL_PROVIDER_VERDASH;

/**
 * Os canais que o pareamento da Verdash sabe conectar.
 *
 * O MESMO código de pareamento serve aos dois: o cliente cola um código, a Verdash
 * devolve um token dela com escopo de uma instância, e o transporte passa por lá. O que
 * muda é QUAL canal aquele vínculo cobre — e sem dizer isso, vincular seria tudo ou nada:
 * ligar o WhatsApp ligaria o Instagram junto, e desligar um desligaria o outro.
 *
 * O provider é onde essa distinção mora porque é ele que `capabilitiesOf()` consulta.
 * Guardar o canal noutro campo faria a tela ter que perguntar "qual canal é este?" —
 * exatamente o que a camada de canais existe para evitar.
 */
export type CanalPareavel = typeof CHANNEL_PROVIDER_VERDASH | typeof CHANNEL_PROVIDER_INSTAGRAM;

export const CANAL_PAREAVEL_PADRAO: CanalPareavel = CHANNEL_PROVIDER_VERDASH;

/**
 * Como o canal se chama PARA O USUÁRIO.
 *
 * Quem instala reconhece a marca do serviço que já usa; "provedor parceiro"
 * obrigaria a adivinhar.
 */
export const VERDASH_CHANNEL_LABEL = "Verdash";

/**
 * Os eventos que o CRM quer receber.
 *
 * Lista explícita, e não `All`: `All` traz sincronização de histórico, presença,
 * estado de app e sinalização de chamada — dezenas de eventos por minuto que o
 * CRM descarta, cada um custando uma requisição HTTP e uma linha de log. Pedir
 * o que se usa é a diferença entre um webhook e uma mangueira.
 *
 * `AutomationMessage` entra junto de `Message` porque é mensagem de verdade: é
 * o que o próprio FZAP manda por automação, e deixá-la de fora esconderia do
 * histórico o que o cliente recebeu sem ninguém digitar.
 */
// `AppState` e não `Archive`/`Pin`: o filtro do webhook do FZAP descarta esses nomes calado (PUT devolve 200
// sem eles, medido em 07/11). O AppState traz toda mutação da conta (cresce numa sincronização completa);
// `estado-de-grupo.ts` só grava arquivar/fixar de grupo e ignora o resto sem log.
const EVENTOS = ["Message", "AutomationMessage", "Connected", "Disconnected", "LoggedOut", "AppState"];

/**
 * O header por onde o segredo do CRM viaja em cada entrega.
 *
 * Nome NEUTRO de propósito: este CRM é white-label, e um header com a marca
 * dentro seria marca fixada em código — a catraca de `tests/unit/branding.test.ts`
 * cobra isso, e com razão. Aqui não há compatibilidade a preservar: o header
 * nasce agora.
 */
export const HEADER_DO_SEGREDO = "X-Webhook-Secret";

export type VerdashValidacao =
  | {
      ok: true;
      instanceName: string;
      phoneNumber: string | null;
      displayName: string;
      connected: boolean;
    }
  | { ok: false; reason: string };

/**
 * O token presta? E de qual instância ele é?
 *
 * Perguntado ao FZAP ANTES de gravar qualquer coisa. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que
 * não na primeira mensagem que não sai, com o cliente do outro lado esperando.
 *
 * Repare que o nome da instância NÃO é pedido ao usuário: ele vem da resposta.
 * Pedir os dois abriria a porta para colar o token de uma instância e o nome de
 * outra — e o CRM passaria a mandar mensagem por um número acreditando ser
 * outro.
 */
export async function validateVerdashToken(token: string): Promise<VerdashValidacao> {
  let data: {
    id?: string;
    name?: string;
    connected?: boolean;
    loggedIn?: boolean;
    jid?: string;
  };
  try {
    data = await fzapRequest(
      { instanceName: "", token, vinculoId: null, baseUrl: verdashBaseUrl() },
      "/session/status",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("401") || msg.includes("403")) {
      return { ok: false, reason: "Token não reconhecido pela Verdash. Confira e cole de novo." };
    }
    if (msg.startsWith("verdash_unreachable")) {
      return { ok: false, reason: "Não foi possível falar com a Verdash agora. Tente em instantes." };
    }
    return { ok: false, reason: "A Verdash recusou a consulta com este token." };
  }

  const instanceName = typeof data?.name === "string" ? data.name.trim() : "";
  if (!instanceName) {
    return { ok: false, reason: "A Verdash não informou qual instância é esta." };
  }

  // O número sai do JID (`556681276920:50@s.whatsapp.net`). Pode não existir
  // ainda — instância criada e nunca pareada —, e isso não impede conectar: o
  // número aparece sozinho quando o pareamento acontecer.
  const digitos = (data.jid ?? "").split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
  const telefone = digitos.length >= 8 ? `+${digitos}` : null;

  // ─── Como o canal se chama NA TELA DO CLIENTE ───────────────────────────
  //
  // NÃO o nome da instância. Esse nome é interno nosso — na primeira conexão
  // ele apareceu para o cliente como `tektus-dr-paulo-torres`, isto é, a tela
  // do consultório mostrando a convenção de nomes da agência. Além de feio, é
  // vazamento de vocabulário interno pela porta da frente.
  //
  // O rótulo certo é o nome que o WhatsApp já usa para aquela linha — o mesmo
  // que o cliente vê quando alguém recebe mensagem dele. O número entra como
  // segunda opção, e o nome da instância fica só como último recurso, para o
  // caso de uma linha criada e ainda não pareada (que não tem nem perfil nem
  // número).
  let pushName: string | null = null;
  try {
    const perfil = await fzapRequest<{ pushName?: string }>(
      { instanceName: "", token, vinculoId: null, baseUrl: verdashBaseUrl() },
      "/user/profile/name",
    );
    pushName = typeof perfil?.pushName === "string" && perfil.pushName.trim().length > 0
      ? perfil.pushName.trim()
      : null;
  } catch {
    // Perfil é enfeite: a conexão não pode falhar porque o nome não veio.
    pushName = null;
  }

  return {
    ok: true,
    instanceName,
    phoneNumber: telefone,
    displayName: pushName ?? telefone ?? instanceName,
    connected: Boolean(data.connected && data.loggedIn !== false),
  };
}


/**
 * Quais webhooks da instância são DESTA instalação e devem sair antes do novo.
 *
 * "Desta instalação" = mesma origem (esquema + host + porta) que a URL nova e caminho
 * de canal. Comparar a URL EXATA, como era antes, deixava para trás o webhook de uma
 * conexão anterior com outro token de caminho — e foi assim que, em 25/09/2026, um
 * número passou a entregar no canal de OUTRO número com o segredo velho: toda entrega
 * recusada, 55 em vinte minutos, e as conversas dele sumindo do inbox.
 *
 * Seguro deixar sair qualquer webhook de canal desta origem porque uma instância
 * pertence a UM canal por instalação (índice `channel_sessions_verdash_instance_unique`).
 * O da Verdash e o de qualquer outro sistema têm outra origem ou outro caminho, e ficam.
 *
 * Comparação por `URL.origin`, nunca por prefixo de string: `https://crm.x@evil.com/…`
 * e `https://crm.x.evil.com/…` passariam num `startsWith`.
 */
export function webhooksDestaInstalacao(
  existentes: ReadonlyArray<{ id?: string; url?: string }>,
  urlNova: string,
): string[] {
  let origem: string;
  let caminhoDeCanal: string;
  try {
    const nova = new URL(urlNova);
    origem = nova.origin;
    // O prefixo sai da PRÓPRIA URL nova (tudo até o último `/`), e não de uma
    // constante: instalação publicada num subcaminho (`https://host/crm/api/…`)
    // continua casando consigo mesma.
    caminhoDeCanal = nova.pathname.slice(0, nova.pathname.lastIndexOf("/") + 1);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const w of existentes) {
    if (!w?.id || !w.url) continue;
    let u: URL;
    try {
      u = new URL(w.url);
    } catch {
      continue;
    }
    if (u.username || u.password) continue;
    // Prefixo que não é de webhook de canal (URL nova fora do padrão) não pode
    // virar curinga do host inteiro: aí só a URL idêntica sai.
    const prefixoConfiavel = caminhoDeCanal.endsWith("/webhooks/channel/");
    const casa = prefixoConfiavel
      ? u.origin === origem && u.pathname.startsWith(caminhoDeCanal)
      : w.url === urlNova;
    if (casa) ids.push(w.id);
  }
  return ids;
}

/**
 * Registra a volta: o webhook do CRM na instância do cliente.
 *
 * ADITIVO — ver o cabeçalho. Remove só o que aponta para esta instalação, para
 * que reconectar não empilhe entregas duplicadas (e mensagem duplicada no inbox
 * do cliente).
 *
 * Best-effort do lado de FORA: quem chama decide o que fazer com a falha. Ela
 * não pode derrubar a conexão inteira — um canal que fala e não ouve ainda é
 * melhor que nenhum canal, desde que a tela DIGA isso, que é justamente o que
 * o retorno permite.
 */
export async function registrarWebhookNaVerdash(input: {
  token: string;
  webhookUrl: string;
  segredo: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const creds = { instanceName: "", token: input.token, vinculoId: null, baseUrl: verdashBaseUrl() };

  try {
    const existentes = await fzapRequest<Array<{ id?: string; url?: string }>>(creds, "/webhook");
    for (const id of webhooksDestaInstalacao(existentes ?? [], input.webhookUrl)) {
      await fzapRequest(creds, `/webhook/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
  } catch {
    // Listar é conveniência: se falhar, seguimos e criamos. O pior caso é uma
    // entrega duplicada, que a chave `(organization_id, external_id)` já
    // absorve como `duplicate` na ingestão.
  }

  try {
    await fzapRequest(creds, "/webhook", {
      method: "POST",
      body: {
        url: input.webhookUrl,
        events: EVENTOS,
        // O rótulo é para o humano que abrir o painel da Verdash e se perguntar
        // de quem é este webhook. Sem ele, some no meio dos outros.
        label: "CRM",
        headers: { [HEADER_DO_SEGREDO]: input.segredo },
      },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro desconhecido";
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export type TrocaDeCodigo =
  | {
      ok: true;
      vinculoId: string;
      instanceName: string;
      token: string;
      phoneNumber: string | null;
      displayName: string;
      connected: boolean;
      recebimentoLigado: boolean;
      recebimentoAviso: string | null;
    }
  | { ok: false; reason: string };

/**
 * Troca o CÓDIGO DE PAREAMENTO por uma credencial de máquina.
 *
 * ─── O que muda em relação a colar o token ──────────────────────────────────
 *
 * Colar o token da instância funciona e foi como o primeiro número entrou no
 * ar. O custo é que aquele token é a chave da linha no servidor de WhatsApp:
 * ele passa a viver aqui também, e cortar o acesso do CRM obriga a rotacioná-lo
 * lá — derrubando junto o sistema que já usava aquele número.
 *
 * Com o código, quem responde é a Verdash: ela valida, queima o código, liga a
 * entrada e devolve um token DELA, que vale para uma instância e morre quando
 * alguém clicar em revogar. O cliente não vê token nenhum, e a tela de lá passa
 * a saber quem está conectado.
 *
 * ─── Quem chama, e de onde ──────────────────────────────────────────────────
 *
 * O SERVIDOR do CRM — nunca o browser. É por isso que o segredo do webhook
 * viaja neste corpo: ele nasce aqui, vai para lá, e volta em cada entrega como
 * prova de que quem entrega é quem foi autorizado.
 */
export async function trocarCodigoPorCredencial(input: {
  codigo: string;
  webhookUrl: string;
  segredo: string;
  rotulo: string;
}): Promise<TrocaDeCodigo> {
  let res: Response;
  try {
    res = await fetch(`${verdashFunctionsUrl().replace(/\/+$/, "")}/crm-vincular-instancia`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: input.codigo,
        webhook_url: input.webhookUrl,
        webhook_secret: input.segredo,
        rotulo: input.rotulo,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, reason: "Não foi possível falar com a Verdash agora. Tente em instantes." };
  }

  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: string; data?: Record<string, unknown> }
    | null;

  if (!res.ok || json?.success !== true || !json?.data) {
    // A Verdash responde o MESMO erro para código inexistente, já usado e
    // expirado — de propósito, para não dizer a quem tenta às cegas que
    // acertou e chegou tarde. Aqui a mensagem vira algo que o operador entende.
    const codigoErro = json?.error ?? "";
    if (codigoErro.includes("codigo_invalido") || codigoErro.includes("expirado")) {
      return {
        ok: false,
        reason: "Código inválido ou expirado. Gere outro na Verdash e cole aqui.",
      };
    }
    if (codigoErro.includes("webhook_url")) {
      // Este é erro de CONFIGURAÇÃO nossa, não do operador — e dizer "código
      // inválido" mandaria ele gerar código novo a tarde inteira.
      return {
        ok: false,
        reason: "A Verdash recusou o endereço deste CRM. Confira o endereço público da instalação.",
      };
    }
    return { ok: false, reason: "A Verdash não aceitou este código." };
  }

  const d = json.data as {
    vinculo_id?: string;
    instancia_id?: string;
    token?: string;
    phone_number?: string | null;
    display_name?: string | null;
    status?: string | null;
    recebimento_ligado?: boolean;
    recebimento_aviso?: string | null;
  };

  if (!d.token || !d.vinculo_id) {
    return { ok: false, reason: "A Verdash respondeu sem a credencial." };
  }

  const telefone = d.phone_number ?? null;
  return {
    ok: true,
    vinculoId: d.vinculo_id,
    // A instância é identificada pelo id que a Verdash deu: é o que endereça o
    // envio de lá para cá, e o nome interno dela não interessa ao CRM.
    instanceName: d.instancia_id ?? d.vinculo_id,
    token: d.token,
    phoneNumber: telefone,
    displayName: d.display_name ?? telefone ?? "WhatsApp",
    // ─── DOIS VOCABULÁRIOS, E O DA RESPOSTA É O DE LÁ ────────────────────
    //
    // `WORKING` é o vocabulário DESTE CRM (`channel_sessions.status`). A
    // plataforma responde no dela: `connected`, minúsculo. Comparar com
    // `"WORKING"` nunca casava, e todo canal recém-pareado nascia `STARTING`.
    //
    // Não quebrava nada — a varredura de saúde corrige em até 5 minutos —, mas
    // nesses 5 minutos a tela mostra "STARTING" para quem acabou de conectar,
    // e quem acabou de colar um código lê isso como "não deu certo". Medido em
    // 24/09/2026 ao parear o Instagram do Portal da China.
    //
    // Os dois valores entram: `WORKING` porque é o que uma instalação que já
    // traduz do lado de lá devolveria, e `connected` porque é o que a
    // plataforma devolve hoje. Aceitar os dois é o que faz esta linha parar de
    // depender de qual das duas pontas foi atualizada por último.
    connected: d.status === "WORKING" || d.status === "connected",
    recebimentoLigado: d.recebimento_ligado !== false,
    recebimentoAviso: d.recebimento_aviso ?? null,
  };
}

export interface VerdashSession {
  id: string;
  instanceName: string | null;
  /** Presente = conectado por código; o envio passa pela Verdash. */
  vinculoId: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  archivedAt: string | null;
  /** `nativa` = instância criada pelo CRM no FZAP; vincular token/código nunca a reaproveita. */
  origem: "nativa" | "vinculada";
}

const COLUNAS =
  "id, verdash_instance_name, verdash_vinculo_id, phone_number, display_name, status, webhook_path_token, verdash_token_encrypted, verdash_origem";

function toVerdashSession(row: Record<string, unknown> | null): VerdashSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    instanceName: (row.verdash_instance_name as string) ?? null,
    vinculoId: (row.verdash_vinculo_id as string) ?? null,
    phoneNumber: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    // Existe, não qual é.
    hasToken: !!row.verdash_token_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
    origem: row.verdash_origem === "nativa" ? "nativa" : "vinculada",
  };
}

export async function findVerdashSession(
  admin: SupabaseClient,
  organizationId: string,
  /**
   * Qual canal procurar. O default mantém intacto quem chamava antes de existirem dois —
   * e quem chama sem dizer continua falando de WhatsApp, que é o que sempre foi.
   */
  canal: CanalPareavel = CANAL_PAREAVEL_PADRAO,
): Promise<VerdashSession | null> {
  // A primeira, e não `.maybeSingle()`: com dois números na organização o
  // `maybeSingle` devolve ERRO e `data` nulo — a tela dizia "não conectado" com dois
  // canais no ar, e quem reconectava por cima ganhava um canal novo por engano.
  const sessoes = await listVerdashSessions(admin, organizationId, canal);
  return sessoes.find((s) => !s.archivedAt) ?? sessoes[0] ?? null;
}

/**
 * TODAS as sessões deste canal na organização, a mais antiga primeiro.
 *
 * Uma organização pode ter vários números: a loja com o número de vendas e o do
 * pós-venda, a clínica com um por unidade. Até 25/09/2026 a conexão supunha um só, e
 * conectar o segundo SOBRESCREVIA o primeiro (ver `escolherSessaoDoNumero`).
 */
export async function listVerdashSessions(
  admin: SupabaseClient,
  organizationId: string,
  canal: CanalPareavel = CANAL_PAREAVEL_PADRAO,
): Promise<VerdashSession[]> {
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", canal)
      .order("created_at", { ascending: true });

  const { data } = await queryTolerantToMissingArchived(
    () => buscar(`${COLUNAS}, ${ARCHIVED_AT}`),
    () => buscar(COLUNAS),
  );
  const linhas = Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
  return linhas.map((l) => toVerdashSession(l)).filter((s): s is VerdashSession => s !== null);
}

/**
 * Qual canal existente é ESTE número — ou nenhum, e aí o canal é novo.
 *
 * A pergunta só pode ser feita DEPOIS de saber de qual número o token (ou o código)
 * é. Antes, a conexão escolhia "o canal desta organização" e atualizava aquele: o
 * segundo número trocava token, telefone e segredo do primeiro, e o primeiro seguia
 * entregando no mesmo endereço com o segredo antigo, recusado em toda mensagem.
 *
 * Pela instância primeiro, que é a identidade da linha. Pelo telefone depois: a
 * instância recriada lá fora com outro nome é o MESMO número, e dois canais com o
 * mesmo telefone violariam `channel_sessions_phone_per_org_unique`.
 */
export function escolherSessaoDoNumero(
  sessoes: ReadonlyArray<VerdashSession>,
  numero: { instanceName: string; phoneNumber: string | null },
): VerdashSession | null {
  // Ativa antes de arquivada: ressuscitar a arquivada com uma ativa do mesmo
  // telefone ao lado bateria no índice parcial de telefone (500 cru na tela).
  // Nativa ARQUIVADA nunca volta como vinculada: ressuscitá-la com token/código
  // trocaria a credencial e orfanaria a instância do FZAP. A ativa é devolvida e
  // quem chama recusa (`ehTrocaDeOrigem`).
  const candidatas = sessoes.filter((s) => !(s.origem === "nativa" && s.archivedAt));
  const ativasPrimeiro = [...candidatas].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
  const pelaInstancia = ativasPrimeiro.find((s) => s.instanceName === numero.instanceName);
  if (pelaInstancia) return pelaInstancia;
  if (!numero.phoneNumber) return null;
  return ativasPrimeiro.find((s) => s.phoneNumber === numero.phoneNumber) ?? null;
}

/**
 * A linha escolhida é uma instância NATIVA? Vincular token/código por cima dela
 * sobrescreveria a credencial e deixaria a instância do FZAP órfã: a rota recusa (409).
 */
export function ehTrocaDeOrigem(existente: Pick<VerdashSession, "origem"> | null): boolean {
  return existente?.origem === "nativa";
}

/**
 * O número já está conectado em OUTRA organização desta instalação?
 *
 * É o que o índice `channel_sessions_verdash_instance_unique` recusa. O erro cru do
 * banco virava 500 "duplicate key" na tela; a pessoa precisa ler o motivo.
 */
export function numeroEmOutraOrganizacao(erro: string | null): boolean {
  return !!erro && erro.includes("channel_sessions_verdash_instance_unique");
}

/**
 * O telefone já é um canal DESTA organização, por outra instância que a escolha não
 * reconheceu (grafia do telefone diferente entre os dois modos de conexão, por
 * exemplo). Recusado pelo índice `channel_sessions_phone_per_org_unique`.
 */
export function numeroJaEhCanalDaOrganizacao(erro: string | null): boolean {
  return !!erro && erro.includes("channel_sessions_phone_per_org_unique");
}

/**
 * Grava (ou ressuscita) a sessão.
 *
 * `archived_at: null` sempre: reconectar por cima de um canal excluído precisa
 * trazê-lo de volta. Sem isso o update deixaria a coluna no lugar e o canal
 * "conectado" ficaria invisível para o webhook, o envio e os seletores — todos
 * filtrados por ela.
 */
export async function saveVerdashSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    instanceName: string;
    /** Só no modo pareado. `null` mantém o canal no modo direto. */
    vinculoId?: string | null;
    tokenEncrypted: string;
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
    connected: boolean;
    /**
     * Qual canal este vínculo cobre. Sem isto, vincular é tudo ou nada.
     *
     * Ausente = WhatsApp, que é o que todo chamador existente quis dizer antes de haver
     * dois canais — o default preserva cada um deles sem precisar tocá-los.
     */
    canal?: CanalPareavel;
    /** Só o caminho nativo informa. Ausente = a coluna NÃO é tocada (vinculada é o default do banco). */
    origem?: "nativa";
    /** Só o caminho nativo informa (id do FZAP). Ausente = o metadata existente não é tocado. */
    metadata?: Record<string, unknown>;
  },
): Promise<{ error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: input.canal ?? CANAL_PAREAVEL_PADRAO,
    verdash_instance_name: input.instanceName,
    // O `?? null` NÃO é defensividade — é o que mantém modo e credencial
    // coerentes. `verdash_vinculo_id` é o que faz `checkHealth` e
    // `verdashEnviar` escolherem entre falar com a Verdash e falar com o
    // servidor de WhatsApp, e o token ao lado é de um tipo ou de outro. Quem
    // escrever um sem o outro recria o defeito de 24/09/2026: token de máquina
    // entregue ao FZAP, 401, e a conexão declarada caída enquanto funciona.
    // Este é o único escritor dos dois campos no repositório; mantenha assim.
    verdash_vinculo_id: input.vinculoId ?? null,
    verdash_token_encrypted: input.tokenEncrypted,
    webhook_path_token: input.webhookPathToken,
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    // O Instagram não tem telefone. A coluna é nullable e o unique
    // (organization_id, phone_number) não colide em NULL, então várias contas de
    // Instagram convivem — mas gravar um telefone aqui faria a sessão do Instagram
    // disputar a unicidade com a do WhatsApp da mesma organização.
    phone_number: (input.canal ?? CANAL_PAREAVEL_PADRAO) === CHANNEL_PROVIDER_INSTAGRAM
      ? null
      : input.phoneNumber,
    display_name: input.displayName,
    // O status é o que a Verdash ACABOU de dizer, não um otimismo. Uma
    // instância criada e ainda não pareada nasce `STARTING`, e a tela mostra
    // isso em vez de prometer um canal que ainda não fala.
    status: input.connected ? "WORKING" : "STARTING",
    archived_at: null,
    ...(input.origem ? { verdash_origem: input.origem } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  // `organization_id` no UPDATE também: é service role, e o id sozinho confiaria em
  // quem o escolheu. Hoje ele sai de uma lista já filtrada pela organização; a
  // doutrina pede o filtro aqui do mesmo jeito.
  const { error } = input.existingId
    ? await admin
        .from("channel_sessions")
        .update(linha)
        .eq("id", input.existingId)
        .eq("organization_id", input.organizationId)
    : await admin
        .from("channel_sessions")
        .insert({ metadata: metadataInicialDoCanal(), ...linha });

  return { error: error?.message ?? null };
}
