"use client";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { roleAtLeast } from "@/lib/auth/types";
import { useBulkConversations, type AcaoEmLote } from "@/hooks/inbox/useBulkConversations";
import { useSelecaoEmLote } from "@/hooks/inbox/useSelecaoEmLote";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useEncerrarComDesfazer } from "@/hooks/inbox/useEncerrarComDesfazer";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { BarraDeAcoesEmLote } from "./BarraDeAcoesEmLote";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { PainelDaConversa } from "./PainelDaConversa";
import { CampoDeBuscaNaConversa } from "./CampoDeBuscaNaConversa";
import { useFerramentasDaConversa } from "@/hooks/inbox/useFerramentasDaConversa";
import { BotaoIniciarConversa } from "./PainelIniciarConversa";
import { CRMSidePanel } from "./CRMSidePanel";
import { escutar, pedir } from "@/lib/ui/comandos-da-tela";
import { PegadorDeColuna } from "./colunas/PegadorDeColuna";
import { useLargurasDasColunas } from "./colunas/useLargurasDasColunas";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";
import { useAtalhosPessoais } from "@/hooks/inbox/useAtalhosPessoais";

import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { EncaminharDialog } from "./EncaminharDialog";
import { useEncaminharMensagem } from "@/hooks/inbox/useEncaminharMensagem";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
// ADR-05: ícone de feature sai do mapa canônico, nunca do pacote direto.
import { CaretLeft, ChatCircle } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { BarraDaConversaNoCelular, FaixaDoLead } from "@/components/mobile/telas/ConversaAberta";
import { FichaDoLeadNoCelular } from "@/components/mobile/telas/FichaDoLead";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import { MenuDaConversa } from "./menu/MenuDaConversa";
import { useMenuDaConversa } from "./menu/useMenuDaConversa";
import { cn } from "@/lib/utils";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { escolhaDaUrl } from "@/lib/inbox/filtros-do-atendimento";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { useListaCompacta } from "@/hooks/ui/useListaCompacta";
import { useFiltroLembrado } from "@/hooks/inbox/useFiltroLembrado";
import { aplicarFiltroSalvo } from "./filtros/FiltrosSalvos";

/**
 * QUAL COLUNA APARECE NO CELULAR — as duas saem da MESMA pergunta.
 *
 * Abaixo de 760px (o corte do app de celular, `mb:`/`largo:` no globals.css; não o
 * `md` de 768) só cabe uma coluna por vez, então a lista e a conversa se
 * alternam. O defeito que esta função existe para tornar impossível é as duas
 * decidirem por dados DIFERENTES: a lista somia com `selectedId` (o id) e a
 * conversa aparecia com `selectedConversation` (o objeto já carregado). Entre
 * uma coisa e a outra existe uma janela em que nenhuma das duas aparece — e
 * essa janela tem dois casos reais no telefone:
 *
 *   1. o deep-link `/inbox/<id>`, enquanto a busca única ainda responde;
 *   2. a conversa fora do acesso, que é estado PERMANENTE — e cuja mensagem
 *      ("Conversa não encontrada") ficava escondida junto, deixando o dono
 *      numa tela branca sem nem o botão de voltar.
 *
 * Com uma pergunta só, "as duas escondidas" deixa de ser representável.
 * `largo:flex` em ambas: de 760px para cima as duas colunas convivem e a regra não vale.
 */
