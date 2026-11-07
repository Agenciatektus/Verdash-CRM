"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { Receipt, Users } from "@/lib/ui/icons";

import { AcervoSearch } from "../AcervoSearch";
import { EditorDoNegocio } from "./EditorDoNegocio";
import { SemLista, formatMoney } from "./SemLista";
import type { LeadRow, OrderRow } from "./tipos";

interface Props {
  contactId: string | null;
  leads: LeadRow[] | null;
  orders: OrderRow[] | null;
  carregando: boolean;
  erro: boolean;
  leitura: boolean;
  leadAtivoId: string | null;
  onSelecionarLead: (id: string | null) => void;
  recarregar: () => void;
}

/**
 * A aba Negócios: o que se vende para este contato.
 *
 * "Novo negócio" mora aqui, e não no cabeçalho, porque é ao lado dos negócios que
 * existem que a pessoa decide se precisa de outro. O Acervo também: é a consulta
 * que responde "quanto custa", "tem pronta entrega", a conversa de venda.
 */
export function AbaNegocios({
  contactId, leads, orders, carregando, erro, leitura, leadAtivoId, onSelecionarLead, recarregar,
}: Props) {
  const t = useT();
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const defaultPipeline = useDefaultPipeline(leadDialogOpen);

  useEffect(() => {
    if (leadDialogOpen && defaultPipeline.isError) {
      toast.error(t("Nenhum funil configurado nesta organização."));
      setLeadDialogOpen(false);
    }
  }, [leadDialogOpen, defaultPipeline.isError, t]);

  const carregandoFunil = leadDialogOpen && defaultPipeline.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <section data-testid="inbox-campos-lead">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-text">{t("Negócios recentes")}</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={leitura || !contactId || carregandoFunil}
            onClick={() => setLeadDialogOpen(true)}
          >
            <Users size={12} className="mr-1" weight="regular" aria-hidden />
            {carregandoFunil ? t("Carregando…") : t("Novo negócio")}
          </Button>
        </div>
        {carregando ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <EditorDoNegocio
            leads={leads}
            contactId={contactId}
            selecionadoId={leadAtivoId}
            onSelecionar={onSelecionarLead}
            onSalvo={recarregar}
            leitura={leitura}
          />
        ) : (
          <SemLista vazio={t("Sem negócios.")} erro={erro} onTentarDeNovo={recarregar} />
        )}
      </section>

      {contactId && defaultPipeline.data && (
        <NewLeadDialog
          open={leadDialogOpen}
          onOpenChange={setLeadDialogOpen}
          pipelineId={defaultPipeline.data.pipeline.id}
          stages={defaultPipeline.data.stages}
          // #3038: os campos exigidos pela etapa vão no `settings` do funil padrão.
          settings={defaultPipeline.data.pipeline.settings}
          contactId={contactId}
          onCreated={() => {
            onSelecionarLead(null);
            recarregar();
          }}
        />
      )}

      <Separator />

      <section data-testid="inbox-pedidos">
        <h3 className="text-xs font-semibold text-text">{t("Pedidos recentes")}</h3>
        {carregando ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : orders && orders.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between rounded-md border border-border p-2 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 truncate font-medium">
                    <Receipt size={11} weight="regular" aria-hidden />
                    {o.external_id ?? o.id.slice(0, 8)}
                  </div>
                  <div className="text-muted-foreground">
                    {o.status ?? "—"} · {formatMoney(o.total_cents, o.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista vazio={t("Sem pedidos.")} erro={erro} onTentarDeNovo={recarregar} />
        )}
      </section>

      <Separator />

      {/* Perguntar ao acervo: a MESMA busca que a IA faz, com a origem de cada
          trecho. Quem decide limiar e top-K é a rota (`buscarConhecimento`). */}
      <section>
        <h3 className="text-xs font-semibold">{t("Acervo")}</h3>
        <p className="mb-2 mt-1 text-xs text-muted-foreground">
          {t("Pergunte como a IA perguntaria — a resposta vem com a origem de cada trecho.")}
        </p>
        <AcervoSearch />
      </section>
    </div>
  );
}
