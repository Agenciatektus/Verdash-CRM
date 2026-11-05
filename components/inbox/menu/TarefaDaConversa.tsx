"use client";

import { useState } from "react";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useFunilDoContato } from "@/hooks/inbox/useFunilDoContato";
import { useTasks } from "@/hooks/tasks/useTasks";
import { usePedidoDeCriar } from "@/lib/mobile/usePedidoDeCriar";
import { usePodeCriar } from "@/lib/mobile/usePodeCriar";
import type { NovaTarefa } from "@/lib/tarefas/tipos";

/**
 * "Adicionar tarefa" DE DENTRO DA CONVERSA: a tarefa nasce presa ao contato e ao
 * negócio ABERTO dele (o mesmo critério do painel, `leadEmFoco.status === "open"`).
 * O atendente usa a tarefa como follow-up manual; solta, ela some do card do negócio.
 *
 * O formulário só abre depois de o resumo do CRM do contato chegar: criar antes
 * gravaria a tarefa sem o negócio, que é o defeito que esta tela existe para evitar.
 * Mesmo `FormularioDeTarefa` da tela de Tarefas e do painel, para prazo, prioridade
 * e permissão não divergirem.
 */
export function TarefaDaConversa({ contactId, onFechar }: { contactId: string; onFechar: () => void }) {
  const usuario = useUser();
  // Só a mutation: a lista não é lida aqui (`enabled: false`).
  const { criarTarefa } = useTasks({ contact_id: contactId }, { enabled: false });
  const { resumo, lead } = useFunilDoContato(contactId, true, () => undefined);
  if (resumo.isPending) return null;
  return (
    <FormularioDeTarefa
      aberto
      aoMudarAbertura={(aberto) => !aberto && onFechar()}
      tarefa={null}
      aoSalvar={(entrada: NovaTarefa) => criarTarefa(entrada)}
      leadId={lead?.status === "open" ? lead.id : null}
      contactId={contactId}
      responsavelPadrao={usuario.id}
    />
  );
}

/** O "+" do celular com a conversa aberta chega com `?tarefa=1` (ver `destinoDeCriar`). */
export function TarefaPedidaPelaUrl({ contactId }: { contactId: string }) {
  const [aberta, setAberta] = useState(false);
  const podeCriar = usePodeCriar();
  usePedidoDeCriar(() => setAberta(true), podeCriar, "tarefa");
  return aberta ? <TarefaDaConversa contactId={contactId} onFechar={() => setAberta(false)} /> : null;
}