export function colunasDoCelular(temSelecao: boolean): { lista: string; conversa: string } {
  return {
    lista: temSelecao ? "hidden largo:flex" : "flex",
    conversa: temSelecao ? "flex" : "hidden largo:flex",
  };
}

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(
  tab: InboxFiltersValue["tab"],
  automaticoDaOrg?: boolean,
): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      // A FILA PERGUNTA POR QUEM MANDA, NÃO POR STATUS.
      //
      // Antes ela pedia `assigned_to=unassigned` + os dois estados de espera. Só
      // que "sem dono e aberta" é também a conversa que o robô está atendendo
      // agora — medido na VPS em 2026-08-30, a aba dizia 83 e 47 daquelas tinham
      // o automático no comando. O atendente abria a Fila e via como trabalho
      // dele quase tudo que já estava sendo respondido.
      //
      // `comandosDaFila` é quem cruza isso com o fato org-wide: numa instalação
      // sem nenhum agente no ar, `automatico` também é "esperando gente".
      return { comando: comandosDaFila(automaticoDaOrg) };
    case "mine":
      // Sem `exclude_finished` a aba mostra tudo que o atendente JÁ atendeu —
      // `Fechar` muda o status mas não solta o dono (de propósito: quem atendeu
      // é histórico). O lugar de "minhas fechadas" é a aba Fechadas.
      return { assigned_to: "me", exclude_finished: true };
    case "closed":
      return { status: "closed" };
    case "archived":
      // O ARQUIVO É UM ESTADO SÓ ELE, não `in(terminais)`.
      //
      // `CONVERSATION_TERMINAL_STATUSES` responde outra pergunta ("o que sai do
      // fluxo vivo", usada pelo `exclude_finished` de Minhas). Reaproveitá-la
      // aqui faria a aba Arquivadas listar também as fechadas — duas abas com a
      // mesma lista e badges diferentes, que é a mentira de tela que o mapa
      // abaixo existe para impedir.
      return { status: "archived" };
    case "ai":
      // `ai_handling` é escrito por UM caminho só em produção (a volta pelo botão
      // "Devolver à IA"), então a aba vivia mostrando 2 enquanto o robô
      // atendia 47. Agora ela pergunta a régua do MOTOR.
      return { comando: ["automatico"] };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "archived", "ai"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
  /** Rascunho sugerido por integração (issue #1611) — `null` é o caso comum. */
  rascunho?: AvisoDeRascunho | null;
}

