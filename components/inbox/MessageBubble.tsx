"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft, ArrowBendUpRight, CaretDown, PencilSimple, Robot, Trash } from "@/lib/ui/icons";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Message } from "@/lib/types/messaging";
import { lerRemetenteDeGrupo, rotuloDoRemetente } from "@/lib/messaging/remetente-de-grupo";
import { localizacaoDaMensagem } from "@/lib/messaging/localizacao";
import type { ReacaoNoBalao } from "@/lib/inbox/reacoes-no-fio";
import { lerAnuncioDaMensagem } from "@/lib/leads/atribuicao-de-anuncio";
import { AnuncioCard } from "@/components/inbox/AnuncioCard";
import { extractCitations, isAiGeneratedMessage } from "@/lib/ai/citations/types";
import { larguraDaMeta, rotuloDaAutoria } from "./bolha/autoria";
import { CitacaoNaBolha } from "./bolha/CitacaoNaBolha";
import { ConfirmacoesDaBolha } from "./bolha/ConfirmacoesDaBolha";
import { CorpoDaBolha } from "./bolha/CorpoDaBolha";
import { EditorDaBolha } from "./bolha/EditorDaBolha";
import {
  classesDaBolha,
  classesDaLinha,
  classesDoAutor,
  COLUNA_DA_FALA,
  type ModoDaMeta,
  type TomDaBolha,
} from "./bolha/estilo";
import { MetaDaBolha } from "./bolha/MetaDaBolha";
import { TentarDeNovo } from "./bolha/TentarDeNovo";

