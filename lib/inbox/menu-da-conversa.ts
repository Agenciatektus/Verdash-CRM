import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { comandoDaConversa, type MotivoDoSilencio } from "@/lib/inbox/comando-da-conversa";
import { lembreteAtivo as lembreteValendo } from "@/lib/inbox/opcoes-do-lembrete";

/**
 * O QUE O MENU DE CONTEXTO DA LISTA OFERECE PARA UMA CONVERSA.
 *
 * ⚠️ NENHUMA REGRA NOVA. Cada condição abaixo é a MESMA do cabeçalho da
 * conversa (`ConversationHeader`), copiada para uma função pura porque o menu
 * mora na lista e não pode importar o cabeçalho. Se uma das duas mudar, a outra
 * tem que acompanhar: o atendente não pode ver "Fechar" no menu de uma conversa
 * cujo cabeçalho não oferece fechar.
 *
 * `leitura` junta o acompanhamento de suporte somente leitura e o papel abaixo
 * de `agent` (as rotas de escrita da conversa são todas `requireRole("agent")`).
 * Em leitura sobram só os gestos que não gravam nada: abrir a ficha e copiar o
 * telefone.
 */
export interface RegrasDoMenu {
  assumir: boolean;
  liberar: boolean;
  devolver: boolean;
  pausar: boolean;
  transferir: boolean;
  lembrar: boolean;
  etiquetas: boolean;
  funil: boolean;
  /** Adicionar tarefa presa ao contato e ao negócio da conversa. */
  tarefa: boolean;
  fechar: boolean;
  reabrir: boolean;
  arquivar: boolean;
  ficha: boolean;
  copiarTelefone: boolean;
  /** O status já terminou (fechada, resolvida ou arquivada). */
  encerrada: boolean;
  /** Por que o automático está calado, para o texto do "Devolver". */
  motivo: MotivoDoSilencio | null;
  /** O lembrete ainda está de pé: o submenu oferece cancelar. */
  lembreteAtivo: boolean;
}

export interface EntradaDoMenu {
  conversation: ConversationWithContact;
  meuUserId: string | null;
  leitura: boolean;
  automaticoDaOrg?: boolean;
  agora?: Date;
}

export function regrasDoMenu({
  conversation,
  meuUserId,
  leitura,
  automaticoDaOrg,
  agora = new Date(),
}: EntradaDoMenu): RegrasDoMenu {
  const c = conversation.contacts ?? null;
  const status = conversation.status;
  const { automaticoAtivo, travaVigente, motivo } = comandoDaConversa(
    {
      status,
      assigned_to_user_id: conversation.assigned_to_user_id,
      assigned_to_user_name: conversation.assigned_to_user_name ?? null,
      assignee_kind: conversation.assignee_kind ?? null,
      bot_silenced_until: conversation.bot_silenced_until ?? null,
      last_handoff_reason: conversation.last_handoff_reason ?? null,
      force_human: c?.force_human ?? null,
      is_blocked: c?.is_blocked ?? null,
      is_group: conversation.is_group ?? false,
      automaticoDaOrg,
    },
    agora,
  );

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  const minha = meuUserId !== null && conversation.assigned_to_user_id === meuUserId;
  // A mesma conta do cabeçalho: sem dono OU status aberto. Fica de fora só o caso
  // em que a conversa já é minha, onde "Assumir" não mudaria nada.
  const aberta = status === "open" || conversation.assigned_to_user_id == null;
  const escreve = !leitura;
  const lembreteAtivo = lembreteValendo(conversation.snooze_until, agora);
  const telefone = !conversation.is_group && !!c?.phone_number;

  return {
    assumir: escreve && aberta && !minha,
    liberar: escreve && minha,
    devolver: escreve && travaVigente,
    pausar: escreve && automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null,
    transferir: escreve && !encerrada,
    lembrar: escreve && !encerrada,
    etiquetas: escreve,
    funil: escreve && !!c?.id,
    tarefa: escreve && !!c?.id,
    fechar: escreve && !encerrada,
    reabrir: escreve && encerrada,
    arquivar: escreve && status !== "archived",
    ficha: !!c?.id,
    copiarTelefone: telefone,
    encerrada,
    motivo,
    lembreteAtivo,
  };
}

/** Mesmo teto e mesma normalização do editor de tags (espelham o Zod do PATCH). */
export const MAXIMO_DE_ETIQUETAS = 20;

/**
 * 9045: marcar/desmarcar vira um DELTA, nunca a lista inteira. O banco aplica
 * sobre o valor atual, então a etiqueta que outra pessoa pôs no meio fica.
 * `null` quando acrescentar passaria do teto (o banco também recusa).
 */
export function deltaDaEtiqueta(
  atuais: string[],
  tag: string,
): { adicionar: string[] } | { remover: string[] } | null {
  if (atuais.includes(tag)) return { remover: [tag] };
  if (atuais.length >= MAXIMO_DE_ETIQUETAS) return null;
  return { adicionar: [tag] };
}
