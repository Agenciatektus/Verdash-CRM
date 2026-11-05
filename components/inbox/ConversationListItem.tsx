"use client";

import { useRef, type ReactNode } from "react";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import { useT } from "@/hooks/i18n/useT";
import { Robot, Sparkle } from "@/lib/ui/icons";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { Badge } from "@/components/ui/badge";
import { comandoDaConversa, esperaDaConversa } from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";

import { AvatarDoContato } from "./AvatarDoContato";
import { BotaoMaisAcoes } from "./menu/BotaoMaisAcoes";
import { gatilhosDoMenu, type AbrirMenu } from "./menu/useMenuDaConversa";
import { MetaDaConversa } from "./item/MetaDaConversa";
import { IconesPessoais } from "./item/IconesPessoais";
import { GestoDaConversa } from "./item/GestoDaConversa";
import { LINHA_DA_CONVERSA_NO_CELULAR as NO_CELULAR } from "@/components/mobile/telas/LinhaDaConversa";
import { naoLidasDaConversa } from "@/lib/inbox/estado-por-atendente";
import { initials, relativeTime, siglaDoTelefone } from "./item/tempo-da-linha";
import { prefixoDoAutor } from "./item/prefixo-do-autor";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Posição 1-based na fila (G5-03). Presente só na visão Fila. */
  queuePosition?: number;
  /**
   * Mostrar POR ONDE a conversa entrou.
   *
   * Só com mais de um número conectado. Com um só, o rótulo seria a mesma
   * palavra em toda linha da lista: ruído que ensina o olho a ignorar a área
   * onde vivem os avisos que importam (bloqueado, tags).
   */
  mostrarCanal?: boolean;
  /**
   * Mostrar QUEM está no comando de cada conversa.
   *
   * Mesma regra do canal, e pelo mesmo motivo: só quando o rótulo DISCRIMINA.
   * Quem decide é a lista, que é quem sabe quantos donos distintos ela tem.
   */
  mostrarAtendente?: boolean;
  /**
   * Mostrar o ícone de robô na prévia da mensagem, quando quem manda é o
   * automático. Mesma regra dos dois badges acima: só quando DISCRIMINA. Ausente
   * ou `true` = mostra (comportamento anterior, seguro para o teste que não
   * passa esta prop).
   */
  mostrarAutomatico?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
  /** Quem está logado. Por prop pelo mesmo motivo do `automaticoDaOrg`. */
  meuUserId?: string | null;
  /**
   * Abre o menu de contexto da conversa (fase 3.6). Ausente = linha sem menu,
   * do jeito de antes: quem renderiza o item fora da lista não ganha um "…"
   * que não abre nada.
   */
  onAbrirMenu?: AbrirMenu;
  /** O menu está aberto NESTA linha: o "…" fica visível enquanto isso. */
  menuAberto?: boolean;
  /**
   * Marca esta linha no lote (#2484, F1). Presente só quando a seleção
   * múltipla está ligada — sem ela a caixa não aparece, e a lista continua
   * sendo o que era.
   */
  selecionado?: boolean;
  /**
   * Liga o modo de seleção: com esta prop a linha ganha a caixa de marcação.
   * A ação da caixa é SEPARADA do clique na linha — quem marca não abre a
   * conversa, e quem abre não marca.
   */
  onAlternarSelecao?: (id: string) => void;
  /**
   * Marca (ou desmarca) ESTA conversa como exemplo para o agente aprender (#3006).
   * Presente = a linha monta o controle; AUSENTE = a linha é a de sempre. A
   * chamada à rota NÃO mora aqui (uma resposta por lista, não por linha): quem faz
   * o `POST .../usable-for-rag` é a lista.
   */
  onAlternarExemplo?: (id: string, enabled: boolean) => void;
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  queuePosition,
  mostrarCanal,
  mostrarAtendente,
  mostrarAutomatico = true,
  automaticoDaOrg,
  meuUserId,
  onAbrirMenu,
  menuAberto,
  selecionado = false,
  onAlternarSelecao,
  onAlternarExemplo,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const celular = useEhCelular();
  const caixaRef = useRef<HTMLDivElement | null>(null);
  const c = conversation.contacts ?? null;
  const displayName = rotuloParaAEquipe(c, t);
  const phoneFallback = siglaDoTelefone(c?.phone_number);
  // L15: a prévia é cortada pelo CSS (`truncate`), na largura que a coluna tem,
  // e não em 60 caracteres fixos que sobravam na lista larga e estouravam na
  // estreita.
  const previa = conversation.last_message_preview?.trim() || null;
  const truncated = previa ?? t("Sem mensagens");
  // L14: quem escreveu a última mensagem, antes da prévia ("Você:" / "IA:").
  const autor = previa ? prefixoDoAutor(conversation.autor_da_ultima_mensagem, t) : null;
  const naFila = queuePosition !== undefined;
  /**
   * A HORA DO CANTO RESPONDE À MESMA PERGUNTA QUE ORDENA A LISTA.
   *
   * Na Fila a lista sai por TEMPO DE ESPERA (`awaiting_since` crescente, #990),
   * mas a hora do canto era a da última mensagem de QUALQUER lado: bastava o
   * atendente responder para o número pular para agora sem a linha sair do
   * lugar, e a coluna de horas saía fora de ordem (#464).
   *
   * Fora da Fila a ordem é por atividade recente, e aí a última mensagem de
   * qualquer lado É a resposta certa. A origem é a MESMA da pílula de espera,
   * inclusive no fallback.
   */
  const horaDaOrdem = naFila ? esperaDaConversa(conversation) : conversation.last_message_at;
  const time = relativeTime(horaDaOrdem, localeDaData);
  // 9042: a marca "não lida" de quem está logado conta como 1 quando o contador zerou.
  const unread = naoLidasDaConversa(conversation);
  const naoLida = unread > 0;
  const soMarcada = naoLida && !(conversation.unread_count_for_assignee ?? 0);

  /**
   * Quem manda, pela MESMA regra do cabeçalho. `status === 'ai_handling'` era um
   * proxy ruim: o único escritor desse status em produção é o botão "Devolver ao
   * automático", então o robô quase nunca aparecia.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";

  // O número DA EMPRESA por onde esta conversa chegou, não o do cliente. Com
  // dois canais é o que decide o tom da resposta e qual número a pessoa vê
  // respondendo. #2383: o nome dado em Conexões vem na frente do número.
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = rotuloDoCanalDaConversa(canal, t);

  // A conversa marcada como exemplo (#3006): `usable_for_rag` vem no SELECT da lista.
  // Os dois rótulos são literais `t()` separados (a cerca de espanhol cobra chave por chave).
  const exemploMarcado = Boolean(conversation.usable_for_rag);
  const rotuloExemplo = exemploMarcado
    ? t("Deixar de usar como exemplo")
    : t("Usar como exemplo para a IA");
  const gatilhos = gatilhosDoMenu(conversation.id, onAbrirMenu, !!menuAberto);

  const linha = (
    <button
      type="button"
      data-conversation-id={conversation.id}
      data-nao-lida={naoLida ? "true" : undefined}
      onClick={() => onSelect(conversation.id)}
      {...gatilhos}
      className={cn(
        "group relative grid w-full grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-border px-3.5 py-(--row-py) text-left transition-colors hover:bg-surface-elevated/60",
        NO_CELULAR.grade,
        "focus-visible:outline-hidden focus-visible:bg-surface-elevated/60",
        // Selecionada (L13): o `accent-soft` do protótipo, com a barra de 3px.
        // No escuro a pele troca pelo degradê horizontal da marca
        // (`pele-selecionada`), que se destaca do card mesmo com marca escura.
        // Marcada no lote (upstream 1.85), quem pinta o `accent-soft` é o wrapper:
        // ele é translúcido e pintar os dois o somava. O botão fica transparente no
        // hover/foco (senão a linha ficava em dois tons) e o foco vira anel.
        isSelected &&
          (selecionado
            ? "pele-selecionada hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            : "pele-selecionada bg-accent-soft hover:bg-accent-soft"),
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      {/* Marcador da seleção: o `conv.is-sel::before` do protótipo, recuado em
          cima e embaixo para não colar na borda da linha vizinha. */}
      {isSelected && (
        <span className="pele-grad-traco absolute inset-y-1.5 left-0 w-[3px] rounded-r-sm bg-accent" aria-hidden />
      )}
      <div className={cn("relative h-10 w-10 shrink-0", NO_CELULAR.avatar)}>
        {/* Cor por pessoa (hash do id), a mesma do cabeçalho e do painel. */}
        <AvatarDoContato
          contato={c}
          nome={displayName}
          iniciais={initials(displayName, phoneFallback)}
          className={NO_CELULAR.avatarTexto}
        />
        {/* Não há mais a bolinha de "quem manda" no canto esquerdo: ela
            sobrepunha o avatar e repetia o que a pílula de dono já diz (e só
            onde discrimina). O canto do avatar é do selo do canal (WhatsApp,
            Instagram…), como no protótipo. */}
        <ChannelLogo
          channel={canal}
          size={11}
          selo
          // O anel tem a cor do FUNDO DA LINHA (que muda na seleção), para o
          // selo recortar o avatar em vez de flutuar com uma borda de outra cor.
          className={cn(
            "absolute -bottom-0.75 -right-0.75 size-4.5 ring-2",
            isSelected ? "ring-accent-soft" : "ring-surface",
          )}
        />
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[14.5px] text-text",
                NO_CELULAR.nome,
                naoLida ? "font-bold" : "font-semibold",
                c?.is_anonymized && "font-normal italic text-text-muted",
              )}
            >
              {displayName}
            </span>
            {/* A ETIQUETA "GRUPO", ao lado do nome: sem ela a lista não distingue
                um grupo de uma conversa individual até abrir a conversa. */}
            {conversation.is_group && (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                {t("Grupo")}
              </Badge>
            )}
            {/* O SELO do exemplo (#3006): quem só lê a lista também vê que a conversa alimenta a IA. */}
            {exemploMarcado && (
              <Badge
                variant="outline"
                data-testid="selo-exemplo-ia"
                className="h-4 shrink-0 gap-1 px-1.5 text-[10px] font-normal text-accent"
              >
                <Sparkle size={10} weight="fill" aria-hidden />
                {t("Exemplo para a IA")}
              </Badge>
            )}
          </span>
          <IconesPessoais pinned={conversation.pinned} mutedUntil={conversation.muted_until} />
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              naoLida ? "font-semibold text-accent" : "text-text-subtle",
            )}
            // O mesmo lugar mostra duas coisas conforme a aba: na Fila é "desde
            // quando o cliente ESPERA" (#990), nas outras é "há quanto tempo a
            // conversa mexeu". O rótulo existe só onde a leitura muda.
            title={naFila ? t("Desde quando o cliente espera resposta") : undefined}
          >
            {time}
          </span>
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[13.5px]",
              NO_CELULAR.previa,
              naoLida ? "text-text" : "text-text-muted",
            )}
          >
            {isAi && mostrarAutomatico ? (
              <Robot size={12} weight="duotone" className="mr-1 inline align-[-2px]" aria-hidden />
            ) : null}
            {autor && <span className="text-text-subtle">{autor} </span>}
            {truncated}
          </p>
          {naoLida && (
            <span
              className="pele-grad-contador inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold tabular-nums text-accent-foreground"
              aria-label={soMarcada ? t("Marcada como não lida") : `${unread} ${t("mensagens não lidas")}`}
            >
              {soMarcada ? "" : unread}
            </span>
          )}
        </div>

        <MetaDaConversa
          conversation={conversation}
          comando={comando}
          queuePosition={queuePosition}
          mostrarAtendente={mostrarAtendente}
          rotuloCanal={rotuloCanal}
          mostrarCanal={mostrarCanal}
          meuUserId={meuUserId}
        />
      </div>
    </button>
  );

  /**
   * A CAIXA DE SELEÇÃO DO LOTE (#2484, F1) — IRMÃ da linha, nunca dentro dela:
   * controle interativo dentro de `<button>` é HTML inválido, e marcar não pode
   * abrir a conversa. É o checkbox nativo com a pele global do DS
   * (`input[type="checkbox"]` em `app/globals.css`). Sem `onAlternarSelecao`
   * (viewer, ou fora da lista) a linha continua sendo o que era.
   */
  const comSelecao = (conteudo: ReactNode) =>
    onAlternarSelecao ? (
      <div className={cn("relative flex w-full items-stretch", selecionado && "bg-accent-soft")}>
        <span className="flex shrink-0 items-start pl-3 pr-2 pt-3">
          <input
            type="checkbox"
            checked={selecionado}
            onChange={() => onAlternarSelecao(conversation.id)}
            aria-label={t("Selecionar conversa")}
            title={t("Selecionar conversa")}
            data-testid={`selecao-em-lote-${conversation.id}`}
          />
        </span>
        <div className="min-w-0 flex-1">{conteudo}</div>
      </div>
    ) : (
      conteudo
    );

  if (!onAbrirMenu) return comSelecao(linha);

  // Um <button> não pode morar dentro de outro: o "…" é IRMÃO da linha.
  // No celular (abaixo de 760px) a linha ganha o gesto de deslizar (M1.4); as mesmas
  // ações seguem no "…".
  return comSelecao(
    <div ref={caixaRef} className="group/linha relative" data-menu-aberto={menuAberto ? "true" : undefined}>
      {celular ? (
        <GestoDaConversa
          conversation={conversation}
          automaticoDaOrg={automaticoDaOrg}
          meuUserId={meuUserId ?? null}
          aoAbrirMenu={() => caixaRef.current && onAbrirMenu(conversation.id, caixaRef.current, caixaRef.current)}
        >
          {linha}
        </GestoDaConversa>
      ) : (
        linha
      )}
      <BotaoMaisAcoes
        nome={displayName}
        aberto={!!menuAberto}
        onAbrir={(el) => onAbrirMenu(conversation.id, el, el)}
      />
      {/* O CONTROLE DE "EXEMPLO PARA A IA" (#3006), IRMÃO da linha (controle dentro
          de <button> é HTML inválido). Marcado fica sempre visível: é o selo do
          estado. Desmarcado aparece no hover/foco e no toque, como o "…". */}
      {onAlternarExemplo && (
        <button
          type="button"
          data-testid={`exemplo-ia-${conversation.id}`}
          aria-pressed={exemploMarcado}
          aria-label={rotuloExemplo}
          title={rotuloExemplo}
          onClick={() => onAlternarExemplo(conversation.id, !exemploMarcado)}
          className={cn(
            "absolute right-[46px] top-2 grid size-[30px] place-items-center rounded-lg transition-opacity",
            "focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent",
            exemploMarcado
              ? "text-accent hover:bg-accent-soft"
              : "text-text-muted opacity-0 hover:bg-tint hover:text-text group-hover/linha:opacity-100 group-focus-within/linha:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <Sparkle size={14} weight={exemploMarcado ? "fill" : "regular"} aria-hidden />
        </button>
      )}
    </div>
  );
}
