"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import { rotuloDaRecorrencia } from "@/lib/leads/valor-recorrente";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { resolveCardState, type CardInput } from "@/lib/kanban/card-state";
import { canalDoCard, iniciaisDoCard, linhaDeBaixo, nomeDoCard } from "@/lib/kanban/identidade-do-card";
import { tempoNaEtapa } from "@/lib/kanban/tempo-na-etapa";
import { AvatarDoLead } from "./AvatarDoLead";
import { KanbanCardActions } from "./KanbanCardActions";
import { NextActionSlot } from "./NextActionSlot";
import { ReactivationSlot } from "./ReactivationSlot";
import { ConversaSlot } from "./ConversaSlot";
import { ScoreSlot } from "./ScoreSlot";
import { ContatoNoCard } from "./ContatoNoCard";
import { AnuncioDoCard, EsperaDoLead, EtiquetasDoCard, ProximoPassoDoCard, ResponsavelDoCard, TempoDoCard } from "./PartesDoCard";
import { ArquivosNoCard } from "./ArquivosNoCard";
import { TarefasNoCard } from "./TarefasNoCard";

/** Os dois gestos de seleção que o card sabe relatar. */
export type GestoDeSelecao = "alterna" | "intervalo";

interface KanbanCardProps {
  /** O que o card mostra — explicitamente NÃO é a linha do banco. */
  card: CardInput;
  /** A linha do lead: menu de ações (que muta o lead) e a identidade do contato. */
  lead: Lead;
  index: number;
  pipelineId: string;
  isSelected?: boolean;
  /**
   * Há seleção viva no quadro. Só muda a VISIBILIDADE da caixa (que fora disso
   * aparece no hover/foco): quando o usuário já está selecionando, esconder as
   * caixas dos outros cards transforma "clicar em mais um" numa caça ao pixel.
   */
  isSelecting?: boolean;
  /**
   * Contador de pulsos deste card (evento REMOTO). Muda a cada evento novo — é
   * a MUDANÇA que remonta o overlay e reinicia a animação; um booleano deixaria
   * o segundo evento dentro da janela passar despercebido.
   */
  pulseCount?: number;
  /**
   * `alterna` = um card entra/sai da seleção. `intervalo` = daqui até a âncora
   * (shift). Quem resolve o intervalo é a COLUNA, que é a única que conhece a
   * ordem visível dos cards — o card só relata o gesto.
   */
  onSelect?: (leadId: string, gesto: GestoDeSelecao) => void;
  /** Abrir o dossiê. Separado de `onSelect`: são gestos e intenções diferentes. */
  onOpen?: (leadId: string) => void;
  /** Densidade compacta: sem a última mensagem e sem etiquetas (o resto fica). */
  compacto?: boolean;
  /** `crm_stages.expected_duration_hours` — o limite do "Parado há X dias". */
  limiteDaEtapa?: number | null;
  /** Repassados ao menu de ações ("Mover para…"). */
  etapas?: Stage[];
  onMoverPara?: (lead: Lead, stageId: string) => void;
}