export function InboxLayout({
  initialSelectedId = null,
  rascunho = null,
}: InboxLayoutProps = {}) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const supportReadonly = user.support?.access_mode === "support_readonly";
  const [listaCompacta] = useListaCompacta(user?.id);
  const orgId = activeOrg?.orgId ?? null;

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));
  const idNaUrl = searchParams.get("id");
  /**
   * `?tag=` é o destino do link de cada linha do relatório Por etiqueta
   * (#1891): a lista nasce filtrada pelo marcador escolhido lá. Sem esta
   * leitura o link abriria o Inbox SEM filtrar nada — um link que promete
   * conversa e entrega caixa de entrada inteira.
   *
   * Uma etiqueta só: o filtro de VÁRIAS (#1886) é o da própria tela, e uma
   * query repetida aqui não teria como distinguir E de OU no seletor.
   */
  const tagNaUrl = searchParams.get("tag");

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão —
  // exceto a etiqueta, que entra UMA vez, na abertura, pela URL.
  // `?sem_passo=1` é a porta da busca (Ctrl K) vinda de outra tela: "Só
  // conversas sem próximo passo" abre a Inbox já filtrada.
  // `?busca=` vem do "Ver todas na lista" da busca do celular: o termo vira o filtro.
  const buscaNaUrl = searchParams.get("busca");
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: buscaNaUrl ?? "",
    onlyUnread: false,
    onlyGroups: false,
    semPasso: searchParams.get("sem_passo") === "1",
    // 9051: funil, etapas, responsável e período também chegam por link.
    atendimento: escolhaDaUrl(new URLSearchParams(searchParams.toString())),
    ...(tagNaUrl ? { tag: tagNaUrl } : {}),
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  // O filtro de ontem volta ao reabrir o Inbox sem filtro na URL (por atendente).
  useFiltroLembrado(user?.id, orgId, aux, (f) =>
    setAux((a) => {
      const { tab: _t, ...rest } = aplicarFiltroSalvo({ tab, ...a }, f);
      return rest;
    }),
  );
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        // History API, e não `router.replace`: o replace do router pede um
        // novo payload RSC ao servidor (uma ida e volta inteira, ~200 ms do
        // Brasil) para uma página cujo servidor nem lê `?filter=`. O Next
        // sincroniza `useSearchParams` com `replaceState`, então a aba muda na
        // hora e o link continua compartilhável com o filtro.
        window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, pathname],
  );

  // A busca que chega com a Inbox já aberta (de novo pelo "Ver todas na lista").
  const ultimaBusca = useRef(buscaNaUrl);
  useEffect(() => {
    if (buscaNaUrl === null || buscaNaUrl === ultimaBusca.current) return;
    ultimaBusca.current = buscaNaUrl;
    setAux((a) => ({ ...a, search: buscaNaUrl }));
  }, [buscaNaUrl]);

  // Desliga só os AUXILIARES e mantém a aba: a aba é onde a pessoa está, e
  // limpá-la junto a tiraria do lugar sem ela ter pedido.
  const limparFiltrosAuxiliares = useCallback(() => {
    setFilterValue({ tab, search: "", onlyUnread: false, onlyGroups: false, semPasso: false });
  }, [tab, setFilterValue]);

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? idNaUrl);
  const ultimoIdNaUrl = useRef(idNaUrl);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  /** A ficha do contato como painel deslizante — só existe abaixo do `xl`. */
  const [fichaAberta, setFichaAberta] = useState(false);
  // Busca nas mensagens (#1793) e coluna do lead: ver `useFerramentasDaConversa`.
  const ferramentas = useFerramentasDaConversa(selectedId);
  // Celular (M2.3): o ⋮ da barra da conversa abre o menu da conversa, com o lead primeiro.
  const celular = useEhCelular();
  const menuDoCelular = useMenuDaConversa();
  // "Criar próximo passo" da busca (Ctrl K): o painel do lead precisa estar à
  // vista (coluna a partir de 1280px, gaveta abaixo disso) antes de rolar até
  // a seção. O pedido ao painel sai no quadro seguinte, quando ele já montou.
  const { abrirPainel } = ferramentas;
  useEffect(
    () =>
      escutar("proximo-passo", () => {
        if (window.matchMedia("(min-width: 1280px)").matches) abrirPainel();
        else setFichaAberta(true);
        requestAnimationFrame(() => pedir("painel-proximo-passo"));
      }),
    [abrirPainel],
  );
  // A mesma ação da busca com a Inbox já aberta: liga o filtro sem recarregar.
  useEffect(() => escutar("so-sem-passo", () => setAux((a) => ({ ...a, semPasso: true }))), []);
  // Colunas reguláveis a partir de 1280px (quadro DS, Layout da Inbox): as
  // larguras viram variáveis CSS no cartão, e os pegadores as mudam. A escolha
  // é guardada por atendente (localStorage com o id; não há tabela de preferências).
  const colunasRegulaveis = useLargurasDasColunas(user?.id);
  const cartaoRef = useRef<HTMLDivElement>(null);
  /**
   * A mensagem escolhida para ENCAMINHAR (#2835). Quem escolhe é o fio (dentro
   * do `PainelDaConversa`) e quem mostra o destino é o diálogo daqui, que tem a
   * lista de conversas. `null` = diálogo fechado.
   */
  const [encaminhando, setEncaminhando] = useState<ConversationMensagem | null>(null);
  /**
   * O rascunho sugerido (#1611) vale para a conversa da URL e só enquanto ela
   * está aberta: sair dela — clique, atalho ou voltar do navegador — o descarta
   * de vez. Sem isto o texto escrito para um cliente ficava no campo do próximo,
   * já sem a faixa de origem. Ajuste de estado durante o render, o padrão do
   * React para "estado que depende de outro estado".
   */
  const [rascunhoVivo, setRascunhoVivo] = useState(rascunho);
  if (rascunhoVivo && selectedId !== rascunhoVivo.conversationId) setRascunhoVivo(null);

  useEffect(() => {
    if (ultimoIdNaUrl.current === idNaUrl) return;
    ultimoIdNaUrl.current = idNaUrl;
    // O histórico do navegador também troca a conversa, sem carregar a página inteira.
    setSelectedId(idNaUrl);
    setEncaminhando(null);
  }, [idNaUrl]);

  /**
   * A ORG tem automático de pé? Sobe para cá porque agora é a ABA que precisa —
   * `ConversationList` e `ConversationHeader` continuam lendo o mesmo hook, e o
   * react-query dedupa: segue sendo uma requisição só.
   *
   * `undefined` enquanto carrega, e `comandosDaFila` trata isso como "assume que
   * há" — a mesma convenção da regra. Numa org SEM automático a Fila nasce menor
   * e completa quando a resposta chega; a janela é de ~200ms e o rótulo nunca
   * discorda do filtro, porque os dois usam a mesma convenção.
   */
  const { data: automaticoDaOrg, isLoading: automaticoCarregando } = useAutomaticoAtivo();
  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab, automaticoDaOrg),
      // A tela NÃO pede o que a rota recusa: o hook trata falha com
      // `showApiError`, então digitar a primeira letra de qualquer busca faria
      // piscar um erro na cara de quem digita. A regra é a MESMA que o schema
      // usa (`lib/inbox/termo-de-busca.ts`) — nunca repetida aqui.
      search: buscaValeConsulta(filterValue.search)
        ? filterValue.search
        : undefined,
      channel_session_id: filterValue.channel_session_id,
      entrada: filterValue.entrada,
      tag: filterValue.tag,
      tagMode: filterValue.tagMode,
      unread: filterValue.onlyUnread || undefined,
      is_group: filterValue.onlyGroups || undefined,
      sem_passo: filterValue.semPasso || undefined,
      canal: filterValue.canal,
      atendimento: filterValue.atendimento,
    }),
    [
      filterValue.tab,
      automaticoDaOrg,
      filterValue.search,
      filterValue.channel_session_id,
      filterValue.entrada,
      filterValue.tag,
      filterValue.tagMode,
      filterValue.onlyUnread,
      filterValue.onlyGroups,
      filterValue.semPasso,
      filterValue.canal,
      filterValue.atendimento,
    ],
  );


  /**
   * A FILA ESPERA O FATO DA ORG — E CONSULTA UMA VEZ SÓ (#2365).
   *
   * Só a aba Fila depende do fato org-wide: `comandosDaFila` devolve
   * `aguardando,automatico` numa org SEM automático (sem robô, essas conversas
   * também esperam gente) e `aguardando` numa org com. Enquanto o fato não
   * chegou, `undefined` vale "assume que há" — e era essa suposição que saía
   * como PRIMEIRA busca da lista: com o automático desligado, a resposta trocava
   * a chave e o react-query abria uma segunda query, DESCARTANDO a primeira
   * (trace do #2360: `comando=aguardando` 1091ms + `comando=aguardando,automatico`
   * 896ms, duas voltas de rede pela mesma lista).
   *
   * Segurar a Fila até o fato chegar é o preço de UMA requisição: a pergunta já
   * é feita pela tela de qualquer jeito (o `ConversationList` e o cabeçalho leem
   * o mesmo hook, deduplicado), e o esqueleto cobre a espera — nunca a caixa
   * vazia, porque `isPending` também é verdadeiro com a consulta segurada (ver
   * `ConversationList`). Nas outras abas o filtro não depende do fato e a lista
   * continua consultando na hora.
   *
   * Falha ou permissão ausente não travam a tela: aí `isLoading` é falso, a
   * consulta sai com a convenção de sempre e nada fica esperando para sempre.
   */
  const filaEsperaOFatoDaOrg = filterValue.tab === "unassigned" && automaticoCarregando;

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId, !filaEsperaOFatoDaOrg);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  //
  // ⚠️ ELA NÃO ESPERA A LISTA — e a espera custava DUAS voltas de rede inteiras.
  //
  // A condição tinha um terceiro termo, `&& !listQ.isLoading`, para poupar uma
  // requisição quando a conversa fosse aparecer na lista de qualquer jeito. O
  // preço real, medido no trace do CI (run 34226618108, deep-link para uma
  // conversa FECHADA — que nenhuma aba da Fila devolve, então a busca única é a
  // única fonte do objeto):
  //
  //   46.725  GET conversations?comando=aguardando               1091ms
  //   48.275  GET conversations?comando=aguardando,automatico     896ms
  //   49.183  GET conversations/<id>                              565ms
  //   49.775  GET contacts/<id>/crm-summary                    (>1034ms)
  //
  // São QUATRO idas em série depois do documento. A lista é pedida duas vezes
  // porque a `queryKey` muda quando `useAutomaticoAtivo` responde (ver
  // `comandosDaFila`), e `isLoading` volta a ser verdadeiro na chave nova — ou
  // seja, o gate segurava a busca única até a SEGUNDA lista assentar, e só
  // então o painel do contato podia começar a carregar. O painel do contato
  // aparecia ~4,7s depois da navegação, e é assim que `encerramento-atendimento`
  // ficou intermitente: a Memória do contato chegava ~0,1–0,6s DEPOIS dos 5s da
  // asserção (o screenshot de falha, tirado logo em seguida, já a mostra).
  //
  // Sem o gate, a busca única sai na primeira leva, em paralelo com a lista, e o
  // objeto existe uma volta depois do documento em vez de três. O custo é UMA
  // requisição extra por deep-link cuja conversa acabe aparecendo na lista —
  // clicar numa conversa da lista já carregada continua sem pedir nada, porque
  // aí `inList` já a tem no primeiro render.
  const needsFetch = !!selectedId && !inList;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const colunas = colunasDoCelular(Boolean(selectedId));

  const claim = useClaimConversation();
  const encerrar = useEncerrarComDesfazer();

  // LOTE (#2484, F1): a seleção múltipla e a barra de ações da Inbox. A
  // permissão de ESCRITA continua sendo a do `usePermission` — quem tem
  // `inbox.reply` pode marcar e agir em lote; para o `viewer` a seleção nem
  // aparece. (A rota ainda valida por conta própria: este portão é de tela,
  // a fonte da regra é a API.)
  const podeAgirEmLote = usePermission("inbox.reply");
  // O mesmo critério da rota `usable-for-rag` (#3006), como no CRMSidePanel.
  const podeMarcarExemplo =
    (user.is_platform_admin && !user.support) || roleAtLeast(activeOrg?.role, "agent");
  const selecao = useSelecaoEmLote();
  // Encaminhar (#2835): a execução reusa o caminho de envio do Inbox (ver o hook).
  const encaminhar = useEncaminharMensagem();
  // As conversas já carregadas são o universo de destinos, sem busca nova.
  const conversasDaLista = useMemo(
    () => listQ.data?.pages.flatMap((p) => p.data) ?? [],
    [listQ.data],
  );
  const lote = useBulkConversations();

  const rodarLote = useCallback(
    (action: AcaoEmLote, toUserId?: string, reason?: string) => {
      const ids = Array.from(selecao.selecionados);
      if (ids.length === 0) return;
      lote.mutate(
        { ids, action, to_user_id: toUserId, reason },
        {
          // A seleção é limpa depois do lote, aconteça o que acontecer:
          // manter marcadas as conversas recusadas (de outra organização,
          // inexistentes) deixaria a barra no lugar mensageando um lote que
          // não existe mais.
          onSuccess: () => selecao.limpar(),
        },
      );
    },
    [lote, selecao],
  );

  // A leitura da conversa aberta é do upstream e fica: sem ela o contador de
  // não-lidas nunca zera para quem abre a conversa.
  useMarkAsRead(
    selectedConversation?.id ?? null,
    selectedConversation?.unread_count_for_assignee ?? 0,
    selectedConversation?.marked_unread ?? false,
  );
  const atalhosPessoais = useAtalhosPessoais(selectedConversation, supportReadonly);

  // Aceita `null`: é o VOLTAR do celular, que limpa a seleção e devolve a lista.
  // É um SUPERCONJUNTO do `handleSelect` do upstream — o tipo dele não aceita
  // `null`, e sem isso o botão de voltar não teria o que chamar.
  //
  // A citação ("responder em cima") mora no `PainelDaConversa`, montado com
  // `key` da conversa: trocar de seleção o desmonta e zera a citação — sem isso
  // a resposta sairia citando mensagem de outro cliente.
  const handleSelect = useCallback((id: string | null) => {
    if (id === selectedId) return;
    setSelectedId(id);
    // O destino do encaminhamento não pode sobreviver à troca de conversa.
    setEncaminhando(null);
    // ?id= é o formato já usado pelos atalhos do CRM. A History API mantém a
    // seleção instantânea sem pedir um novo Server Component a cada clique.
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("id", id);
    else params.delete("id");
    // O ?rascunho= é da conversa que ficou para trás (ver `rascunhoVivo`).
    params.delete("rascunho");
    const query = params.toString();
    window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname);
  }, [selectedId, searchParams, pathname]);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  // "e": fecha na hora, com "Desfazer" no aviso (quadro DS).
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    encerrar.fechar(selectedConversation);
  }, [encerrar, selectedConversation]);

  // Altura da grade: a conta desconta TUDO que fica acima e abaixo dela.
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //   2 * --space-6     padding do <main> do AppShell (`p-6`, em cima e embaixo)
  //
  // Com `100vh-3.5rem` o padding ficava de fora e a grade media 48px a MAIS que a
  // tela. Quem pagava a diferença era o composer, que fica no rodapé: nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // As duas parcelas NÃO estão na mesma unidade, e por isso o padding entra pelo
  // token e não como `3rem`: o `@theme inline` de `app/globals.css` remapeia a
  // escala de spacing para `var(--space-N)` — `--space-6` é `24px` LITERAL —, mas
  // não remapeia o `14`, que o Tailwind 4 calcula pelo multiplicador `--spacing`
  // e segue sendo `3.5rem` de verdade. (Até o Tailwind 4 quem remapeava era o
  // `tailwind.config.ts`; o arquivo não existe mais, o efeito é o mesmo.)
  // Escrever a soma como
  // `6.5rem` só acerta enquanto a raiz for 16px; com acessibilidade de fonte maior
  // ou menor o composer sai da tela de novo. Pelo token, a conta se auto-corrige
  // se a escala de espaçamento mudar.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.

  // TRÊS COLUNAS, nas medidas do quadro DS ("Layout da Inbox").
  //
  // De 1280px para cima: lista 340, conversa fluida e lead 352, com os
  // pegadores. A Inbox começa com a 2ª coluna da navegação recolhida (trilho de
  // 72px), e as medidas cabem: em 1280 sobram 1280 - 72 - 8 = 1200, e a conversa
  // fica com 508. Se o atendente FIXAR o menu (304px) e faltar espaço, a LISTA
  // encolhe primeiro, até 280, para a conversa não ficar abaixo de 420; só depois
  // disso a conversa cede. É o `max(280px, min(lista, 100% - 420px - lead))`
  // da trilha do grid (os pegadores usam a mesma conta, `PegadorDeColuna`).
  // De 1024 a 1279 o lead vira gaveta sobre a conversa (`drawer`).
  return (
    <OpenConversationProvider conversationId={selectedId}>
    <div
      className={cn(
        // A altura é o resto EXATO da tela: topo de 56px (`3.5rem`) e o respiro
        // de baixo do `<main>` na Inbox: `--respiro-do-main`, publicado pelo
        // próprio `<main>` quando há painel de chamada (a mesma conta do padding
        // dele), e o `pb-2` (`--space-2`) quando não há. Sem respiro em cima: o cartão encosta no
        // topo e na barra lateral, como o `.work` do protótipo.
        "relative grid h-[calc(100dvh-3.5rem-var(--respiro-do-main,max(var(--space-2),var(--rodape-ocupado,0px))))] w-full grid-cols-1 overflow-hidden rounded-xl border border-border bg-surface pele-cartao largo:grid-cols-[300px_minmax(0,1fr)]",
        // No celular a altura sai da casca do app: o topo que está na tela (nenhum com
        // a conversa aberta, que tem barra própria) e o respiro de baixo do `<main>`,
        // que no celular já soma a barra inferior e a área segura. Com painel de chamada
        // é o `--respiro-do-main` publicado pelo `<main>` (a mesma conta do padding dele,
        // `estiloDaReserva`); sem, a barra mais o maior entre o `pb-2` e o rodapé. E o
        // teclado do iPhone (`--mb-teclado`, `useAlturaDoTeclado`), para o composer subir.
        "mb:h-[calc(100dvh-var(--mb-casca-topo)-var(--mb-teclado,0px)-var(--respiro-do-main,calc(var(--mb-casca-baixo)+max(var(--space-2),var(--rodape-ocupado,0px)))))]",
        ferramentas.painelLead
          ? "xl:grid-cols-[max(280px,min(var(--largura-da-lista),calc(100%-420px-var(--largura-do-painel))))_minmax(0,1fr)_var(--largura-do-painel)]"
          : "xl:grid-cols-[max(280px,min(var(--largura-da-lista),calc(100%-420px)))_minmax(0,1fr)]",
      )}
      ref={cartaoRef}
      style={
        {
          "--largura-da-lista": `${colunasRegulaveis.larguras.lista}px`,
          "--largura-do-painel": `${colunasRegulaveis.larguras.painel}px`,
        } as CSSProperties
      }
      /*
       * O ESTADO DO TEMPO REAL, LEGÍVEL DE FORA — mesmo par que o dossiê do lead
       * já publica (`LeadDossier`), e pela mesma razão: quando a entrega morre,
       * nenhuma tela avisa. Foi o único achado que atravessou o dia intacto
       * quando o realtime quebrou pela primeira vez, e voltou a morder agora.
       *
       * `divergencias` é o que a rede de segurança contou: refetch trouxe estado
       * novo que o canal NÃO tinha entregue. Zero com o canal vivo; subindo é a
       * assinatura de canal que assina e não entrega — o defeito que não grita.
       *
       * ⚠️ `data-realtime-status` vem do STATUS do canal, não de um objeto que
       * existe sempre. A primeira versão desta linha derivava o valor de
       * `listQ.seguranca`, que nunca é nulo — ela diria `ativo` inclusive com o
       * canal morto. Controle decorativo é pior que controle nenhum: mente com
       * cara de instrumento.
       *
       * Atributo de dado e não texto na tela de propósito: quem lê isto é o
       * teste e quem depura, não o atendente. Pôr um aviso permanente na cara de
       * quem atende seria ruído; esconder o sinal do todo é o que custou o dia.
       */
      data-realtime-status={listQ.realtimeStatus}
      data-refetch-divergencias={listQ.seguranca?.divergencias ?? 0}
    >
      {/*
        NO CELULAR, UMA COISA POR VEZ.

        Antes as duas colunas caíam empilhadas em `grid-cols-1`: a lista inteira
        primeiro e a conversa DEPOIS dela. Para responder era preciso rolar a
        lista toda até o fim, e o composer ficava fora da tela — que é o
        "incômodo" relatado por quem atende do telefone.

        Sem media query em JavaScript de propósito: `useMediaQuery` decide DEPOIS
        da hidratação, então a primeira pintura mostra o layout errado e pisca. A
        classe condicional é resolvida pelo CSS, na primeira pintura, e some no
        `md` — onde as duas colunas cabem juntas e a regra não se aplica.
      */}
      <div
        className={cn(
          "pele-ruido h-full min-h-0 flex-col border-r border-border largo:flex",
          colunas.lista,
        )}
      >
        <BotaoIniciarConversa />
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        {podeAgirEmLote && (
          <BarraDeAcoesEmLote
            quantidade={selecao.quantidade}
            pendente={lote.isPending}
            onFechar={() => rodarLote("close")}
            onArquivar={() => rodarLote("archive")}
            onMarcarComoLida={() => rodarLote("mark-read")}
            onPausarIa={() => rodarLote("pause-ai")}
            onDevolverAoAutomatico={() => rodarLote("reactivate-bot")}
            onTransferir={(toUserId, reason) => rodarLote("transfer", toUserId, reason)}
            onLimpar={selecao.limpar}
          />
        )}
        {/* Modo compacto (quadro DS): a linha da lista com 8px, por atendente. */}
        <div className="min-h-0 flex-1 overflow-hidden" data-densidade={listaCompacta ? "compacta" : undefined}>
          <ConversationList
            listQuery={listQ}
            filters={filters}
            selectedId={selectedId}
            onSelect={handleSelect}
            onVisibleChange={handleVisibleChange}
            onLimparFiltros={limparFiltrosAuxiliares}
            selecionados={selecao.selecionados}
            onAlternarSelecao={podeAgirEmLote ? selecao.alternar : undefined}
            onSelecionarTodosVisiveis={
              podeAgirEmLote
                ? () =>
                    selecao.selecionarTodos(
                      (listQ.data?.pages.flatMap((p) => p.data) ?? []).map((c) => c.id),
                    )
                : undefined
            }
            podeMarcarExemplo={podeMarcarExemplo}
          />
        </div>
      </div>

      {/*
        AS DUAS COLUNAS DECIDEM PELO MESMO DADO — `selectedId`, não o objeto.

        A da lista some quando há `selectedId`; se esta aparecesse só quando a
        conversa já está CARREGADA, a janela entre as duas coisas não mostra
        nenhuma das colunas. No celular isso é a tela em branco, e ela tem dois
        casos reais: o instante do deep-link `/inbox/<id>`, enquanto a busca
        única ainda responde; e o estado permanente de conversa fora do acesso,
        cuja mensagem ("Conversa não encontrada") é justamente o que ficava
        escondido — deixando o dono numa tela vazia, sem sequer o botão de
        voltar, porque ele morava dentro do ramo da conversa carregada.
      */}
      <div
        className={cn(
          "h-full min-h-0 min-w-0 flex-col largo:flex",
          colunas.conversa,
        )}
      >
        {/*
          A barra do celular vive FORA do ramo da conversa carregada: o caminho
          de volta tem de existir inclusive quando não há o que mostrar — é aí
          que ele é a única saída. A porta da ficha, essa sim, depende da
          conversa, e só aparece quando há uma.
        */}
        {selectedId && !selectedConversation && (
          <div className="flex items-center gap-1 border-b border-border px-1 py-1 largo:hidden">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1 px-2"
              onClick={() => handleSelect(null)}
            >
              <CaretLeft size={16} />
              {t("Conversas")}
            </Button>
          </div>
        )}
        {selectedConversation && (
          <>
            {/* No celular (M2.3): a barra do protótipo (voltar, quem é, Ligar, ⋮) e a
                faixa do negócio; o cabeçalho do desktop some lá (`mb:hidden`). */}
            <BarraDaConversaNoCelular
              conversation={selectedConversation}
              automaticoDaOrg={automaticoDaOrg}
              meuUserId={user?.id ?? null}
              onVoltar={() => handleSelect(null)}
              onAbrirFicha={() => setFichaAberta(true)}
              onAbrirMenu={(el) => menuDoCelular.abrir(selectedConversation.id, el, el)}
            />
            {celular && selectedConversation.contacts?.id && <FaixaDoLead contactId={selectedConversation.contacts.id} />}
            {celular && (
              <MenuDaConversa
                alvo={menuDoCelular.alvo}
                conversation={selectedConversation}
                onFechar={menuDoCelular.fechar}
                meuUserId={user?.id ?? null}
                automaticoDaOrg={automaticoDaOrg}
                selecionada
                leadPrimeiro
              />
            )}
            {/* Celular (M2.4): a ficha em tela cheia; tablet: a gaveta de sempre. */}
            {celular ? (
              <FichaDoLeadNoCelular aberta={fichaAberta} aoMudar={setFichaAberta} conversation={selectedConversation} />
            ) : (
              <Sheet open={fichaAberta} onOpenChange={setFichaAberta}>
                <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto p-0">
                  <SheetTitle className="sr-only">{t("Ficha do contato")}</SheetTitle>
                  <CRMSidePanel conversation={selectedConversation} />
                </SheetContent>
              </Sheet>
            )}
          </>
        )}
        {selectedConversation ? (
          <>
            {/* `key`: trocar de conversa desmonta a confirmação de Fechar/Arquivar
                aberta — senão o clique de dentro agiria sobre a conversa nova. */}
            <ConversationHeader
              key={selectedConversation.id}
              conversation={selectedConversation}
              onAbrirConversa={handleSelect}
              onBuscar={() => ferramentas.alternarBusca(selectedConversation.id)}
              buscaAberta={ferramentas.buscaAberta}
              botaoBuscaRef={ferramentas.botaoBuscaRef}
              painelAberto={ferramentas.painelLead}
              onAlternarPainel={ferramentas.alternarPainel}
              onAbrirFicha={() => setFichaAberta(true)}
            />
            {ferramentas.buscaAberta && (
              <CampoDeBuscaNaConversa
                termo={ferramentas.termoDaBusca}
                onTermo={ferramentas.mudarTermo}
                onFechar={ferramentas.fecharBusca}
              />
            )}
            {/* A conversa e o campo de resposta — a MESMA peça do dossiê do
                negócio no Kanban. Ver `PainelDaConversa`. */}
            <PainelDaConversa
              // Prefixo: o `ConversationHeader` irmão usa o id puro como chave, e
              // duas chaves iguais no mesmo fragmento duplicam o cabeçalho.
              key={`painel:${selectedConversation.id}`}
              ref={composerRef}
              conversation={selectedConversation}
              searchTerm={ferramentas.termoDaBusca}
              onAbrirConversa={handleSelect}
              onEncaminhar={setEncaminhando}
              // O aviso é DA conversa da URL: trocar de conversa dentro da inbox
              // não pode deixar um texto sugerido no campo de outra pessoa.
              rascunho={rascunhoVivo}
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("Conversa não encontrada ou fora do seu acesso.")}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ChatCircle size={36} weight="thin" className="text-text-subtle" aria-hidden />
            {/* E1: o texto do protótipo, e a dica de teclado continua. */}
            <p className="text-sm font-medium text-text-muted">{t("Escolha uma conversa")}</p>
            <p className="text-xs text-text-muted">{t("A fila mostra primeiro quem espera há mais tempo.")}</p>
            <p className="text-xs text-text-subtle">{t("Ou navegue com J e K")}</p>
          </div>
        )}
      </div>

      {ferramentas.painelLead && (
        <div className="hidden h-full min-h-0 min-w-0 xl:block">
          <CRMSidePanel conversation={selectedConversation} />
        </div>
      )}

      {/* Os pegadores das colunas (o `.rz` do protótipo), a partir de 1280px. */}
      <PegadorDeColuna
        coluna="lista"
        larguras={colunasRegulaveis.larguras}
        cartaoRef={cartaoRef}
        comPainel={ferramentas.painelLead}
        mover={colunasRegulaveis.mover}
        confirmar={colunasRegulaveis.confirmar}
        restaurar={colunasRegulaveis.restaurar}
      />
      {ferramentas.painelLead && (
        <PegadorDeColuna
          coluna="painel"
          larguras={colunasRegulaveis.larguras}
          cartaoRef={cartaoRef}
          comPainel
          mover={colunasRegulaveis.mover}
          confirmar={colunasRegulaveis.confirmar}
          restaurar={colunasRegulaveis.restaurar}
        />
      )}
      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={supportReadonly ? () => {} : handleClaim}
        onClose={supportReadonly ? () => {} : handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
        {...atalhosPessoais}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <EncaminharDialog
        open={encaminhando !== null}
        onOpenChange={(aberto) => {
          if (!aberto) {
            setEncaminhando(null);
            // Diálogo fechado, intenção zerada: reabrir depois tem de poder
            // encaminhar de novo, com chave nova.
            encaminhar.limparIntencao();
          }
        }}
        conversas={conversasDaLista}
        conversationIdAtual={selectedConversation?.id ?? null}
        enviando={encaminhar.isPending}
        onEscolher={(destino) => {
          if (!encaminhando) return;
          encaminhar.mutate(
            { id: encaminhando.id, conversationIdDestino: destino },
            { onSuccess: () => setEncaminhando(null) },
          );
        }}
      />
    </div>
    </OpenConversationProvider>
  );
}
