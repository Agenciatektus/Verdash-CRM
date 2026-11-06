"use client";

import { memo } from "react";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { ReacaoNoBalao } from "@/lib/inbox/reacoes-no-fio";
import type { Message } from "@/lib/types/messaging";

/**
 * Os gestos do fio, com identidade ESTÁVEL entre renders (ver `ChatThread`).
 *
 * Recebem o id da mensagem em vez de virem fechados sobre ele: assim uma única
 * instância serve a todas as bolhas e o `memo` abaixo compara por referência
 * sem falso "mudou" a cada mensagem nova do tempo real.
 */
export interface AcoesDoFio {
  responder: (m: Message) => void;
  encaminhar: (m: Message) => void;
  editar: (id: string, text: string) => Promise<void>;
  apagar: (id: string) => Promise<void>;
  ocultar: (id: string) => Promise<void>;
  restaurar: (id: string) => Promise<void>;
  /**
   * Rascunho da edição, por id da mensagem. Mora no fio, não na bolha: o fio
   * é virtualizado e a bolha que sai da tela desmonta — com o estado dentro
   * dela, quem rolava para conferir algo perdia o que estava digitando.
   */
  lerRascunho: (id: string) => string | null;
  gravarRascunho: (id: string, texto: string | null) => void;
}

interface Props {
  message: Message;
  searchMatch: boolean;
  debugCitations: boolean;
  citada: Message | null;
  viewerUserId: string;
  temResponder: boolean;
  /** Encaminhar a mensagem a outra conversa (#2835). */
  temEncaminhar?: boolean;
  /** Reações que apontam para este balão (#2815). */
  reacoes?: ReacaoNoBalao[];
  /** Canal altera enviada E quem lê é o autor (editar/apagar). */
  podeAlterar: boolean;
  /** Manager+ numa mensagem recebida (ocultar/restaurar). */
  podeModerar: boolean;
  /** Abre um bloco de falas do mesmo autor (`iniciaBloco`): nome e respiro em cima. */
  inicioDoBloco: boolean;
  acoes: AcoesDoFio;
  /** B15: a mensagem de saída falhou, é reenviável e ainda não foi reenviada. */
  podeReenviar?: boolean;
  /** O gesto de reenviar, com identidade estável (ver `useReenvioDoFio`). */
  reenviar?: (m: Message) => void;
}

/**
 * Uma bolha do fio, memoizada.
 *
 * Toda prop aqui é primitiva, a própria `Message` do cache (o tempo real troca
 * só o objeto da mensagem que mudou — `hooks/inbox/cacheDaThread.ts`) ou o
 * objeto de ações estável. A comparação rasa padrão do `memo` é, portanto, a
 * correta: chegar uma mensagem nova re-renderiza a lista, não as bolhas antigas.
 */
export const LinhaDaMensagem = memo(function LinhaDaMensagem({
  message,
  searchMatch,
  debugCitations,
  citada,
  viewerUserId,
  temResponder,
  temEncaminhar = false,
  reacoes,
  podeAlterar,
  podeModerar,
  inicioDoBloco,
  acoes,
  podeReenviar = false,
  reenviar,
}: Props) {
  const id = message.id;
  return (
    <MessageBubble
      message={message}
      searchMatch={searchMatch}
      debugCitations={debugCitations}
      onResponder={temResponder ? acoes.responder : undefined}
      onEncaminhar={temEncaminhar ? acoes.encaminhar : undefined}
      reacoes={reacoes}
      citada={citada}
      viewerUserId={viewerUserId}
      onEditar={podeAlterar ? (text) => acoes.editar(id, text) : undefined}
      rascunho={
        podeAlterar
          ? { ler: () => acoes.lerRascunho(id), gravar: (texto) => acoes.gravarRascunho(id, texto) }
          : undefined
      }
      onApagar={podeAlterar ? () => acoes.apagar(id) : undefined}
      onOcultar={podeModerar ? () => acoes.ocultar(id) : undefined}
      onRestaurar={podeModerar ? () => acoes.restaurar(id) : undefined}
      inicioDoBloco={inicioDoBloco}
      onReenviar={podeReenviar && reenviar ? () => reenviar(message) : undefined}
    />
  );
});
