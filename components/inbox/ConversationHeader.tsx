"use client";
import { useState, type RefObject } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { CheckCircle } from "@/lib/ui/icons";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useReopenConversation } from "@/hooks/inbox/useCloseConversation";
import { useEncerrarComDesfazer } from "@/hooks/inbox/useEncerrarComDesfazer";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import { DialButton } from "@/components/voice/DialButton";
import { ReservarServicoNaConversa } from "@/components/agenda/ReservarServicoNaConversa";
import { AlternarPainel } from "@/components/inbox/cabecalho/AlternarPainel";
import { FaixaDeStatus } from "@/components/inbox/cabecalho/FaixaDeStatus";
import { IdentidadeDaConversa } from "@/components/inbox/cabecalho/IdentidadeDaConversa";
import { MaisAcoes } from "@/components/inbox/cabecalho/MaisAcoes";
import { TransferirPopover } from "@/components/inbox/cabecalho/TransferirPopover";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { entrouPor } from "@/lib/contacts/entrou-por";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { VideoCallButton } from "@/components/inbox/VideoCallButton";
import { motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import { useMarkPersonalContact, useUnmarkPersonalContact } from "@/hooks/contacts/usePersonalContact";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Props {
  conversation: ConversationWithContact;
  /**
   * A busca DENTRO da conversa (#1793): abre um campo que filtra só as
   * mensagens já carregadas. O ref devolve o foco ao gatilho do menu "Mais"
   * quando o campo fecha, senão o Esc largava o foco no `body`.
   */
  onBuscar?: () => void;
  buscaAberta?: boolean;
  botaoBuscaRef?: RefObject<HTMLButtonElement | null>;
  /** Seleciona outra conversa no Inbox: "Continuar por outro número" abre a do outro número. */
  onAbrirConversa?: (id: string) => void;
  /** A coluna do lead a partir do `xl`: o cabeçalho só alterna, quem guarda o estado é o layout. */
  painelAberto?: boolean;
  onAlternarPainel?: () => void;
  /** Abaixo do `xl` a ficha é um painel deslizante; este botão o abre. */
  onAbrirFicha?: () => void;
}

/**
 * O SELO NOMEIA CICLO DE VIDA, NÃO COMANDO: `conversations.status` não
 * acompanha silêncio, trava nem atribuição, e afirmar "quem manda" por ele
 * contradizia o `OwnerBadge` ao lado. Cobre os SETE valores do CHECK: o call
 * site é `t(STATUS_LABEL[status] ?? status)`, e um buraco imprime o token cru em
 * inglês. Vigiado pelo invariante de espelho.
 */
const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({
  conversation,
  onAbrirConversa,
  onBuscar,
  buscaAberta,
  botaoBuscaRef,
  painelAberto = true,
  onAlternarPainel,
  onAbrirFicha,
}: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  // MODO LEITURA: acompanhamento de suporte somente leitura E o papel `viewer`.
  // As rotas recusam os dois; a tela deixa de oferecer o que o servidor nega,
  // em vez de deixar a pessoa descobrir a regra por um 403 no toast.
  const podeAtender = usePermission("inbox.claim");
  const leitura = user.support?.access_mode === "support_readonly" || !podeAtender;
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  // Fechar e arquivar agem na hora, com "Desfazer" no aviso (quadro DS).
  const encerrar = useEncerrarComDesfazer();
  const reopen = useReopenConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" Sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();

  const c = conversation.contacts ?? null;
  const displayName = rotuloParaAEquipe(c, t);
  /**
   * POR ONDE ESTA CONVERSA ENTROU — o mesmo rótulo da lista e da tela de
   * canais (#2383). `null` quando não há canal, e aí o badge não existe.
   */
  const rotuloCanal = rotuloDoCanalDaConversa(conversation.channel_sessions, t);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  // Marcar/desmarcar pessoal (spec 21, etapa 15 — botão no cabeçalho).
  //
  // GERENTE pode (spec decisão 1, D3): pessoal é decisão operacional — esconder
  // uma conversa da operação. Desbloquear exige ADMIN porque reabre um canal
  // que o cliente fechou (direito do titular, LGPD): dois gestos parecidos,
  // dois gates diferentes, cada um com seu motivo.
  //
  // Os hooks ficam AQUI, antes de qualquer early return (a ordem dos hooks não
  // pode mudar entre renderizações); com contato ausente o id vazio nunca
  // dispara porque o botão nem é desenhado.
  const ehPessoal = c?.is_personal === true;
  const podeMarcarPessoal =
    (user.is_platform_admin && !user.support) ||
    (activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  const marcarPessoal = useMarkPersonalContact(c?.id ?? "");
  const desmarcarPessoal = useUnmarkPersonalContact(c?.id ?? "");

  /**
   * QUEM MANDA, uma pergunta com uma resposta. A regra mora em `lib/inbox`,
   * espelhando os gates que o MOTOR lê, e esta tela só a consome: somar
   * condições à mão aqui é como três leituras parciais divergiram no passado.
   */
  const fatosDoComando = {
    status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
    automaticoDaOrg: automaticoDaOrg.data,
  };
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa(fatosDoComando);
  /**
   * O QUE "LIBERAR" FAZ DEPENDE DO ESTADO, e a guia do botão (#3003) não pode
   * prometer o automático de volta quando ele não volta.
   *
   * `fn_conversation_assign` com dono `null` deixa a conversa aberta e sem dono,
   * mas só limpa `bot_silenced_until` quando NÃO houve escalação
   * (`last_handoff_at is null`). Depois de uma escalação, com o contato travado
   * (`force_human`), descadastrado, em grupo ou numa org sem automático, a
   * conversa cai na fila esperando gente. A pergunta é a mesma regra de quem
   * manda, aplicada ao estado que a RPC vai gravar.
   */
  const liberarDevolveAoAutomatico =
    comandoDaConversa({
      ...fatosDoComando,
      status: "open",
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      assignee_kind: null,
      bot_silenced_until: conversation.last_handoff_at ? fatosDoComando.bot_silenced_until : null,
    }).comando.quem === "automatico";

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  // A VOLTA aparece sempre que há trava a desfazer, inclusive ENCERRADA (senão
  // a conversa fica sem porta para um colega). `travaVigente` e NÃO
  // `!automaticoAtivo`: encerrada sem trava reabriria sem ninguém pedir.
  const podeDevolver = travaVigente;
  /**
   * PAUSAR só existe quando é um gesto DIFERENTE de assumir. Desde a 0173
   * "Assumir" já cala o automático; sobra o caso em que a conversa JÁ tem dono
   * e o automático segue de pé (o rodízio distribui sem calar, de propósito).
   */
  const podePausar = automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null;
  const devolver = () => retomar.mutate({ conversation_id: conversation.id });

  const [confirmPessoalOpen, setConfirmPessoalOpen] = useState(false);

  return (
    <div>
      {/* `flex-wrap` e a barra sem `shrink-0`: este cabeçalho já travou a
          largura da tela inteira (707px de `min-content`, painel de CRM 311px
          fora da viewport em 1280). Quando aperta, a barra desce de linha. */}
      <header
        // O `.th-head` do protótipo: 64px de altura mínima, 10px em cima e
        // embaixo, 18px à esquerda (alinha o nome com o texto das bolhas) e 12px
        // à direita (os ícones de ação já trazem o próprio respiro).
        // `mb:hidden`: no celular a conversa tem a barra do protótipo
        // (`BarraDaConversaNoCelular`), e as ações moram no ⋮ dela.
        className="pele-ruido flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-surface py-2.5 pl-4.5 pr-3 mb:hidden"
        data-testid="cabecalho-da-conversa"
      >
        <IdentidadeDaConversa
          nome={displayName}
          status={t(STATUS_LABEL[status] ?? status)}
          encerrada={encerrada}
          canal={conversation.channel_sessions}
          rotuloCanal={rotuloCanal}
          telefone={phone}
          comando={comando}
          meuUserId={user.id}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1" data-testid="acoes-da-conversa">
          {leitura ? (
            <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs font-medium text-text-muted">
              {t("Somente leitura")}
            </span>
          ) : (
            <>
              {isOpen && (
                <Button
                  size="sm"
                  variant="default"
                  disabled={claim.isPending}
                  // O rótulo é contrato (`inbox-header-nao-trava` e o dicionário).
                  // Assumir muda DUAS coisas desde a 0173, e o título diz as duas.
                  title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
                  onClick={() =>
                    claim.mutate({
                      conversation_id: conversation.id,
                      expected_assignee: conversation.assigned_to_user_id,
                    })
                  }
                >
                  {t("Assumir")}
                </Button>
              )}
              {podeDevolver && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retomar.isPending}
                  data-testid="devolver-ao-automatico"
                  // O ALCANCE DA VOLTA: quando foi o CLIENTE que travou
                  // (`contacts.force_human`), o clique religa o automático em
                  // TODAS as conversas dele, e o título precisa dizer isso.
                  title={
                    motivo === "contato_travado"
                      ? t("Religa o atendimento automático para este cliente, em todas as conversas dele.")
                      : t("Devolve esta conversa ao atendimento automático.")
                  }
                  onClick={devolver}
                >
                  {retomar.isPending ? t("Devolvendo...") : t("Devolver à IA")}
                </Button>
              )}
              {encerrada && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reopen.isPending}
                  // Guia curta (#3003): o rótulo não diz que a conversa volta a ser atendida.
                  title={t("Reabre o atendimento desta conversa, que estava encerrada.")}
                  onClick={() =>
                    reopen.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision })
                  }
                >
                  {t("Reabrir")}
                </Button>
              )}
              {isMineAssigned && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={release.isPending}
                  // Guia curta (#3003) em `title`, não em `aria-label` (que trocaria o
                  // nome acessível "Liberar"): diz para onde a conversa vai.
                  title={
                    liberarDevolveAoAutomatico
                      ? t("Solta esta conversa: ela fica sem dono e o atendimento automático volta a responder.")
                      : t("Solta esta conversa: ela fica sem dono e volta para a fila, esperando um atendente.")
                  }
                  onClick={() => release.mutate({ conversation_id: conversation.id })}
                >
                  {t("Liberar")}
                </Button>
              )}
              {/* A chamada usa o telefone da ficha. Grupo não é uma pessoa para ligar. */}
              {!conversation.is_group && c?.id && <DialButton contactId={c.id} hasPhone={!!c.phone_number} />}
              {!conversation.is_group && c?.id && activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent && (
                <ReservarServicoNaConversa key={`${activeOrg.orgId}:${conversation.id}`} contactId={c.id} conversationId={conversation.id} contactName={displayName} />
              )}
              {/* Videochamada (#2440): sem JITSI_SERVER_URL não renderiza. Segue a
                  MESMA régua do composer (janela de 24h, contato, encerrada). */}
              <VideoCallButton
                conversationId={conversation.id}
                provider={conversation.channel_sessions?.provider ?? null}
                lastInboundAt={conversation.last_inbound_at}
                bloqueio={motivoDoContato(c, t)}
                encerrada={status === "closed"}
              />
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              {!encerrada && (
                <TransferirPopover
                  conversationId={conversation.id}
                  devolver={podeDevolver ? { onDevolver: devolver, pendente: retomar.isPending } : undefined}
                  numero={
                    onAbrirConversa && c?.id
                      ? {
                          contactId: c.id,
                          contactPhone: c.phone_number ?? null,
                          channelSessionId: conversation.channel_session_id,
                          onAbrirConversa,
                        }
                      : undefined
                  }
                />
              )}
              {!encerrada && (
                <SnoozeButton conversationId={conversation.id} snoozeUntil={conversation.snooze_until ?? null} />
              )}
              {!encerrada && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-9 px-0"
                  disabled={encerrar.fechando}
                  aria-label={t("Fechar conversa")}
                  title={t("Encerra o atendimento. Depois você pode reabrir a conversa.")}
                  onClick={() => encerrar.fechar(conversation)}
                >
                  <CheckCircle size={18} aria-hidden />
                </Button>
              )}
            </>
          )}
          <MaisAcoes
            onBuscar={onBuscar}
            buscaAberta={buscaAberta}
            botaoRef={botaoBuscaRef}
            pausar={!leitura && podePausar ? { onPausar: () => pausar.mutate({ conversation_id: conversation.id }), pendente: pausar.isPending } : undefined}
            // ARQUIVAR (#923): a já arquivada não mostra, arquivar duas vezes não
            // é um gesto. Fechada e resolvida mostram: são as que se manda para o
            // arquivo depois de encerradas. Mesma permissão de fechar.
            arquivar={!leitura && status !== "archived" ? { onArquivar: () => encerrar.arquivar(conversation), pendente: encerrar.arquivando } : undefined}
            contatoId={c?.id ?? null}
            painelVisivel={painelAberto}
            pessoal={
              !leitura && podeMarcarPessoal && c?.id
                ? {
                    ehPessoal,
                    pendente: ehPessoal ? desmarcarPessoal.isPending : marcarPessoal.isPending,
                    onMarcar: () => setConfirmPessoalOpen(true),
                    onDesmarcar: () => desmarcarPessoal.mutate(),
                  }
                : undefined
            }
          />
          {onAlternarPainel && (
            <AlternarPainel aberto={painelAberto} onAlternar={onAlternarPainel} onAbrirFicha={onAbrirFicha} />
          )}
        </div>
      </header>
      <FaixaDeStatus
        janela={
          <JanelaSelo
            provider={conversation.channel_sessions?.provider ?? null}
            lastInboundAt={conversation.last_inbound_at}
            comBarra
          />
        }
        conversationId={conversation.id}
        esperandoDesde={encerrada ? null : (conversation.awaiting_since ?? null)}
        snoozeUntil={encerrada ? null : (conversation.snooze_until ?? null)}
        motivo={motivo !== null ? t(ROTULO_DO_MOTIVO[motivo]) : null}
        instagramEntrada={conversation.instagram_entrada ?? null}
        entradaDoContato={entrouPor(conversation.contacts)}
        leitura={leitura}
      />
      {/* A confirmação diz o que ACONTECE ao marcar; desmarcar é direto porque
          só relista o que já está lá. */}
      <AlertDialog open={confirmPessoalOpen} onOpenChange={setConfirmPessoalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Marcar este contato como pessoal?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A conversa sai do inbox e o contato fica fora da operação: sem IA, sem follow-up, sem campanha e sem envio. O histórico continua no banco e volta à vista ao desmarcar; follow-ups e campanhas cancelados não voltam.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => marcarPessoal.mutate()}>
              {t("Marcar como pessoal")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
