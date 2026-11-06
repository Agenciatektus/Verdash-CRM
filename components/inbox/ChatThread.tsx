"use client";

import { useEffect, useMemo, useRef } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AcoesDoFio } from "./fio/LinhaDaMensagem";
import { ConteudoDaLinha, type ContextoDoFio } from "./fio/ConteudoDaLinha";
import { iniciaBloco, indiceDoDiaAtivo, montarLinhas, type LinhaDoFio } from "./fio/linhas";
import { useIdDaPrimeiraNaoLida, useRolarAteNovas } from "./fio/useDivisorDeNovas";
import { useAncoragemNoFim } from "./fio/useAncoragemNoFim";
import { useLevarAOcorrencia, useResultadosDaBusca } from "./fio/useBuscaNoFio";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { usePassagensDaConversa } from "@/hooks/inbox/usePassagensDaConversa";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useAlterarMensagem } from "@/hooks/inbox/useAlterarMensagem";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { capabilitiesOf, transportaMensagem, type ChannelProvider } from "@/lib/channels/capabilities";
import { montarCartoesDaPassagem, type CartaoDaPassagem } from "@/lib/escalacao/cartao-da-passagem";
import { mensagemSemDado } from "@/lib/inbox/mensagem-sem-dado";
import { separarReacoes } from "@/lib/inbox/reacoes-no-fio";
import type { Message, Note } from "@/lib/types/messaging";
import { useReenvioDoFio } from "./fio/useReenvioDoFio";

interface Props {
  conversationId: string | null;
  searchTerm?: string;
  provider?: string | null;
  /** Escolher uma mensagem para responder. Sobe até o composer. */
  onResponder?: (m: Message) => void;
  /** Escolher uma mensagem para encaminhar a outra conversa (#2835). */
  onEncaminhar?: (m: Message) => void;
  /**
   * Quem é o dono da conversa HOJE, e quem é o contato. O cartão da passagem
   * precisa dos dois para escolher o gesto: sem dono ele convida a assumir; com
   * outro dono ele diz quem atende; e o caminho de opt-out leva à ficha do
   * contato. Opcional: sem a conversa em mãos o cartão cai no estado mais
   * conservador (nenhum convite).
   */
  dono?: { userId: string | null; nome: string | null } | null;
  contatoId?: string | null;
  /**
   * Quantas mensagens o cliente mandou que o dono ainda não leu
   * (`unread_count_for_assignee`). Lido UMA vez, na abertura: abrir a conversa
   * já a marca como lida, e o divisor "Novas mensagens" que dependesse do
   * valor vivo sumiria no instante em que aparece.
   */
  naoLidas?: number;
}

/**
 * Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai
 * ao cliente). A passagem é o TERCEIRO tipo: também não é mensagem, também não
 * vai ao cliente, e entra no fio pelo mesmo mecanismo.
 */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note }
  | { kind: "passagem"; ts: string; data: CartaoDaPassagem };

