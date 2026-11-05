"use client";

import { useT } from "@/hooks/i18n/useT";
import { adiarFechamento } from "@/lib/ui/fechar-negocio";
import { useQueryClient } from "@tanstack/react-query";

import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { MoveToOtherPipelineDialog } from "@/components/kanban/MoveToOtherPipelineDialog";
import { avisarQueOCrmDoContatoMudou } from "@/lib/inbox/releitura-do-contato";

import { DialogoDeTransferir } from "./DialogoDeTransferir";
import { TarefaDaConversa } from "./TarefaDaConversa";
import { chaveDoResumoDoMenu, type DialogoDoFunil } from "./SubmenuDoFunil";

export type DialogoDoMenu =
  | { tipo: "transferir"; conversationId: string; destino: { userId: string; nome: string } }
  | { tipo: "adicionar-tarefa"; contactId: string }
  | (DialogoDoFunil & { contactId: string });

/**
 * As janelas que o menu abre e que sobrevivem a ele fechar: transferir e os
 * formulários do funil. Fechar e Arquivar agem na hora, com "Desfazer" no aviso
 * (`useEncerrarComDesfazer`), e Bloquear confirma DENTRO do menu
 * (`ConfirmarBloqueio`), como o quadro DS pede.
 */
export function DialogosDoMenu({ dialogo, onFechar }: {
  dialogo: DialogoDoMenu | null;
  onFechar: () => void;
}) {
  const qc = useQueryClient();
  const t = useT();
  const aoMudar = (open: boolean) => {
    if (!open) onFechar();
  };

  if (!dialogo) return null;

  if (dialogo.tipo === "transferir") {
    return <DialogoDeTransferir conversationId={dialogo.conversationId} destino={dialogo.destino} onFechar={onFechar} />;
  }

  if (dialogo.tipo === "adicionar-tarefa") {
    return <TarefaDaConversa contactId={dialogo.contactId} onFechar={onFechar} />;
  }

  if ("lead" in dialogo) {
    const { lead, contactId } = dialogo;
    const reler = () => {
      void qc.invalidateQueries({ queryKey: chaveDoResumoDoMenu(contactId) });
      avisarQueOCrmDoContatoMudou(contactId);
    };
    return dialogo.tipo === "perder" ? (
      <LoseLeadDialog
        open
        onOpenChange={aoMudar}
        aoConcluir={reler}
        leadId={lead.id}
        pipelineId={lead.pipeline_id}
        motivosDoFunil={lead.motivos_de_perda}
        motivoObrigatorio={lead.motivo_de_perda_obrigatorio !== false}
        // Perda e troca pelo menu: adiadas com Desfazer e com a trava por negócio,
        // como no painel (P2-1 do Cassio na #181). Relê só depois de gravar.
        adiar={(gravar) =>
          adiarFechamento("perda", lead.id, (s) => `${t("Perdido em")} ${s} s`, t, () =>
            gravar().then(reler, () => undefined),
          )
        }
      />
    ) : (
      <MoveToOtherPipelineDialog
        open
        onOpenChange={aoMudar}
        aoConcluir={reler}
        leadId={lead.id}
        pipelineId={lead.pipeline_id}
        adiar={(gravar) =>
          adiarFechamento("troca", lead.id, (s) => `${t("Outro funil em")} ${s} s`, t, () =>
            gravar().then(reler, () => undefined),
          )
        }
      />
    );
  }

  if (dialogo.tipo === "criar-lead") {
    return <CriarLeadDoContato contactId={dialogo.contactId} onFechar={onFechar} />;
  }

  return null;
}

/**
 * "Criar lead" para o contato sem negócio (M2.4): o MESMO `NewLeadDialog` da aba
 * Negócios do painel, no funil padrão e já com o contato. A rota (`POST /leads`)
 * aplica o papel; o item só aparece para quem pode criar.
 */
function CriarLeadDoContato({ contactId, onFechar }: { contactId: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const padrao = useDefaultPipeline(true);
  if (!padrao.data) return null;
  return (
    <NewLeadDialog
      open
      onOpenChange={(open) => !open && onFechar()}
      pipelineId={padrao.data.pipeline.id}
      stages={padrao.data.stages}
      contactId={contactId}
      onCreated={() => {
        void qc.invalidateQueries({ queryKey: chaveDoResumoDoMenu(contactId) });
        avisarQueOCrmDoContatoMudou(contactId);
      }}
    />
  );
}
