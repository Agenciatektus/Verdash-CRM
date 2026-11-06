"use client";
import { useParticipantesDaConversa } from "@/hooks/inbox/useParticipantesDaConversa";
import { forwardRef, useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { composerBloqueadoAteAssumir } from "@/lib/inbox/bloqueio-ate-assumir";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { motivoDaJanelaFechada, motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import { estadoDaJanela } from "@/lib/channels/janela";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { JanelaFechadaAviso } from "./JanelaFechadaAviso";
import { NumeroForaDoAr } from "./NumeroForaDoAr";
import { RetentionNotice } from "./RetentionNotice";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";

/**
 * A CONVERSA COM O CAMPO DE RESPOSTA — uma peça só, usada no Inbox e no dossiê
 * do negócio (Kanban).
 *
 * ─── Por que isto saiu do `InboxLayout` ─────────────────────────────────────
 *
 * O `ConversaSlot` do quadro registrou a regra: "duas cópias do mesmo campo
 * divergem". Ela continua valendo — e é por isso que o dossiê NÃO ganhou um
 * segundo composer. Ganhou ESTE componente, o mesmo que o Inbox monta. As
 * decisões que moravam soltas no layout (a janela de 24h que fecha o texto
 * livre, o contato bloqueado ou anonimizado, quem só pode ler,
 * a mensagem escolhida para responder "em cima") agora moram aqui, e as duas
 * telas herdam a mesma correção no mesmo commit.
 *
 * ─── Quem não pode responder não vê o campo ─────────────────────────────────
 *
 * `POST /api/v1/messages` exige `agent` (viewer é somente leitura). Antes, o
 * viewer via o composer liberado e descobria a regra pelo 403 no toast — uma
 * mensagem digitada e perdida por vez. O gate é o MESMO `inbox.reply` do
 * `usePermission`; a UI só deixa de prometer o que o servidor recusa.
 *
 * ─── O estado da resposta "em cima" é por conversa ──────────────────────────
 *
 * Quem monta passa `key={conversation.id}`. Trocar de conversa desmonta o
 * painel e zera a citação — sem isso a resposta sairia citando mensagem de
 * outro cliente (o defeito que o `handleSelect` do Inbox existia para evitar).
 */
export interface PainelDaConversaProps {
  conversation: ConversationWithContact;
  /**
   * `inbox` é a coluna do meio do Inbox. `dossie` é a coluna do dossiê do
   * negócio: mesma conversa, só sem o aviso de retenção (o dossiê já tem a
   * linha do tempo como registro, e o espaço vertical ali é mais disputado).
   */
  onde?: "inbox" | "dossie";
  /** Busca dentro da conversa (#1793): o termo realça as mensagens carregadas. */
  searchTerm?: string;
  /**
   * Abre outra conversa do mesmo contato (aviso de número fora do ar). Só o
   * Inbox navega entre conversas; sem este callback o aviso não é montado.
   */
  onAbrirConversa?: (id: string) => void;
  /** Rascunho sugerido por integração (issue #1611) — `null` é o caso comum. */
  rascunho?: AvisoDeRascunho | null;
  /** Encaminhar mensagem (#2835): quem monta abre o diálogo de destino. Sem isto o gesto não aparece. */
  onEncaminhar?: (m: ConversationMensagem) => void;
}

export const PainelDaConversa = forwardRef<ComposerHandle, PainelDaConversaProps>(
  function PainelDaConversa(
    { conversation, onde = "inbox", searchTerm = "", onAbrirConversa, rascunho = null, onEncaminhar },
    composerRef,
  ) {
    const t = useT();
    // Acompanhamento de suporte somente leitura já chega aqui como `viewer`
    // (`resolveActiveOrg` o rebaixa), então este gate também o cobre.
    const podeResponder = usePermission("inbox.reply");
    const { activeOrg, user } = useAuth();
  // Atendimento conjunto (#2848): quem participa da conversa não fica travado até assumir.
  const participantes = useParticipantesDaConversa(conversation.id);
  const participaDoAtendimento = participantes.data?.some((p) => p.user_id === user?.id) === true;

    /**
     * A mensagem escolhida para responder "em cima". Quem ESCOLHE é a lista de
     * mensagens e quem MOSTRA é o composer — irmãos, então o estado é daqui.
     */
    const [respondendo, setRespondendo] = useState<ConversationMensagem | null>(null);

    // A janela vence SOZINHA com a tela aberta. Sem este relógio, quem deixa a
    // conversa aberta a tarde inteira seguiria com o composer liberado numa
    // conversa que já venceu — e o bloqueio só apareceria no próximo reload.
    const [agoraJanela, setAgoraJanela] = useState(() => new Date());
    useEffect(() => {
      const timer = setInterval(() => setAgoraJanela(new Date()), 30_000);
      return () => clearInterval(timer);
    }, []);

    // A janela de 24h fecha o composer, e o motivo DIZ há quanto tempo fechou.
    // Reusa o `blockedReason` em vez de um segundo mecanismo de bloqueio: dois
    // caminhos para desabilitar o mesmo composer divergem, e o segundo esquece
    // de cobrir o áudio ou o anexo.
    const provider = conversation.channel_sessions?.provider ?? null;
    const janela = estadoDaJanela(provider, conversation.last_inbound_at ?? null, agoraJanela);
    // Os textos moram em lib/inbox/motivo-do-envio-bloqueado.ts (upstream 1.76):
    // o "Enviar link" da videochamada desabilita na mesma conversa com o MESMO motivo.
    const motivoDaJanela = motivoDaJanelaFechada(janela, provider, t);

    const blockedReason = motivoDoContato(conversation.contacts, t);

    return (
      <>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatThread
            conversationId={conversation.id}
            searchTerm={searchTerm}
            provider={provider}
            onResponder={podeResponder ? setRespondendo : undefined}
            onEncaminhar={podeResponder ? onEncaminhar : undefined}
            // O cartão da passagem escolhe o gesto a partir de quem é o dono da
            // conversa: sem dono convida a assumir, com outro dono diz quem
            // atende. Sem estes campos ele ficaria mudo para quem mais precisa.
            dono={{
              userId: conversation.assigned_to_user_id ?? null,
              nome: conversation.assigned_to_user_name ?? null,
            }}
            contatoId={conversation.contacts?.id ?? null}
            // O divisor "Novas mensagens" sai desta contagem, lida na abertura.
            naoLidas={conversation.unread_count_for_assignee ?? 0}
          />
        </div>
        {onde === "inbox" && <RetentionNotice conversationId={conversation.id} />}
        {onAbrirConversa && conversation.contacts?.id && (
          <NumeroForaDoAr
            key={`numero:${conversation.id}`}
            conversationId={conversation.id}
            channelSessionId={conversation.channel_session_id}
            contactId={conversation.contacts.id}
            contactPhone={conversation.contacts.phone_number ?? null}
            onAbrirConversa={onAbrirConversa}
          />
        )}
        {podeResponder ? (
          <>
            {motivoDaJanela && (
              <JanelaFechadaAviso
                conversationId={conversation.id}
                provider={provider}
                motivo={motivoDaJanela}
              />
            )}
            <Composer
              // Trocar a chave quando o rascunho sai REMONTA o composer: o texto
              // nasce de `useState(initialDraft)`, e só a prop mudar não o limparia.
              key={rascunho ? `rascunho:${rascunho.conversationId}` : "composer"}
              ref={composerRef}
              conversationId={conversation.id}
              blockedReason={blockedReason}
              janelaFechada={motivoDaJanela}
              disabled={conversation.status === "closed"}
              fechada={conversation.status === "closed"}
              // A caixa travada até assumir (#3012): opção da ORGANIZAÇÃO; desligada
              // (o padrão) a expressão é `false`, e assumir libera sozinho.
              aguardandoAssumir={composerBloqueadoAteAssumir({
                ligada: activeOrg?.interface_settings?.bloquearAteAssumir === true,
                donoDaConversa: conversation.assigned_to_user_id,
                atendenteId: user.id,
                // Convidado no atendimento conjunto (#2848) escreve sem assumir.
                participanteAtivo: participaDoAtendimento,
              })}
              // A barra de recursos lembra o recolhimento POR usuário (#3282).
              usuarioId={user.id}
              contatoBloqueadoId={conversation.contacts?.is_blocked ? (conversation.contacts.id ?? null) : null}
              contactName={conversation.contacts?.name ?? null}
              contactDisplayName={conversation.contacts?.display_name}
              respondendo={respondendo}
              onCancelarResposta={() => setRespondendo(null)}
              currentContactId={conversation.contact_id}
              rascunho={rascunho}
              initialDraft={rascunho?.leitura.estado === "sugerido" ? rascunho.leitura.texto : ""}
              // Quem atende decide a faixa acima da caixa: a IA atendendo
              // (com Assumir) ou ninguém (com Puxar para mim).
              conversa={conversation}
            />
          </>
        ) : (
          // Modo leitura: no lugar do composer, a mesma faixa do visual novo,
          // sem caixa e sem gesto, porque o servidor recusaria qualquer envio.
          <div className="bg-bg px-4 pb-3.5 pt-2.5">
            <p
              className="rounded-2xl border border-border bg-surface px-3.5 py-3 text-center text-sm text-text-muted"
              data-testid="conversa-somente-leitura"
            >
              {t("Seu acesso é de leitura: você acompanha a conversa, mas não responde.")}
            </p>
          </div>
        )}
      </>
    );
  },
);
