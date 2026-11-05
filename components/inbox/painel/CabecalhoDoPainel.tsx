"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { ContactSummary } from "@/hooks/inbox/useConversationsRealtime";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { copyToClipboard } from "@/lib/clipboard";
import { ArrowRight, Copy, ListChecks, Note, Plus, UserCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AvatarDoContato } from "../AvatarDoContato";
import { initials, siglaDoTelefone } from "../item/tempo-da-linha";
import { ContactTagsEditor } from "../ContactTagsEditor";
import { faixaDePrazo } from "@/lib/tarefas/tipos";

import { useTarefasDoContato } from "./useTarefasDoContato";

/**
 * Os três atalhos lado a lado (largura pelo rótulo, sobra dividida) e as medidas do `.jump` do
 * protótipo: 34px de altura, 13px em negrito, borda forte. O ícone fica no tom
 * da marca; o "Próximo passo" troca o conjunto inteiro pelo tom de aviso quando
 * o contato não tem tarefa aberta (`CLASSES_DO_ALERTA`).
 */
const CLASSES_DO_ATALHO =
  "flex h-[34px] min-w-0 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong px-2 text-[13px] font-bold text-text hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
const CLASSES_DO_ALERTA = "border-warning bg-warning-bg text-warning-fg hover:bg-warning-bg";

interface Props {
  contact: ContactSummary | null;
  displayName: string;
  orgId: string;
  leitura: boolean;
  onIrParaProximoPasso: () => void;
  onIrParaDetalhes: () => void;
  onIrParaObservacoes: () => void;
}

/**
 * Quem é a pessoa, sempre visível acima das abas.
 *
 * Os três atalhos levam a SEÇÕES da aba Resumo (trocam de aba se preciso e
 * rolam até lá), em vez de abrir janela: o painel continua sendo um lugar só.
 *
 * "Obs" leva às observações do contato (`contacts.observacoes`, migration
 * 9041), que ficam no Resumo logo abaixo dos detalhes. Em modo leitura o botão
 * continua: ele só navega, e a seção mostra o texto sem campo.
 */
