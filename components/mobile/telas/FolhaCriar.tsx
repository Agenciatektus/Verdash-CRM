"use client";
import type { ComponentType } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { conversaAberta, destinoDeCriar, type OpcaoDeCriar } from "@/lib/mobile/abas";
import { useOpcoesDeCriar } from "@/lib/mobile/useOpcoesDeCriar";
import { CalendarPlus, ChatCircle, Kanban, ListChecks, Users } from "@/lib/ui/icons";

import { FolhaInferior, ItemDaFolha } from "../FolhaInferior";

const OPCOES: Record<OpcaoDeCriar, { icone: ComponentType<{ size?: number; "aria-hidden"?: boolean }>; titulo: string; apoio: string }> = {
  conversa: { icone: ChatCircle, titulo: "Nova conversa", apoio: "Primeira mensagem para um contato" },
  contato: { icone: Users, titulo: "Novo contato", apoio: "Pessoa ou empresa na base" },
  lead: { icone: Kanban, titulo: "Novo lead", apoio: "Negócio aberto em um funil" },
  tarefa: { icone: ListChecks, titulo: "Nova tarefa", apoio: "Próximo passo com prazo e responsável" },
  compromisso: { icone: CalendarPlus, titulo: "Novo compromisso", apoio: "Horário marcado na agenda" },
};

/**
 * A folha "Criar" do FAB (o item 05 do protótipo): as opções da tela, na ordem do
 * protótipo. Cada uma leva à tela que já cria aquilo, que abre a criação pelo
 * `?criar=1` e aplica a própria regra de permissão (o FAB nem aparece para quem não
 * pode criar: `usePodeCriar`).
 */
export function FolhaCriar({ aberta, aoMudar }: { aberta: boolean; aoMudar: (aberta: boolean) => void }) {
  const t = useT();
  const rota = usePathname() ?? "";
  const busca = useSearchParams()?.toString() ?? "";
  const naConversa = conversaAberta(rota, new URLSearchParams(busca).get("id"));
  const router = useRouter();
  const opcoes = useOpcoesDeCriar();
  // O funil padrão só é lido com a folha aberta e só se "Novo lead" depende dele.
  const precisaDoFunil = aberta && opcoes.includes("lead") && !/^\/app\/pipelines\//.test(rota);
  const funil = useDefaultPipeline(precisaDoFunil).data?.pipeline.id ?? null;

  const ir = (opcao: OpcaoDeCriar) => {
    aoMudar(false);
    router.push(destinoDeCriar(opcao, rota, funil, busca));
  };

  return (
    <FolhaInferior aberto={aberta} aoMudar={aoMudar} titulo={t("Criar")}>
      {opcoes.map((opcao) => {
        const o = OPCOES[opcao];
        return <ItemDaFolha key={opcao} icone={o.icone} titulo={t(o.titulo)} apoio={t(opcao === "tarefa" && naConversa ? "Presa a esta conversa e ao negócio" : o.apoio)} aoTocar={() => ir(opcao)} />;
      })}
    </FolhaInferior>
  );
}
