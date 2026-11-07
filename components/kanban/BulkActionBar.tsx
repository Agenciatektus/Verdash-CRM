"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { apiClient } from "@/lib/api/client";
import { ROLE_RANK } from "@/lib/auth/types";
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { AVISO_DE_LOTE_EM_CURSO, agendarNoLote, useLoteOcupado } from "@/hooks/kanban/useAcaoPorNegocio";
import type { BulkLeadActionInput } from "@/lib/schemas/leads";
import { resolveVocabulary } from "@/lib/kanban/vocabulary";
import type { PipelineVocabulary, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { MaisAcoesDoLote } from "./lote/MaisAcoesDoLote";

/** O teto da rota em lote por chamada (`lead_ids` máx. 50). */
export const LOTE_MAXIMO = 50;
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

interface BulkActionBarProps {
  selectedIds: string[];
  stages: Stage[];
  pipelineId: string;
  /**
   * Como ESTE funil chama o que está nos cards. Vem de `crm_pipelines.vocabulary`
   * — é o pilar que faz o mesmo código servir e-commerce, clínica e imobiliária
   * trocando só as palavras. Sem isto a barra dizia "lead" para todo mundo.
   */
  vocabulary?: PipelineVocabulary | null;
  /**
   * Tags dos leads do quadro — sem isto o menu só oferecia "nova tag" (#852).
   *
   * ⚠️ OBRIGATÓRIA, e sem default. Como opcional com `= []`, apagar a linha que
   * a liga em `app/app/pipelines/[id]/_client.tsx` — o ÚNICO ponto de uso do
   * repo — fazia o recurso inteiro sumir do produto em silêncio: sem erro, sem
   * typecheck vermelho, com a lista simplesmente vazia. O default silencioso é
   * a fiação esquecida que ninguém vê.
   */
  tagsExistentes: string[];
  /**
   * O recorte NA TELA, na ordem que a pessoa vê: status (reabrir, ganho), dono
   * (tarefa), etiquetas (remover) e o CSV saem daqui. Obrigatória pelo mesmo
   * motivo de `tagsExistentes`: sem a fiação, as ações sumiriam caladas.
   */
  leads: Lead[];
  /** Os funis da organização, para "Levar para outro funil". */
  funis: Array<{ id: string; name: string }>;
  ownerNames: Map<string, string | null>;
  onClear: () => void;
  /**
   * Devolve a seleção. O Desfazer das ações que limpam a seleção ao agendar
   * (ganho, outro funil, próximo passo) usa isto para a pessoa não ter de
   * marcar tudo de novo (P2 do Cassio na #220). Obrigatória pelo mesmo motivo
   * de `tagsExistentes`.
   */
  onRestaurar: (ids: string[]) => void;
}

export function BulkActionBar({
  selectedIds,
  stages,
  pipelineId,
  vocabulary,
  tagsExistentes,
  leads,
  funis,
  ownerNames,
  onClear,
  onRestaurar,
}: BulkActionBarProps) {
  const t = useT();
  const user = useUser();
  const activeOrg = useActiveOrg();
  const vocab = resolveVocabulary(vocabulary);
  const bulk = useBulkAction(pipelineId);
  // A barra trava nos 5 s do Desfazer E enquanto a ação roda depois dele — a
  // rota em lote e as negócio a negócio contam no mesmo contador
  // (`agendarNoLote`, P2 do Cassio na #220). A trava é desta aba: outra aba do
  // navegador não a enxerga.
  const loteOcupado = useLoteOcupado(pipelineId);
  const ocupado = bulk.isPending || loteOcupado;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loseOpen, setLoseOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  // D10: só olha propostas quando a confirmação de excluir abre, e no máximo
  // 50 negócios (o mesmo teto que a rota em lote já aplica por chamada) — um
  // aviso agregado, sem citar cada número, porque consultar um a um aqui
  // custaria uma chamada por card selecionado.
  const [algumTemProposta, setAlgumTemProposta] = useState(false);
  useEffect(() => {
    if (!confirmDelete || selectedIds.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAlgumTemProposta(false);
      return;
    }
    let cancelado = false;
    Promise.all(
      selectedIds.slice(0, 50).map((id) =>
        apiClient.get<{ data: Array<{ status: string }> }>(`/api/v1/proposals?lead_id=${id}`),
      ),
    )
      .then((respostas) => {
        if (cancelado) return;
        setAlgumTemProposta(
          respostas.some((r) => r.data.some((p) => p.status !== "rascunho" && p.status !== "cancelada")),
        );
      })
      .catch(() => {
        if (!cancelado) setAlgumTemProposta(false);
      });
    return () => {
      cancelado = true;
    };
  }, [confirmDelete, selectedIds]);

  // Reatribuir dono em lote é ≥manager NA ROTA (spec 04 §6.5). Sem este gate a
  // barra oferecia "Atribuir a…" para um `agent`, que clicava e recebia 403 —
  // controle decorativo, o pior tipo: parece que o sistema falhou, quando ele
  // só nunca teve permissão de mostrar aquilo.
  const podeAtribuir = Boolean(
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager),
  );
  const { data: members } = useAssignableMembers(podeAtribuir);

  // Esc to clear selection
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClear();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds.length, onClear]);

  if (selectedIds.length === 0) return null;

  const marcados = new Set(selectedIds);
  const tagsDosSelecionados = [
    ...new Set(leads.filter((l) => marcados.has(l.id)).flatMap((l) => l.tags ?? [])),
  ].sort();

  // O substantivo do funil só entra no SINGULAR. Plural de palavra livre é
  // heurística que erra ("Negociação" → "Negociaçãos"), e a contagem já diz
  // tudo que o plural diria: "12 selecionados" não fica pior que "12 Pacientes
  // selecionados", e nunca fica errado.
  // O card é o NEGÓCIO (`vocab.deal`: "Pedido" no e-commerce), não a pessoa
  // (`vocab.lead`: "Cliente") — o resto do funil já chama o card de negócio (#3811).
  const rotuloDaContagem =
    selectedIds.length === 1
      ? `1 ${t(vocab.deal)} ${t("selecionado")}`
      : `${selectedIds.length} ${t("selecionados")}`;

  /**
   * DESFAZER no lote (barra do Funil, 13/10/2026): mover, atribuir e etiquetar
   * em massa disparam automações do funil por lead; o aviso SEGURA a chamada
   * por alguns segundos (`adiarAcao`, o mesmo de ganho/perda) e "Desfazer" não
   * chama nada. A seleção sai na hora; a rota só roda no fim do aviso.
   */
  /**
   * A rota em lote aceita até 50 ids por chamada (422 acima disso). "Selecionar
   * todos" na Lista marca centenas: vai em BLOCOS de 50, em sequência. A seleção
   * só sai quando TODOS os blocos deram certo; com erro, fica, para tentar de novo.
   */
  const emBlocos = async (input: BulkLeadActionInput): Promise<number> => {
    let total = 0;
    for (let i = 0; i < input.lead_ids.length; i += LOTE_MAXIMO) {
      const bloco = { ...input, lead_ids: input.lead_ids.slice(i, i + LOTE_MAXIMO) } as BulkLeadActionInput;
      const res = await new Promise<{ data?: { updated_count?: number } }>((resolver, recusar) =>
        bulk.mutate(bloco, { onSuccess: (r) => resolver(r as { data?: { updated_count?: number } }), onError: recusar }),
      );
      total += res?.data?.updated_count ?? bloco.lead_ids.length;
    }
    return total;
  };

  /**
   * Um Desfazer cobre todos os blocos: nada é chamado antes do fim do aviso.
   * Vai pela MESMA trava das ações negócio a negócio (`agendarNoLote`, chave por
   * funil): nos 5 s E até o último bloco voltar, a barra fica travada e nenhuma
   * outra ação do lote é agendada por cima desta (P2 do Cassio na #220).
   */
  const comDesfazer = (mensagem: string, input: BulkLeadActionInput, aoConcluir?: (n: number) => void) => {
    const agendado = agendarNoLote(
      pipelineId,
      (s) => `${mensagem} (${s} s)`,
      t("Desfazer"),
      async () => {
        const n = await emBlocos(input);
        aoConcluir?.(n);
        onClear();
      },
    );
    if (!agendado) toast.warning(t(AVISO_DE_LOTE_EM_CURSO));
  };

  const runMove = (stageId: string) => {
    comDesfazer(t("Movendo os selecionados"), {
      action: "move",
      lead_ids: selectedIds,
      // Sem `position_in_stage`: um escalar não posiciona N cards sem
      // empatá-los, e empate quebra o `midpoint()` do arrasto seguinte. Quem
      // dá a posição de cada um é `fn_mover_leads_em_lote` (migration 0209).
      params: { stage_id: stageId },
    });
  };

  const runAssign = (ownerId: string | null) => {
    comDesfazer(
      t("Atribuindo os selecionados"),
      {
        action: "assign",
        lead_ids: selectedIds,
        params: { owner_user_id: ownerId },
      },
      (n) => {
        toast.success(
          ownerId === null
            ? `${n} ${t(n > 1 ? "ficaram sem responsável." : "ficou sem responsável.")}`
            : `${n} ${t(n > 1 ? "atribuídos." : "atribuído.")}`,
        );
      },
    );
  };

  const runTagAdd = (escolhida?: string) => {
    const tag = (escolhida ?? tagInput).trim();
    if (!tag) return;
    setTagInput("");
    comDesfazer(t("Etiquetando os selecionados"), { action: "tag", lead_ids: selectedIds, params: { add: [tag] } });
  };

  // O par do "Adicionar": a mesma ação `tag` da rota, com `remove`.
  const runTagRemove = (tag: string) => {
    comDesfazer(t("Removendo a etiqueta dos selecionados"), { action: "tag", lead_ids: selectedIds, params: { remove: [tag] } });
  };

  // Reabrir em lote = o reabrir individual: mover o encerrado para uma etapa
  // aberta (a `move` da rota, que recusa o funil `novo_negocio` e cobra os
  // campos da etapa). Nenhuma conversão sai: só ganhar emite `lead.won`.
  const runReabrir = (ids: string[], stageId: string) => {
    comDesfazer(t("Reabrindo os selecionados"), { action: "move", lead_ids: ids, params: { stage_id: stageId } });
  };

  const runDelete = () => {
    void emBlocos({ action: "delete", lead_ids: selectedIds, params: {} } as BulkLeadActionInput)
      .then(() => {
        setConfirmDelete(false);
        onClear();
      })
      .catch(() => undefined); // o erro já sai no toast do useBulkAction; a seleção fica
  };

  // F2 (#2484): "Marcar como perdido" em lote = mover para a etapa de PERDA do
  // funil com UM motivo único, pela `leads/bulk` que já decide o motivo (#917,
  // ação `move`, `params.lost_reason`). Nada de rota nova: o diálogo de motivo é
  // o MESMO do card (`LoseLeadDialog`) e a escrita é a rota que já existe.
  //
  // A ação só existe onde o funil TEM etapa de perda: sem ela o lote cairia em
  // `pipeline_no_lost_stage`/404 depois do clique. O card tem a mesma ação
  // porque o funil dele sempre tem a etapa (o `lose` a procura no servidor);
  // aqui ela não é garantida pela tela, então o gatilho é condicionado — o
  // `stages` que a barra já recebe diz quem é.
  const etapaDePerda = stages.find((s) => s.is_lost) ?? null;

  const runLose = async (motivo: string) => {
    if (!etapaDePerda) return;
    const res = await bulk.mutateAsync({
      action: "move",
      lead_ids: selectedIds,
      params: { stage_id: etapaDePerda.id, lost_reason: motivo },
    });
    const n = res.data.updated_count;
    toast.success(`${n} ${t(n > 1 ? "marcados como perdidos." : "marcado como perdido.")}`);
    onClear();
  };

  return (
    <>
      {/* `w-fit` sozinho não tinha teto: seis itens (rótulo + 5 ações) numa
          linha só passavam da largura da tela em qualquer smartphone e essa
          barra `sticky` virava scroll horizontal da PÁGINA inteira — a barra
          é `mx-auto`, então o excesso ficava invisível dos dois lados, não só
          cortado. `max-w-[calc(100vw-2rem)]` + `flex-wrap` deixam a barra
          quebrar em linhas em vez de vazar. */}
      <div
        data-lote-selecionados={selectedIds.length}
        className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-md"
      >
        <span className="text-sm font-medium">{rotuloDaContagem}</span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={ocupado}>
              {t("Mover para…")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Etapa")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Ganho e perda NÃO entram no "Mover para" (follow-up do Cassio na
                #180): fechar negócio emite `lead.won`/`lead.lost` com efeito
                fora do CRM. Desde 20/10/2026 (decisão do Peterson) os dois têm
                ação PRÓPRIA no lote: "Marcar como perdido…" (com motivo) e
                "Marcar como ganho…" em "Mais ações" (com confirmação e o
                Desfazer de 5 s do ganho individual), nunca um item de etapa. */}
            {stages.filter((s) => !s.is_won && !s.is_lost).map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => runMove(s.id)}>
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Extraído do PR #418 (@clinicacentrodosorrisosc-code): a lista de
            atendentes. Antes só dava para atribuir a SI MESMO, e "redistribuir
            a carteira" — o caso que faz a ação em lote existir — era o único
            que a barra não atendia. */}
        {podeAtribuir && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={ocupado}>
                {t("Responsável…")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => runAssign(user.id)}>{t("Eu")}</DropdownMenuItem>
              {(members ?? [])
                .filter((m) => m.user_id !== user.id)
                .map((m) => (
                  <DropdownMenuItem key={m.user_id} onClick={() => runAssign(m.user_id)}>
                    {rotuloDoMembro(m, t)}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => runAssign(null)}>
                {t("Remover responsável")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={ocupado}>
              Tag…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <div className="flex items-center gap-2 p-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder={t("nova tag")}
                className="h-8 w-40"
                onKeyDown={(e) => {
                  // ⚠️ O MENU DO RADIX FAZ TYPEAHEAD A CADA TECLA DE UM
                  // CARACTERE dentro do conteúdo — sem exceção para `<input>`
                  // (@radix-ui/react-menu 2.1.24, `onKeyDown` do Content:
                  // `if (!isModifierKey && isCharacterKey) handleTypeaheadSearch(key)`,
                  // que faz `newItem.focus()` no item que casa o prefixo).
                  //
                  // Enquanto o menu não tinha item nenhum, isso era inofensivo.
                  // Com a lista de tags existentes ao lado, digitar "verão" com
                  // "vip" na lista levava o foco para o item "vip" já na PRIMEIRA
                  // tecla: as teclas seguintes não chegavam ao campo e o Enter
                  // aplicava "vip" a TODOS os selecionados — que ainda emite
                  // `lead.tag_added` por lead, gatilho real de automação.
                  // Medido em jsdom: sem esta linha o campo recebia "g" ao
                  // digitar "goo".
                  //
                  // A condição é a MESMA do Radix, e não um `stopPropagation`
                  // seco: assim ArrowUp/ArrowDown continuam navegando os itens a
                  // partir do campo. O Escape não depende disto — o
                  // DismissableLayer escuta `keydown` no document com
                  // `{ capture: true }`, fase que roda antes de qualquer handler
                  // React, então o menu continua fechando.
                  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.stopPropagation();
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runTagAdd();
                  }
                }}
              />
              <Button size="sm" onClick={() => runTagAdd()} disabled={!tagInput.trim()}>
                {t("Adicionar")}
              </Button>
            </div>
            {tagsExistentes
              .filter((tag) => tag.toLowerCase().includes(tagInput.trim().toLowerCase()))
              .slice(0, 10)
              .map((tag) => (
                <DropdownMenuItem key={tag} onClick={() => runTagAdd(tag)}>
                  <PontoDaEtiqueta tag={tag} className="mr-2" />
                  {tag}
                </DropdownMenuItem>
              ))}
            {tagsDosSelecionados.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("Remover etiqueta")}</DropdownMenuLabel>
                {tagsDosSelecionados.slice(0, 10).map((tag) => (
                  <DropdownMenuItem key={`remover-${tag}`} onClick={() => runTagRemove(tag)}>
                    <PontoDaEtiqueta tag={tag} className="mr-2" />
                    {tag}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <MaisAcoesDoLote
          selectedIds={selectedIds}
          leads={leads}
          stages={stages}
          funis={funis}
          pipelineId={pipelineId}
          ownerNames={ownerNames}
          usuarioId={user.id}
          ocupado={ocupado}
          podeCampanha={podeAtribuir}
          onReabrir={runReabrir}
          onClear={onClear}
          onRestaurar={onRestaurar}
        />

        {etapaDePerda && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLoseOpen(true)}
            disabled={ocupado}
          >
            {t("Marcar como perdido…")}
          </Button>
        )}

        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirmDelete(true)}
          disabled={ocupado}
        >
          {t("Excluir")}
        </Button>

        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("Cancelar")}
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedIds.length === 1
                ? `${t("Excluir")} 1 ${t(vocab.deal)}?`
                : `${t("Excluir")} ${selectedIds.length} ${t("selecionados")}?`}
            </DialogTitle>
            <DialogDescription>
              {t("Esta ação remove o que está selecionado. Não pode ser desfeita.")}
              {algumTemProposta && (
                <> {t("Propostas já enviadas continuam disponíveis em Propostas.")}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("Cancelar")}
            </Button>
            <Button variant="destructive" onClick={runDelete} disabled={ocupado}>
              {t("Excluir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* F2 (#2484): o MESMO diálogo de motivo do card, reusado — em modo lote
          ele entrega o motivo escolhido ao `runLose`, que escreve pela
          `leads/bulk`. Motivo é obrigatório (o diálogo já barra o "Confirmar"
          sem motivo) e a escrita respeita organização/permissão de cada item na
          rota. Só monta quando há etapa de perda (mesmo gate do gatilho). */}
      {etapaDePerda && (
        <LoseLeadDialog
          open={loseOpen}
          onOpenChange={setLoseOpen}
          pipelineId={pipelineId}
          onConfirm={runLose}
          submitting={bulk.isPending}
        />
      )}
    </>
  );
}