export function CabecalhoDoPainel({
  contact, displayName, orgId, leitura, onIrParaProximoPasso, onIrParaDetalhes, onIrParaObservacoes,
}: Props) {
  const t = useT();
  const [editandoTags, setEditandoTags] = useState(false);
  const contactId = contact?.id ?? null;
  const tags = contact?.tags ?? [];
  const telefone = contact?.phone_number ? phoneForDisplay(contact.phone_number) : null;
  // A MESMA consulta do bloco Próximo passo (o react-query dedupa pela chave):
  // o atalho só acende o aviso quando a lista RESPONDEU vazia. Carregando ou com
  // erro, fica neutro: afirmar "sem tarefa" sem saber seria mentir na tela.
  const { lista } = useTarefasDoContato(contactId);
  const semTarefa = lista.isSuccess && (lista.data ?? []).length === 0;
  // P4: o alerta também acende quando o próximo passo está ATRASADO (a rota
  // ordena por prazo, então a primeira tarefa é a mais urgente).
  const primeira = lista.data?.[0];
  const atrasada = !!primeira && faixaDePrazo(primeira) === "atrasada";
  const alerta = semTarefa || atrasada;

  async function copiarTelefone() {
    if (!telefone) return;
    // Pelo helper (`lib/clipboard.ts`): em http a API crua da área de transferência nem
    // existe, e o fallback por textarea é quem copia.
    if (await copyToClipboard(telefone)) {
      toast.success(t("Telefone copiado."));
    } else {
      // Nem o fallback copiou (permissão negada): dizer, e não fingir.
      toast.error(t("Não consegui copiar. Selecione o número e copie à mão."));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-b border-border px-4 pb-3.5 pt-4" data-testid="inbox-cabecalho-do-painel">
      <div className="flex items-center gap-3">
        <AvatarDoContato contato={contact} nome={displayName} iniciais={initials(displayName, siglaDoTelefone(contact?.phone_number))} className="h-12 w-12 text-base" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-[17px] font-bold leading-tight text-text">{displayName}</div>
            {/* Tipo lido da COLUNA (`contacts.contact_type`), nunca da etiqueta; só o fornecedor ganha selo (3005). */}
            {contact?.contact_type === "fornecedor" && <Badge variant="secondary">{t("Fornecedor")}</Badge>}
          </div>
          {telefone && (
            <div className="flex items-center gap-1 text-[13px] text-text-muted">
              <span className="font-mono tabular-nums">{telefone}</span>
              <button
                type="button"
                aria-label={t("Copiar telefone")}
                title={t("Copiar telefone")}
                onClick={() => void copiarTelefone()}
                className="grid h-6 w-6 place-items-center rounded-md hover:bg-surface-elevated hover:text-text"
              >
                <Copy size={12} aria-hidden />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* "Assunto:" do protótipo NÃO entra: nenhum dado do contato nem da
          conversa guarda um assunto hoje, e inventar um seria texto falso. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <ChipDeEtiqueta
            key={tag}
            tag={tag}
            className="h-[22px] rounded-full border border-border bg-surface px-2 text-xs font-normal"
          />
        ))}
        {/* "+ Etiqueta" é o rótulo curto do protótipo; o nome acessível diz DE
            QUEM é a etiqueta (o painel tem também as da conversa) e contém o
            texto visível (WCAG 2.5.3). Abre o mesmo editor de antes. */}
        <Button
          size="sm"
          variant="ghost"
          className="h-[22px] rounded-full border border-dashed border-border-strong px-2 text-xs font-normal text-text-muted"
          disabled={leitura || !contactId}
          aria-pressed={editandoTags}
          aria-label={t("Etiqueta do contato")}
          title={t("Etiqueta do contato")}
          onClick={() => setEditandoTags((v) => !v)}
        >
          <Plus size={11} className="mr-0.5" weight="bold" aria-hidden /> {t("Etiqueta")}
        </Button>
        {contactId && (
          <Button asChild size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-xs">
            <Link href={`/app/contacts/${contactId}`}>
              {t("Ver contato")}
              <ArrowRight size={11} className="ml-1" weight="regular" aria-hidden />
            </Link>
          </Button>
        )}
      </div>
      {editandoTags && contactId && <ContactTagsEditor entityId={contactId} orgId={orgId} tags={tags} />}

      {/* Cada atalho parte da largura do PRÓPRIO rótulo e a sobra é dividida
          (`flex-auto`): em três terços iguais o rótulo maior virava
          "Próximo ..." no painel de 360px. Em painel mais estreito que os três
          rótulos juntos, o curto "Próximo" assume (container query), sem cortar. */}
      <div className="@container flex gap-1.5" data-testid="inbox-atalhos-do-painel">
        <button
          type="button"
          data-alerta={alerta ? "true" : undefined}
          title={atrasada ? t("O próximo passo está atrasado") : undefined}
          // O nome acessível é sempre o completo, e CONTÉM o rótulo curto que
          // aparece em painel estreito (WCAG 2.5.3).
          aria-label={t("Próximo passo")}
          className={cn(CLASSES_DO_ATALHO, alerta && CLASSES_DO_ALERTA)}
          onClick={onIrParaProximoPasso}
        >
          <ListChecks size={15} className={alerta ? "text-warning-fg" : "text-accent"} aria-hidden />
          <span className="hidden @[19rem]:inline">{t("Próximo passo")}</span>
          <span className="@[19rem]:hidden">{t("Próximo")}</span>
        </button>
        {/* Visível "Detalhes" porque "Detalhes do contato" não cabe em um terço do
            painel; o nome acessível CONTÉM o visível (WCAG 2.5.3). */}
        <button type="button" className={CLASSES_DO_ATALHO} aria-label={t("Detalhes do contato")} onClick={onIrParaDetalhes}>
          <UserCircle size={15} className="text-accent" aria-hidden /> {t("Detalhes")}
        </button>
        {/* Sem aria-label: o nome acessível é o próprio texto visível, em
            qualquer idioma (WCAG 2.5.3); o `title` só descreve. */}
        <button type="button" className={CLASSES_DO_ATALHO} title={t("Observações")} onClick={onIrParaObservacoes}>
          <Note size={15} className="text-accent" aria-hidden /> {t("Obs")}
        </button>
      </div>
    </div>
  );
}