function formatValor(cents: number | null, currency: string | null): string | null {
  // A régua do negócio (×100 em qualquer moeda) e o locale da moeda moram em
  // `formatValorDoNegocio` — a mesma função do total da coluna, para o card e o
  // topo da coluna nunca escreverem o mesmo dinheiro de dois jeitos. Valor
  // zero ou ausente não aparece: nada de traço vazio ocupando linha.
  if (cents == null || cents <= 0) return null;
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/**
 * O card do lead no Funil/Kanban — proposta aprovada pelo Peterson (board
 * "Card do lead", 13/10/2026), nas densidades confortável e compacta.
 *
 * Quem é (avatar com selo do canal, nome honesto), quanto vale, o que falta
 * fazer e há quanto tempo está parado, lidos em um olhar. Cada linha só
 * aparece quando tem conteúdo. As faixas do agente (proposta aguardando,
 * retomada, score) continuam, e só ocupam altura quando existem.
 */
export function KanbanCard({
  card,
  lead,
  index,
  pipelineId,
  isSelected,
  isSelecting = false,
  pulseCount = 0,
  onSelect,
  onOpen,
  compacto = false,
  limiteDaEtapa = null,
  etapas,
  onMoverPara,
}: KanbanCardProps) {
  const t = useT();
  const value = formatValor(card.valueCents, card.currency);
  /**
   * A MENSALIDADE, ao lado do valor único (fatia 1 da #3602): o card escreve
   * "R$ 3.000 + R$ 500/mês". Os dois números aparecem — nunca a soma, que é
   * exatamente o que a issue pediu para não fazer — e o negócio de valor único
   * fica com a linha de sempre (o segundo trecho só existe quando há
   * recorrência). `semCentavos` acompanha o valor único: o card nunca mostrou
   * centavos, e a linha tem altura fixa.
   */
  const recorrente = rotuloDaRecorrencia(
    card.recurringValueCents,
    card.recurringPeriod,
    card.currency ?? MOEDA_PADRAO,
    { semCentavos: true, sufixo: t("/mês") },
  );
  const state = resolveCardState(card, t);
  const { nome: nomeBruto, origem } = nomeDoCard(lead);
  const nome = nomeBruto || t("Sem nome");
  const canal = canalDoCard(lead);
  const sub = linhaDeBaixo(lead, origem, canal);
  const tempo = tempoNaEtapa(card.hoursInStage, limiteDaEtapa, card.isCooling);
  const naoLidas = lead.conversa?.unread ?? 0;
  const foto = lead.contact_tem_foto && lead.contact_id ? `/api/v1/contacts/${lead.contact_id}/avatar` : null;

  // Clique ABRE o dossiê; ctrl/cmd+clique SELECIONA; shift+clique estende até a
  // âncora. O arrasto continua funcionando porque o dnd distingue clique de
  // arrasto por movimento, não por handler.
  //
  // ⚠️ UMA função, dois pontos de entrada. O NOME é um `<button>` com
  // `stopPropagation()`, então o clique nele NUNCA chega ao handler do card; se
  // o `onClick` dele ignorasse os modificadores, shift+clique no maior alvo do
  // card abriria o dossiê em vez de selecionar (medido em 2026-09-04).
  const decidirClique = (e: {
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  }): void => {
    if (e.shiftKey) {
      onSelect?.(card.id, "intervalo");
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onSelect?.(card.id, "alterna");
      return;
    }
    onOpen?.(card.id);
  };
  const handleClick = (e: MouseEvent<HTMLDivElement>) => decidirClique(e);

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          // O dnd marca o handle como role="button"; com o menu de ações dentro,
          // isso vira nested-interactive no axe. "group" mantém o foco e o
          // teclado do dnd (tabIndex e handlers continuam vindo do spread) sem
          // aninhar dois controles — nada de aria-hidden nem de suprimir regra.
          role="group"
          aria-label={`${t("Lead")}: ${nome}`}
          data-densidade={compacto ? "compacta" : "confortavel"}
          onClick={handleClick}
          // A lista inteira das etiquetas fica a um hover (o card mostra 2 + "+N").
          title={card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : undefined}
          className={cn(
            "group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs",
            "cursor-grab transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-md",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            compacto ? "gap-1.75 px-2.5 py-2" : "gap-2.5 px-3 pt-3 pb-2.5",
            snapshot.isDragging && "rotate-2 cursor-grabbing shadow-lg",
            isSelected && "border-accent bg-accent-soft ring-1 ring-accent",
          )}
        >
          {/* key = contador: cada evento remoto monta um overlay NOVO, e é isso
              que reinicia a animação. Fica no elemento interno — pôr no wrapper
              remontaria o draggable e quebraria o arrasto. */}
          {pulseCount > 0 && (
            <span
              key={pulseCount}
              aria-hidden
              // Observável de propósito: é assim que o teste prova que o
              // overlay REMONTOU (contador novo) em vez de ter sobrado do
              // evento anterior — e "sobrou" era exatamente o defeito.
              data-pulse={pulseCount}
              className="card-pulse pointer-events-none absolute inset-0"
            />
          )}

          {/* ① quem é e por onde chegou */}
          <div className="flex items-center gap-2.5">
            <AvatarDoLead
              semente={lead.contact_id ?? card.id}
              iniciais={iniciaisDoCard(nome)}
              foto={foto}
              canal={canal}
              compacto={compacto}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              {/* O NOME é o elemento ativável, não o card inteiro (wave 2:
                  `role="group"` evita nested-interactive). O button atende
                  mouse, teclado e leitor de tela. */}
              <h3 className="flex min-w-0 items-center gap-1.5 text-sm leading-5 font-bold text-text">
                {card.canonicalTag && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    title={card.canonicalTag}
                    // role="img": um span nu não aceita aria-label (aria-prohibited-attr).
                    role="img"
                    aria-label={`${t("Tag")}: ${card.canonicalTag}`}
                  />
                )}
                <button
                  type="button"
                  title={card.title}
                  onClick={(e) => {
                    // `stopPropagation` continua: sem ele o handler do card
                    // rodaria de novo e o gesto seria contado duas vezes.
                    e.stopPropagation();
                    decidirClique(e);
                  }}
                  className={cn(
                    "min-w-0 truncate text-left hover:underline",
                    origem === "telefone" && "font-semibold tabular-nums",
                  )}
                >
                  {nome}
                </button>
              </h3>
              {sub && (
                <span className={cn("truncate text-xs text-text-subtle", sub.mono && "tabular-nums")}>
                  {sub.chave ? t(sub.texto) : sub.texto}
                </span>
              )}
            </div>
            {naoLidas > 0 && (
              // O número, não um ponto: "3" e "12" sem ler pedem urgências diferentes.
              <span
                className="mt-1 grid h-5 min-w-5 shrink-0 place-items-center self-start rounded-full bg-accent px-1.5 text-[11.5px] font-bold text-accent-foreground tabular-nums"
                aria-label={`${naoLidas} ${t("mensagens não lidas")}`}
              >
                {naoLidas}
              </span>
            )}
            {/* A caixa de seleção: largura sempre reservada, só a tinta é
                condicional (uma caixa que aparece EMPURRANDO o nome faria o
                quadro tremer com o mouse). `focus:opacity-100`: caixa
                invisível e tabulável seria armadilha de teclado. */}
            <input
              type="checkbox"
              checked={Boolean(isSelected)}
              aria-label={`${t("Selecionar")}: ${nome}`}
              onClick={(e) => {
                // O card inteiro tem onClick (abre o dossiê): sem parar a
                // propagação, marcar a caixa abriria o dossiê por cima.
                e.stopPropagation();
                onSelect?.(card.id, e.shiftKey ? "intervalo" : "alterna");
              }}
              onChange={() => {
                /* estado vem de `isSelected`; quem decide é o onClick acima */
              }}
              className={cn(
                "mt-1.5 h-4 w-4 shrink-0 cursor-pointer self-start transition-opacity mb:mt-1 mb:h-5 mb:w-5",
                "focus:opacity-100 focus-visible:outline-2 focus-visible:outline-accent",
                isSelected || isSelecting ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            />
            <div className="self-start">
              <KanbanCardActions
                lead={lead}
                pipelineId={pipelineId}
                etapas={etapas}
                onMoverPara={onMoverPara}
              />
            </div>
          </div>

          {/* ② valor — só quando existe. `card-valor` carrega o valor único E a
              mensalidade (9028) no MESMO elemento. */}
          {(value || recorrente) && (
            <span
              data-testid="card-valor"
              className="text-[15px] leading-tight font-bold text-text tabular-nums"
              title={recorrente ? `${value ?? ""} + ${recorrente}`.trim() : undefined}
            >
              {value}
              {recorrente && (
                <span className="ml-1 text-xs font-medium text-text-muted">
                  {value ? "+ " : ""}
                  {recorrente}
                </span>
              )}
            </span>
          )}

          {/* ③ a última mensagem (1 linha); o clique nela é o do card (dossiê). */}
          {!compacto && (
            <ConversaSlot conversa={lead.conversa} contactId={lead.contact_id} phone={lead.contact_phone} enxuto />
          )}

          {!compacto && <AnuncioDoCard lead={lead} />}

          {!compacto && <EtiquetasDoCard tags={card.tags} />}

          {/* E-mail e links do contato; o telefone já está embaixo do nome. */}
          {!compacto && <ContatoNoCard lead={lead} semTelefone />}

          {/* Os campos `file` do funil (#2829): contagem + o documento clicável. */}
          {!compacto && <ArquivosNoCard lead={lead} />}

          {/* A faixa do agente — só quando há o que decidir ou medir. O
              "esfriando" não entra: o rodapé já diz "Parado há X dias". */}
          {state.slot.type === "awaiting" && (
            <div className="flex items-center gap-2 text-xs">
              {/* A proposta do agente é a ÚNICA linha com ação: é onde a
                  decisão do humano entra. */}
              <NextActionSlot
                label={state.slot.label}
                leadId={card.id}
                approvedSeq={lead.next_action?.seq ?? -1}
                pipelineId={pipelineId}
              />
            </div>
          )}
          {state.slot.type === "reactivation" && (
            <div className="flex items-center gap-2 text-xs">
              <ReactivationSlot
                leadId={card.id}
                proposalId={state.slot.proposalId}
                expiresAt={state.slot.expiresAt}
                pipelineId={pipelineId}
              />
            </div>
          )}
          {state.slot.type === "meter" && (
            <div className="flex items-center gap-2 text-xs">
              <ScoreSlot
                probability={state.slot.probability}
                band={state.slot.band}
                reason={state.slot.reason}
                factors={state.slot.factors}
              />
            </div>
          )}

          {/* ④ o próximo passo (a tarefa aberta mais urgente) */}
          <ProximoPassoDoCard passo={lead.proximo_passo} />

          {/* ⑤ tempo na etapa · selo de tarefas (upstream) + responsável */}
          <div
            className={cn(
              "flex items-center justify-between gap-2 border-t border-border text-xs text-text-subtle",
              compacto ? "pt-1.5" : "pt-2",
            )}
          >
            {/* Parado (fora do limite da etapa) vence; senão, quem espera resposta
                mostra há quanto tempo (barra do Funil, 13/10/2026). */}
            {tempo?.nivel === "neutro" && lead.conversa?.esperando_desde ? (
              <EsperaDoLead lead={lead} agora={new Date()} comRotulo />
            ) : (
              <TempoDoCard tempo={tempo} />
            )}
            <div className="flex min-w-0 items-center gap-2">
              <TarefasNoCard tarefas={lead.tarefas} />
              <ResponsavelDoCard owner={card.owner} />
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}
