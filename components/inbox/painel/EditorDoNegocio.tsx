"use client";

import { useState } from "react";
import { toast } from "sonner";

import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { SeletorDeEtapa } from "@/components/kanban/SeletorDeEtapa";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";
import { Funnel } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AcoesDoNegocio } from "./AcoesDoNegocio";
import { BarraDeEtapas } from "./BarraDeEtapas";
import { MenuDoLead } from "./MenuDoLead";
import { formatMoney } from "./SemLista";
import type { LeadRow } from "./tipos";

/**
 * O banco guarda `open`/`won`/`lost`; a tela mostrava a palavra crua (#943).
 *
 * ⚠️ NÃO troque "Ganho"/"Perdido" por `crm_pipelines.vocabulary` sem antes
 * mudar o que essa coluna guarda. O DEFAULT dela é o de e-commerce (`won:
 * Pago`, `lost: Cancelado`) e nenhum caminho normal a reescreve: uma clínica
 * recém-instalada veria "Pago" ao lado de "Consulta marcada". Guardado em
 * tests/unit/inbox-leads-recentes-com-funil.test.tsx.
 */
const STATUS_DO_LEAD: Record<string, string> = { open: "Aberto", won: "Ganho", lost: "Perdido" };

/** "Funil · Etapa": sem isto dois leads de mesmo título ficam idênticos (#943). */
function ondeEstaOLead(l: LeadRow): string {
  return [l.funil_nome, l.etapa_nome].filter(Boolean).join(" · ");
}

/**
 * `line-clamp-2`, não `truncate`: corte de texto some pela DIREITA, e a metade
 * perdida seria sempre a ETAPA, que é o dado novo. O `title` devolve a frase
 * inteira no hover. ⚠️ NÃO medido: a largura em que a segunda linha também
 * estoura, e o celular (sem hover).
 */
const CLASSES_DE_ONDE_ESTA = "line-clamp-2 text-muted-foreground";

/** Só os campos do funil: título, valor e tags têm casa no dossiê. */
function CamposDoFunil({ leadId, pipelineId, fieldDefs, valores, onSalvo }: {
  leadId: string;
  pipelineId: string;
  fieldDefs: CustomFieldDef[];
  valores: Record<string, unknown>;
  onSalvo: () => void;
}) {
  const t = useT();
  const edit = useEditLead(pipelineId);
  const [customFields, setCustomFields] = useState(valores);
  // A RÉGUA do diff (upstream #2132): o valor carregado quando o painel abriu.
  // Só o que a pessoa mudar daqui vai viajar — o merge é do servidor.
  const [camposCarregados, setCamposCarregados] = useState(valores);

  if (fieldDefs.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("Este funil não tem campos extras.")}</p>;
  }

  async function salvar() {
    try {
      const payload = soChavesAlteradas(camposCarregados, customFields);
      await edit.mutateAsync({ leadId, patch: { custom_fields: payload } });
      // O que acabou de gravar vira a nova régua: o próximo salvamento não
      // reenvia este, e uma limpeza alheia no intervalo não é atropelada.
      setCamposCarregados({ ...customFields });
      toast.success(t("Campos atualizados"));
      onSalvo();
    } catch {
      // o toast de erro já saiu pelo hook
    }
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-text">{t("Campos do funil")}</h4>
      <CustomFieldsEditor fields={fieldDefs} value={customFields} onChange={setCustomFields} mode="lead" leadId={leadId} className="gap-3" />
      <Button size="sm" className="h-7 w-full text-xs" disabled={edit.isPending} onClick={() => void salvar()}>
        {edit.isPending ? t("Salvando…") : t("Salvar")}
      </Button>
    </div>
  );
}

/**
 * O negócio do contato: qual deles, a etapa, as ações e os campos do funil.
 *
 * `leitura` desliga TUDO que grava num `<fieldset disabled>`: é o mesmo gesto
 * que o painel antigo fazia, e alcança até o editor de campos sem que cada
 * input precise saber de permissão.
 */
