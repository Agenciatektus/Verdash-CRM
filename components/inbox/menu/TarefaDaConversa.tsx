"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
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
 * O formulário só abre depois de o resumo do CRM do contato chegar (e nunca com ele em erro): criar antes
 * gravaria a tarefa sem o negócio, que é o defeito que esta tela existe para evitar.
 * Mesmo `FormularioDeTarefa` da tela de Tarefas e do painel, para prazo, prioridade
 * e permissão não divergirem.
 */
export function TarefaDaConversa({ contactId, onFechar }: { contactId: string; onFechar: () => void }) {
  const t = useT();
  const usuario = useUser();
  // Só a mutation: a lista não é lida aqui (`enabled: false`).
  const { criarTarefa } = useTasks({ contact_id: contactId }, { enabled: false });
  const { resumo } = useFunilDoContato(contactId, true, () => undefined);
  // Resumo que falhou NÃO abre o formulário: gravaria a tarefa sem o negócio, em silêncio.
  useEffect(() => {
    if (!resumo.isError) return;
    toast.error(t("Não foi possível ler o negócio do contato. Tente de novo."));
    onFechar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumo.isError]);
  if (resumo.isPending || resumo.isError) return null;
  // O negócio ABERTO, não o primeiro: o resumo ordena por atualização e traz ganhos e perdidos junto.
  const aberto = resumo.data?.find((l) => l.status === "open") ?? null;
  return (
    <FormularioDeTarefa
      aberto
      aoMudarAbertura={(aberto) => !aberto && onFechar()}
      tarefa={null}
      aoSalvar={(entrada: NovaTarefa) => criarTarefa(entrada)}
      leadId={aberto?.id ?? null}
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
  return aberta ? <TarefaDaConversa key={contactId} contactId={contactId} onFechar={() => setAberta(false)} /> : null;
}
