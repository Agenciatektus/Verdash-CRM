"use client";

import { useState } from "react";

import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { useFunilDoContato, type DialogoDoFunil } from "@/hooks/inbox/useFunilDoContato";
import { cn } from "@/lib/utils";
import { Funnel } from "@/lib/ui/icons";

import { CLASSE_DO_DETALHE, CLASSE_DO_ITEM, CLASSE_DO_SUBMENU, CLASSE_DO_TITULO } from "./estilo";

// A régua do funil mora em `useFunilDoContato` (o menu e a faixa do celular a usam);
// os nomes seguem exportados daqui para quem já os importava.
export { chaveDoResumoDoMenu, type DialogoDoFunil } from "@/hooks/inbox/useFunilDoContato";

/**
 * TROCAR DE FUNIL OU ETAPA PELO MENU DA LISTA.
 *
 * O `crm-summary` é buscado SÓ quando o submenu abre (abrir o menu para assumir
 * não paga a leitura do CRM) e fica 30 s em cache: reabrir o submenu na mesma
 * conversa não refaz o pedido. O negócio é o mesmo que o painel mostra primeiro
 * (`leads[0]`, o mais recente).
 *
 * ⚠️ Nenhuma régua nova; cada destino é a porta que o `SeletorDeEtapa` já usa:
 *   - etapa aberta → `useMoveCard` (`/move`, com o CAS por `updated_at`);
 *   - etapa de ganho → `useWinLead` (`/win`);
 *   - etapa de perda → `LoseLeadDialog`, que exige o motivo;
 *   - outro funil → `MoveToOtherPipelineDialog` (`/clone`, move o mesmo card).
 */
export function SubmenuDoFunil({ contactId, onDialogo }: {
  contactId: string;
  onDialogo: (d: DialogoDoFunil) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const { resumo, lead, etapas, indiceAtual, escolher, mover, ganhar, ganhoPendente } = useFunilDoContato(contactId, aberto, onDialogo);
  const detalhe = !lead
    ? null
    : lead.status === "won"
      ? t("Ganho")
      : lead.status === "lost"
        ? t("Perdido")
        : (lead.etapa_nome ?? null);

  return (
    <DropdownMenuSub open={aberto} onOpenChange={setAberto}>
      <DropdownMenuSubTrigger className={CLASSE_DO_ITEM}>
        <Funnel size={16} aria-hidden />
        <span className="grow">{t("Funil e etapa")}</span>
        {detalhe && <span className={cn(CLASSE_DO_DETALHE, "max-w-24")}>{detalhe}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent folhaNoCelular className={cn(CLASSE_DO_SUBMENU, "w-[250px]")} collisionPadding={8} aria-labelledby={undefined} aria-label={t("Funil e etapa")}>
          {resumo.isLoading && <DropdownMenuItem disabled className={CLASSE_DO_ITEM}>{t("Carregando…")}</DropdownMenuItem>}
          {resumo.isError && (
            <DropdownMenuItem disabled className={CLASSE_DO_ITEM}>{t("Não foi possível ler o funil.")}</DropdownMenuItem>
          )}
          {resumo.isSuccess && !lead && (
            <>
              <DropdownMenuItem disabled className={CLASSE_DO_ITEM}>{t("Este contato não tem negócio")}</DropdownMenuItem>
              {/* "Criar lead" (M2.4). O submenu inteiro só existe para quem escreve
                  (`regrasDoMenu().funil`: agent+, nunca suporte só leitura), a mesma
                  régua de `POST /leads`. */}
              <DropdownMenuItem className={CLASSE_DO_ITEM} onSelect={() => onDialogo({ tipo: "criar-lead" })}>
                {t("Criar negócio")}
              </DropdownMenuItem>
            </>
          )}
          {lead && (
            <>
              {lead.funil_nome && <div className={CLASSE_DO_TITULO}>{lead.funil_nome}</div>}
              {lead.status !== "open" ? (
                // Reabrir cria um negócio NOVO: fica no painel, com a confirmação dele.
                <DropdownMenuItem disabled className={CLASSE_DO_ITEM}>
                  {lead.status === "won" ? t("Negócio ganho") : t("Perdido")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuRadioGroup value={lead.stage_id} onValueChange={escolher}>
                  {etapas.map((e, i) => (
                    <DropdownMenuRadioItem
                      key={e.id}
                      value={e.id}
                      disabled={mover.isPending || ganhar.isPending || ganhoPendente}
                      className="h-[34px] gap-2 rounded-lg text-[13.5px] focus:bg-surface-elevated focus:text-text"
                    >
                      <span
                        aria-hidden
                        data-etapa={i < indiceAtual ? "feita" : i === indiceAtual ? "atual" : "adiante"}
                        className={cn(
                          "size-[9px] shrink-0 rounded-full border-[1.5px] border-border-strong",
                          i <= indiceAtual && "border-accent bg-accent",
                          i === indiceAtual && "ring-[3px] ring-accent-soft",
                        )}
                      />
                      <span className="min-w-0 truncate">{e.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
              {/* Negócio ganho também vai para outro funil (pós-venda, recompra): o servidor já aceita. */}
              {(lead.status === "open" || lead.status === "won") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className={CLASSE_DO_ITEM} onSelect={() => onDialogo({ tipo: "outro-funil", lead })}>
                    {t("Levar para outro funil…")}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