/** Intercala mensagens, notas e passagens por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(
  messages: Message[],
  notes: Note[],
  // Opcional porque o fio existe desde antes da passagem, e uma conversa que
  // nunca saiu do automático não tem nenhuma.
  passagens: CartaoDaPassagem[] = [],
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
    ...passagens.map((data): ThreadItem => ({ kind: "passagem", ts: data.criadoEm, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante, e a passagem
  // DEPOIS das duas, que é o que aconteceu: ela é consequência da última fala.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

export function ChatThread({ conversationId, provider, onResponder, onEncaminhar, dono, contatoId, searchTerm = "", naoLidas = 0 }: Props) {
  const t = useT();
  const activeOrg = useActiveOrg();
  const q = useMessagesRealtime(conversationId, activeOrg?.orgId ?? null);
  const notes = useConversationNotes(conversationId);
  const passagens = usePassagensDaConversa(conversationId);
  const claim = useClaimConversation();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const { editar, apagar, ocultar, restaurar } = useAlterarMensagem(conversationId);
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const canalAlteraEnviada = transportaMensagem(provider)
    && capabilitiesOf(provider as ChannelProvider).alteraMensagemEnviada;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const { termo, resultados } = useResultadosDaBusca(messages, searchTerm);
  /**
   * As mensagens por id, para resolver a CITADA sem ir ao servidor. Uma
   * consulta por bolha citada seria uma cascata de requisições numa conversa
   * longa; quando a citada ficou fora da página, o fio simplesmente não aparece.
   */
  const porId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // B15: "Tentar de novo" na mensagem de saída que falhou.
  const reenvio = useReenvioDoFio(conversationId ?? null, messages);

  const cartoes: CartaoDaPassagem[] = useMemo(
    () => montarCartoesDaPassagem(passagens, {
      usuarioId: currentUser.id,
      donoId: dono?.userId ?? null,
      donoNome: dono?.nome ?? null,
    }),
    [passagens, currentUser.id, dono?.userId, dono?.nome],
  );
  // Ruído sem dado nenhum não entra no fio (fica no banco e no `porId`).
  // A reação não é balão (#2815): sai do fio e vira marca no balão alvo.
  const { falas, reacoesPorAlvo } = useMemo(() => separarReacoes(messages), [messages]);
  const visiveis = useMemo(() => falas.filter((m) => !mensagemSemDado(m)), [falas]);
  const items: ThreadItem[] = useMemo(() => mergeThreadItems(visiveis, notes, cartoes), [visiveis, notes, cartoes]);
  const paginas = q.data?.pages.length ?? 0;

  /**
   * OS GESTOS DA BOLHA COM IDENTIDADE ESTÁVEL. As bolhas são memoizadas
   * (`LinhaDaMensagem`); se cada render criasse `onEditar={() => …}` novo por
   * bolha, o `memo` nunca acertaria e a chegada de UMA mensagem re-renderizaria
   * todas. O ref guarda a versão mais nova das mutações; o objeto nasce uma vez.
   */
  // Rascunho da edição por id: sobrevive à bolha sair da tela (e desmontar).
  // Ref, não estado: digitar não pode re-renderizar o fio inteiro.
  const rascunhos = useRef(new Map<string, string>());
  const gestos = useRef({ editar, apagar, ocultar, restaurar, onResponder, onEncaminhar });
  gestos.current = { editar, apagar, ocultar, restaurar, onResponder, onEncaminhar };
  const acoes: AcoesDoFio = useMemo(
    () => ({
      responder: (m) => gestos.current.onResponder?.(m),
      encaminhar: (m) => gestos.current.onEncaminhar?.(m),
      editar: (id, text) => gestos.current.editar.mutateAsync({ id, text }).then(() => undefined),
      apagar: (id) => gestos.current.apagar.mutateAsync(id).then(() => undefined),
      ocultar: (id) => gestos.current.ocultar.mutateAsync(id).then(() => undefined),
      restaurar: (id) => gestos.current.restaurar.mutateAsync(id).then(() => undefined),
      lerRascunho: (id) => rascunhos.current.get(id) ?? null,
      gravarRascunho: (id, texto) => {
        if (texto === null) rascunhos.current.delete(id);
        else rascunhos.current.set(id, texto);
      },
    }),
    [],
  );

  /**
   * O FIO É VIRTUALIZADO: só as linhas na tela (mais uma margem) existem no DOM
   * (medido em `tests/unit/fio-virtualizado.test.tsx`).
   *
   * `anchorTo: "end"` é o modo de chat do virtualizador: quando linhas entram
   * ACIMA (o "Carregar mais antigas") ele reancora a leitura pela chave da linha
   * que estava no topo — a posição não pula —, e quando uma bolha da base muda
   * de altura (imagem que carregou, edição) com a leitura no fim, ela continua
   * no fim. Seguir a mensagem NOVA continua sendo decisão de `useAncoragemNoFim`.
   */
  // Congelado na abertura e só para o dono (ver `useIdDaPrimeiraNaoLida`).
  const idDaNaoLida = useIdDaPrimeiraNaoLida({
    conversationId, naoLidas, items, carregado: !q.isLoading && q.data != null,
    leitorEhDono: dono?.userId != null && dono.userId === currentUser.id,
  });
  const linhas: LinhaDoFio[] = useMemo(
    () => montarLinhas(items, Boolean(q.hasNextPage), idDaNaoLida),
    [items, q.hasNextPage, idDaNaoLida],
  );
  const diaAtivo = useRef(-1);
  const virtualizer = useVirtualizer({
    count: linhas.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey: (i) => linhas[i]!.key,
    // Só o chute inicial: cada linha é medida de verdade ao montar. Dia e
    // divisor de novas têm o `pt-4` do visual novo, por isso 40 e não 28.
    estimateSize: (i) => (linhas[i]!.tipo === "item" ? 64 : 40),
    overscan: 8,
    // O `py-2` que o rolador tinha vira margem do próprio virtualizador, para
    // as posições baterem com a altura total.
    paddingStart: 8,
    paddingEnd: 16,
    anchorTo: "end",
    // React 19 avisa quando o virtualizador força `flushSync` dentro do commit.
    useFlushSync: false,
    // O rótulo do dia que vale para o topo da tela fica sempre montado, para
    // poder grudar no topo como o `sticky` de antes (ver o render).
    rangeExtractor: (range) => {
      diaAtivo.current = indiceDoDiaAtivo(linhas, range.startIndex);
      const indices = defaultRangeExtractor(range);
      if (diaAtivo.current >= 0 && !indices.includes(diaAtivo.current)) indices.unshift(diaAtivo.current);
      return indices;
    },
  });

  useLevarAOcorrencia({ termo, resultados, linhas, virtualizer, scrollerRef });
  useEffect(() => {
    rascunhos.current.clear();
  }, [conversationId]);
  useAncoragemNoFim({ conversationId, totalDeItens: items.length, paginas, scrollerRef, bottomRef });
  useRolarAteNovas({ conversationId, linhas, virtualizer, scrollerRef });

  /**
   * O ESTADO DO CANAL DESTE THREAD, PUBLICADO SEMPRE — inclusive quando não há
   * mensagem nenhuma. Na máquina de quem desenvolve a conversa tem histórico; no
   * CI o banco é fresco e a conversa nasce vazia, e um sinal só no caminho de
   * sucesso ficava invisível exatamente onde mais importa. `-status-mensagens`
   * distingue "assinou" de "nem chegou a assinar"; `-divergencias-mensagens`
   * denuncia canal ASSINADO E MUDO (só incrementa quando o refetch traz o que o
   * canal não trouxe).
   */
  const sinalDoCanal = {
    "data-testid": "chat-thread",
    "data-realtime-status-mensagens": q.realtimeStatus,
    "data-refetch-divergencias-mensagens": q.seguranca?.divergencias ?? 0,
  } as const;

  if (!conversationId) {
    return (
      <div {...sinalDoCanal} className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("Selecione uma conversa")}
      </div>
    );
  }
  if (q.isLoading) {
    return (
      <div {...sinalDoCanal} className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-2/3" />)}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div {...sinalDoCanal} className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <p>{t("Erro ao carregar mensagens.")}</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>{t("Tentar novamente")}</Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div {...sinalDoCanal} className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("Nenhuma mensagem nesta conversa.")}
      </div>
    );
  }

  const ctx: ContextoDoFio = {
    carregarMais: () => void q.fetchNextPage(),
    carregandoMais: q.isFetchingNextPage,
    resultados,
    porId,
    debugCitations: Boolean(debugCitations),
    temResponder: Boolean(onResponder),
    temEncaminhar: Boolean(onEncaminhar),
    reacoesPorAlvo,
    usuarioId: currentUser.id,
    canalAlteraEnviada,
    podeGerir: canManage,
    acoes,
    contatoId: contatoId ?? null,
    assumindo: claim.isPending,
    onAssumir: () => {
      if (conversationId) claim.mutate({ conversation_id: conversationId, expected_assignee: dono?.userId ?? null });
    },
    onExcluirNota: (id) => deleteNote.mutate(id),
    ofereceReenvio: reenvio.oferece,
    reenviar: reenvio.reenviar,
  };

  const virtuais = virtualizer.getVirtualItems();
  // O rótulo do dia do topo GRUDA quando a linha dele já passou do topo — o
  // mesmo `sticky top-0` de antes. Ele é renderizado no fluxo (no início do
  // contêiner), não posicionado: é o que deixa o `sticky` funcionar.
  const ativo = virtuais.find((v) => v.index === diaAtivo.current);
  const grudado = ativo != null && ativo.start < (virtualizer.scrollOffset ?? 0);

  return (
    <div {...sinalDoCanal} className="fundo-do-fio flex h-full min-w-0 flex-col">
      {termo && (
        <div className="px-4 py-1 text-xs text-muted-foreground" role="status">
          {t("Resultados nas mensagens carregadas")}: {resultados.size}
        </div>
      )}
      {/* `overflow-anchor: none`: quem segura a posição ao entrar conteúdo acima é
          o virtualizador (`anchorTo: "end"`); a ancoragem do navegador por cima
          dele compensaria duas vezes. */}
      <div ref={scrollerRef} className="trama-do-fio min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtuais.map((v) => {
            const fixo = grudado && v.index === diaAtivo.current;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className={fixo ? "sticky top-0 z-10 w-full" : "absolute left-0 top-0 w-full"}
                style={fixo ? undefined : { transform: `translateY(${v.start}px)` }}
              >
                <ConteudoDaLinha linha={linhas[v.index]!} inicioDoBloco={iniciaBloco(linhas, v.index)} ctx={ctx} />
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