export function EditorDoNegocio({ leads, contactId, selecionadoId, onSelecionar, onSalvo, leitura }: {
  leads: LeadRow[];
  contactId: string | null;
  selecionadoId: string | null;
  onSelecionar: (id: string) => void;
  onSalvo: () => void;
  leitura: boolean;
}) {
  const t = useT();
  const ativo = leads.find((l) => l.id === selecionadoId) ?? leads[0]!;
  const status = (l: LeadRow) => t(STATUS_DO_LEAD[l.status] ?? l.status);

  return (
    <div className="mt-2 space-y-3">
      {leads.length > 1 && (
        <ul className="space-y-1">
          {leads.map((l) => {
            const marcado = l.id === ativo.id;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  data-testid={`inbox-lead-${l.id}`}
                  aria-pressed={marcado}
                  onClick={() => onSelecionar(l.id)}
                  className={cn("w-full rounded-md border p-2 text-left text-xs", marcado ? "border-accent bg-accent/10" : "border-border")}
                >
                  <div className="truncate font-medium">{l.title}</div>
                  <div className={CLASSES_DE_ONDE_ESTA} title={ondeEstaOLead(l)}>{ondeEstaOLead(l)}</div>
                  <div className="text-muted-foreground">{status(l)} · {formatMoney(l.value_cents, l.currency)}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {leads.length === 1 && (
        <div data-testid="inbox-lead-unico" className="text-xs text-muted-foreground">
          <p>{ativo.title} · {status(ativo)} · {formatMoney(ativo.value_cents, ativo.currency)}</p>
          <p className={CLASSES_DE_ONDE_ESTA} title={ondeEstaOLead(ativo)}>{ondeEstaOLead(ativo)}</p>
        </div>
      )}
      {/* P14 e P13: o funil em chip, o valor em destaque e o menu "…" do lead. */}
      <div className="flex items-center gap-2" data-testid="inbox-cabecalho-do-negocio">
        {ativo.funil_nome && (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-muted">
            <Funnel size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{ativo.funil_nome}</span>
          </span>
        )}
        <b className="ml-auto shrink-0 text-sm font-bold text-text tabular-nums">
          {formatMoney(ativo.value_cents, ativo.currency)}
        </b>
        <MenuDoLead
          leadId={ativo.id}
          pipelineId={ativo.pipeline_id}
          titulo={ativo.title}
          leitura={leitura}
          onExcluido={onSalvo}
        />
      </div>
      <BarraDeEtapas
        key={`barra-${ativo.id}`}
        leadId={ativo.id}
        pipelineId={ativo.pipeline_id}
        stageId={ativo.stage_id}
        posicao={ativo.position_in_stage ?? null}
        updatedAt={ativo.updated_at}
        aberto={ativo.status === "open"}
        etapas={ativo.etapas ?? []}
        leitura={leitura}
        onMovido={onSalvo}
      />
      <fieldset disabled={leitura} className="space-y-3">
        <div className="flex items-center gap-2 text-xs" data-testid="inbox-etapa-do-negocio">
          <span className="text-muted-foreground">{t("Etapa")}</span>
          <span data-testid="inbox-etapa-select">
            <SeletorDeEtapa
              key={ativo.id}
              leadId={ativo.id}
              pipelineId={ativo.pipeline_id}
              stageId={ativo.stage_id}
              updatedAt={ativo.updated_at}
              aberto={ativo.status === "open"}
              etapas={ativo.etapas ?? []}
              motivosDoFunil={ativo.motivos_de_perda}
              motivoObrigatorio={ativo.motivo_de_perda_obrigatorio !== false}
              onMovido={onSalvo}
            />
          </span>
        </div>
        <AcoesDoNegocio key={`acoes-${ativo.id}`} lead={ativo} contactId={contactId} leitura={leitura} onMudou={onSalvo} />
        <CamposDoFunil
          key={ativo.id}
          leadId={ativo.id}
          pipelineId={ativo.pipeline_id}
          fieldDefs={ativo.field_defs ?? []}
          valores={ativo.custom_fields ?? {}}
          onSalvo={onSalvo}
        />
      </fieldset>
    </div>
  );
}