interface Props {
  message: Message;
  searchMatch?: boolean;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** Escolher esta mensagem para ENCAMINHAR a outra conversa (#2835). */
  onEncaminhar?: (m: Message) => void;
  /** As reações a ESTA mensagem: marca no canto do balão, nunca balão próprio. */
  reacoes?: ReacaoNoBalao[];
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
  /** QUEM está lendo a conversa: separa "Você" de "Atendente" (ver `rotuloDaAutoria`). */
  viewerUserId?: string | null;
  onEditar?: (text: string) => Promise<void>;
  onApagar?: () => Promise<void>;
  onOcultar?: () => Promise<void>;
  onRestaurar?: () => Promise<void>;
  /**
   * Onde guardar o rascunho da edição fora da bolha (o fio virtualizado
   * desmonta a bolha que sai da tela). Sem ele, o rascunho vive só no estado.
   */
  rascunho?: { ler: () => string | null; gravar: (texto: string | null) => void };
  /**
   * Esta bolha abre um bloco de falas seguidas do mesmo autor (`iniciaBloco`)?
   * O padrão é bolha isolada, que é o que quem monta a bolha fora do fio vê.
   */
  inicioDoBloco?: boolean;
  /** B15: presente só quando a mensagem de saída falhou e pode ser reenviada. */
  onReenviar?: () => void;
}

export function MessageBubble({
  message, searchMatch = false, debugCitations, onResponder, onEncaminhar, reacoes, citada, viewerUserId,
  onEditar, onApagar, onOcultar, onRestaurar, rascunho, inicioDoBloco = true, onReenviar,
}: Props) {
  // Bolha que volta à tela com edição em curso reabre o editor com o rascunho.
  const [rascunhoInicial] = useState(() => rascunho?.ler() ?? null);
  const [editando, setEditando] = useState(rascunhoInicial !== null);
  const [texto, setTexto] = useState(rascunhoInicial ?? message.body ?? "");
  // Remontar com o editor aberto NÃO rola até ele: a pessoa está rolando o fio,
  // e puxá-la de volta para a bolha seria o contrário do que ela pediu.
  const restaurouEdicao = useRef(rascunhoInicial !== null);
  const [apagando, setApagando] = useState(false);
  const [ocultando, setOcultando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const salvandoEdicao = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const abrindoEdicao = useRef(false);
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setAgora(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!editando) return;
    if (restaurouEdicao.current) {
      restaurouEdicao.current = false;
      return;
    }
    // O editor aumenta a altura da última bolha; sem rolar o fio, os botões
    // ficam escondidos atrás da área de resposta até a pessoa usar o mouse.
    editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [editando]);
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  // Pino com coordenadas: o cartão substitui o corpo, que é só o mesmo link em texto.
  const localizacao = localizacaoDaMensagem(message);
  const apagada = Boolean(message.revoked_at);
  const ocultaNoCrm = Boolean(message.metadata?.crm_hidden_at);
  const editada = Boolean(message.edited_at) && !apagada;
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body && !apagada && !ocultaNoCrm;
  const enviadaPeloAtendente = isOutbound && ["user", "crm"].includes(message.sent_via)
    && Boolean(message.external_id) && !apagada
    && ["sent", "delivered", "read"].includes(message.status);
  const podeEditar = enviadaPeloAtendente && message.type === "text" && Boolean(message.body)
    && agora - new Date(message.sent_at).getTime() <= 15 * 60 * 1000;
  const podeApagar = enviadaPeloAtendente && Boolean(onApagar);
  const podeOcultar = !isOutbound && !apagada && Boolean(ocultaNoCrm ? onRestaurar : onOcultar);
  // Encaminhar vale para qualquer mensagem com conteúdo; só não se encaminha o apagado.
  const podeEncaminhar = Boolean(onEncaminhar) && !apagada;
  // O anúncio que gerou ESTA mensagem (a ingestão grava em `metadata.anuncio`); só na recebida.
  const anuncio = !isOutbound ? lerAnuncioDaMensagem(message.metadata?.anuncio) : null;
  const temMenu = Boolean(onResponder || podeEncaminhar || (podeEditar && onEditar) || podeApagar || podeOcultar);
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const mostraCitacoes = isOutbound && aiGenerated && (debugCitations ?? false);
  const senderLabel = rotuloDaAutoria(message, viewerUserId, t);
  // QUEM MANDOU, num grupo. Só faz sentido em mensagem RECEBIDA: a que ESTE
  // CRM enviou não tem remetente a descobrir, e `senderLabel` já diz quem foi.
  const remetente = !isOutbound ? lerRemetenteDeGrupo(message.metadata) : null;

  const tom: TomDaBolha = apagada ? "apagada" : isBareSticker ? "figurinha"
    : !isOutbound ? "entrada" : senderLabel === "IA" ? "ia" : "saida";
  // Onde a hora mora depende do que vem por último na bolha (ver `MetaDaBolha`).
  const temTextoNoFim = apagada
    ? !(isOutbound && message.body)
    : ocultaNoCrm || Boolean(message.body && message.type !== "contact" && !localizacao);
  // Foto ou vídeo sem legenda: a hora vai SOBRE a mídia, em fundo escuro (quadro DS).
  const soImagem = hasMedia && (message.type === "image" || message.type === "video")
    && !message.body && !citada && !apagada && !ocultaNoCrm;
  const modoMeta: ModoDaMeta = editando ? "abaixo" : temTextoNoFim ? "no-texto" : soImagem ? "sobre-midia" : "abaixo";
  const espaco = modoMeta === "no-texto"
    ? larguraDaMeta({ tiques: isOutbound && !isFailed, editada, falhou: isFailed, citacoes: mostraCitacoes })
    : null;

  async function salvarEdicao() {
    const novoTexto = texto.trim();
    if (!onEditar || !novoTexto || salvandoEdicao.current) return;
    // Enter e clique podem chegar antes de React atualizar `ocupado`; o ref
    // impede duas chamadas ao WhatsApp para a mesma edição.
    salvandoEdicao.current = true;
    setOcupado(true);
    try { await onEditar(novoTexto); setEditando(false); rascunho?.gravar(null); }
    catch { /* O hook mostra o erro; manter o texto para nova tentativa. */ }
    finally { salvandoEdicao.current = false; setOcupado(false); }
  }

  return (
    <div
      data-search-match={searchMatch || undefined}
      // O respiro entre falas é do BLOCO: a primeira de uma sequência abre
      // espaço em cima, as seguintes encostam. É o que faz uma conversa longa
      // ler como conversa, e não como uma pilha de caixas equidistantes.
      className={classesDaLinha({ inicio: inicioDoBloco, saida: isOutbound })}
    >
      <div className={cn(COLUNA_DA_FALA, isOutbound ? "items-end" : "items-start")}>
        {inicioDoBloco && (remetente || senderLabel) && (
          // O nome sai da bolha e fica ACIMA dela, uma vez por bloco: dentro de
          // cada bolha ele repetia "Você" em toda fala e roubava a primeira linha.
          <p className={classesDoAutor(senderLabel === "IA" ? "ia" : "pessoa")}>
            {senderLabel === "IA" && <Robot size={12} weight="duotone" aria-hidden />}
            {remetente ? rotuloDoRemetente(remetente) : senderLabel && t(senderLabel)}
          </p>
        )}
        <div
          // Identidade, não aparência. O e2e de citação contava bolhas por
          // `[class*='rounded-2xl']`, e qualquer componente novo com a mesma
          // classe utilitária entrava na conta (issue #1318).
          data-testid="message-bubble"
          data-tom={tom}
          data-falhou={isFailed || undefined}
          className={cn(
            classesDaBolha({
              tom, saida: isOutbound, inicio: inicioDoBloco, falhou: isFailed,
              busca: searchMatch, temMenu, modoMeta,
            }),
            // Espaço para a marca de reação, que fica metade para fora do balão.
            Boolean(reacoes?.length) && "mb-3",
          )}
        >
          {temMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t("Opções da mensagem")} disabled={ocupado}
                  className={cn(
                    "absolute right-1 top-1 z-10 grid size-6 place-items-center rounded-full border border-border bg-surface text-text-muted shadow-xs transition-opacity hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1",
                    // Teclado: `.x:focus-visible` tem especificidade (0,2,0) MAIOR que
                    // a classe dentro da media query (0,1,0), então vence o
                    // `opacity-0` em qualquer ordem do CSS gerado.
                    "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                  )}>
                  <CaretDown size={14} weight="bold" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isOutbound ? "end" : "start"} sideOffset={4}
                onCloseAutoFocus={(event) => {
                  if (!abrindoEdicao.current) return;
                  // O Radix devolve o foco à setinha ao fechar o menu. Isso rola o
                  // fio de volta e esconde o Salvar logo depois de abrir o editor.
                  event.preventDefault();
                  abrindoEdicao.current = false;
                  editorRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
                  editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
                }}>
                {onResponder && (
                  <DropdownMenuItem onSelect={() => onResponder(message)}>
                    <ArrowBendUpLeft size={16} aria-hidden />{t("Responder a esta mensagem")}
                  </DropdownMenuItem>
                )}
                {podeEncaminhar && (
                  <DropdownMenuItem onSelect={() => onEncaminhar?.(message)}>
                    <ArrowBendUpRight size={16} aria-hidden />{t("Encaminhar")}
                  </DropdownMenuItem>
                )}
                {podeEditar && onEditar && (
                  <DropdownMenuItem onSelect={() => {
                    abrindoEdicao.current = true;
                    setTexto(message.body ?? "");
                    setEditando(true);
                    rascunho?.gravar(message.body ?? "");
                  }}>
                    <PencilSimple size={16} aria-hidden />{t("Editar mensagem")}
                  </DropdownMenuItem>
                )}
                {podeApagar && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setApagando(true)}>
                      <Trash size={16} aria-hidden />{t("Apagar para todos")}
                    </DropdownMenuItem>
                  </>
                )}
                {podeOcultar && (ocultaNoCrm ? onRestaurar : onOcultar) && (
                  <DropdownMenuItem onSelect={() => {
                    if (ocultaNoCrm && onRestaurar) void onRestaurar().catch(() => undefined);
                    else setOcultando(true);
                  }}>
                    {ocultaNoCrm ? <PencilSimple size={16} aria-hidden /> : <Trash size={16} aria-hidden />}
                    {t(ocultaNoCrm ? "Restaurar no CRM" : "Ocultar no CRM")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {anuncio && <AnuncioCard anuncio={anuncio} compacto className="mb-1.5" />}
          {citada && <CitacaoNaBolha citada={citada} viewerUserId={viewerUserId} />}
          {editando ? (
            <EditorDaBolha
              editorRef={editorRef}
              texto={texto}
              onMudar={(novo) => { setTexto(novo); rascunho?.gravar(novo); }}
              onSalvar={() => void salvarEdicao()}
              onCancelar={() => { setEditando(false); rascunho?.gravar(null); }}
              ocupado={ocupado}
            />
          ) : (
            // A apagada (`revoked_at`) e a editada mantêm o histórico; quem
            // decide o que aparece de cada uma é `CorpoDaBolha` e `MetaDaBolha`.
            <CorpoDaBolha
              message={message}
              apagada={apagada}
              ocultaNoCrm={ocultaNoCrm}
              localizacao={localizacao}
              espaco={espaco}
              soMidia={soImagem}
              agora={agora}
            />
          )}
          <MetaDaBolha
            message={message}
            tom={tom}
            modo={modoMeta}
            hora={time}
            editada={editada}
            falhou={isFailed}
            citacoes={mostraCitacoes ? extractCitations(message.metadata) : null}
          />
          {reacoes?.length ? (
            <span
              role="img"
              data-testid="message-reactions"
              aria-label={reacoes
                .map((r) => t(r.direction === "inbound" ? "Cliente reagiu com {emoji}" : "Atendente reagiu com {emoji}").replace("{emoji}", r.emoji))
                .join(", ")}
              className={cn(
                "absolute -bottom-3 flex items-center gap-0.5 rounded-full border border-border bg-surface px-1.5 py-0.5 text-xs leading-none text-text shadow-sm",
                isOutbound ? "right-2" : "left-2",
              )}
            >
              {[...new Set(reacoes.map((r) => r.emoji))].join("")}
              {reacoes.length > 1 && <span className="text-[10px] text-text-muted">{reacoes.length}</span>}
            </span>
          ) : null}
        </div>
        {/* `.fail-row`: embaixo da bolha que falhou, do lado de quem enviou. */}
        {onReenviar && <TentarDeNovo onReenviar={onReenviar} />}
      </div>
      <ConfirmacoesDaBolha
        apagando={apagando} setApagando={setApagando}
        ocultando={ocultando} setOcultando={setOcultando}
        ocupado={ocupado} setOcupado={setOcupado}
        onApagar={onApagar} onOcultar={onOcultar}
      />
    </div>
  );
}
