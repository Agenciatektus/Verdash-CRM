"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { useEffect, useRef, useState } from "react";

import { escutar } from "@/lib/ui/comandos-da-tela";

import { usePermission, useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";

import { LeadEnrichment } from "./LeadEnrichment";
import { AbaAtividade } from "./painel/AbaAtividade";
import { AbaNegocios } from "./painel/AbaNegocios";
import { AbaResumo } from "./painel/AbaResumo";
import { CabecalhoDoPainel } from "./painel/CabecalhoDoPainel";
import type { DesfechoDraft } from "./painel/tipos";
import { ABAS_DO_PAINEL, useAbaDoPainel, type AbaDoPainel } from "./painel/useAbaDoPainel";
import { useResumoDoContato } from "./painel/useResumoDoContato";

interface Props {
  conversation: ConversationWithContact | null;
}

const ROTULO_DA_ABA: Record<AbaDoPainel, string> = {
  resumo: "Resumo",
  negocios: "Negócios",
  empresa: "Empresa",
  atividade: "Atividade",
};

type Alvo = "proximo-passo" | "detalhes" | "observacoes";

/**
 * O PAINEL DO LEAD NA INBOX, EM ABAS (visual v2, fases 3.3 e 3.4).
 *
 * Era uma rolagem única de nove seções; quem atendia rolava até achar o
 * negócio. Agora o cabeçalho (quem é) fica fixo e o resto se divide em Resumo,
 * Negócios, Empresa e Atividade. As peças moram em `components/inbox/painel/`.
 *
 * Três decisões que não aparecem na tela:
 *  - O `crm-summary` é buscado UMA vez por conversa (`useResumoDoContato`), não
 *    por aba: as quatro leem o mesmo retrato do contato.
 *  - As abas ficam MONTADAS (`forceMount` + `hidden`): o campo do funil
 *    digitado e não salvo sobrevive a uma espiada na Atividade. Desmontar a aba
 *    jogaria fora o rascunho em silêncio.
 *  - `leitura` junta os três modos que não gravam: acompanhamento de suporte
 *    somente leitura, papel abaixo de `agent` e o que o servidor recusaria.
 *    Toda ação do painel lê ESTA variável, e as rotas recusam do mesmo jeito.
 */
export function CRMSidePanel({ conversation }: Props) {
  const { user } = useAuth();
  const t = useT();
  const podeGravar = usePermission("contact.update");
  const leitura = user.support?.access_mode === "support_readonly" || !podeGravar;
  const resumo = useResumoDoContato(conversation);
  const contact = conversation?.contacts ?? null;
  const [aba, setAba] = useAbaDoPainel();
  // Para onde o atalho do cabeçalho pediu para ir. Ref + contador, e não
  // estado: o efeito que rola só LÊ o pedido, sem `setState` dentro dele.
  const alvo = useRef<Alvo | null>(null);
  const [pedidoDeRolagem, setPedidoDeRolagem] = useState(0);
  const refProximoPasso = useRef<HTMLElement | null>(null);
  const refDetalhes = useRef<HTMLElement | null>(null);
  const refObservacoes = useRef<HTMLElement | null>(null);

  // O rascunho do desfecho mora AQUI, no componente que nunca desmonta: a saída
  // do filtro produz `null` enquanto o detalhe carrega, e o rascunho não pode
  // sumir nessa lacuna. Outra conversa ou contato real o descarta.
  const [desfechoDraft, setDesfechoDraft] = useState<DesfechoDraft | null>(null);
  useEffect(() => {
    if (conversation && desfechoDraft && (conversation.id !== desfechoDraft.conversationId || resumo.contactId !== desfechoDraft.contactId)) setDesfechoDraft(null);
  }, [conversation, resumo.contactId, desfechoDraft]);

  // O negócio escolhido vale para ESTE contato: guardado junto do contato, a
  // troca de conversa o descarta sem efeito nenhum.
  const [leadEscolhido, setLeadEscolhido] = useState<{ contactId: string | null; leadId: string | null }>({ contactId: null, leadId: null });
  const leadAtivoId = leadEscolhido.contactId === resumo.contactId ? leadEscolhido.leadId : null;
  const leadEmFoco = (resumo.leads ?? []).find((l) => l.id === leadAtivoId) ?? resumo.leads?.[0] ?? null;

  // Rola DEPOIS da troca de aba: com a aba escondida o elemento não tem caixa,
  // e `scrollIntoView` num elemento `hidden` não faz nada.
  useEffect(() => {
    if (!alvo.current || aba !== "resumo") return;
    const ref = { "proximo-passo": refProximoPasso, detalhes: refDetalhes, observacoes: refObservacoes }[alvo.current];
    const el = ref.current;
    alvo.current = null;
    el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    // O foco vai junto: quem chegou pelo teclado continua de onde a tela rolou.
    el?.focus({ preventScroll: true });
  }, [pedidoDeRolagem, aba]);

  function irPara(destino: Alvo) {
    alvo.current = destino;
    setAba("resumo");
    setPedidoDeRolagem((n) => n + 1);
  }
  // O "Criar próximo passo" da busca (Ctrl K), repassado pela Inbox. A ref
  // guarda o `irPara` atual para a assinatura ser feita uma vez só.
  const irParaAtual = useRef(irPara);
  useEffect(() => {
    irParaAtual.current = irPara;
  });
  useEffect(() => escutar("painel-proximo-passo", () => irParaAtual.current("proximo-passo")), []);

  if (!conversation) {
    return (
      <aside className="flex h-full items-center justify-center border-l border-border p-4 text-center text-xs text-muted-foreground">
        {t("Selecione uma conversa para ver detalhes do contato.")}
      </aside>
    );
  }

  const displayName = rotuloParaAEquipe(contact, t);
  const doContato = resumo.summaryContactId === resumo.contactId;

  return (
    // `bg-surface`: o painel é parte do card da área de trabalho (como a lista);
    // só o fio da conversa fica no fundo mais escuro, que é o que o destaca.
    <aside className="pele-ruido flex h-full min-h-0 flex-col overflow-y-auto border-l border-border bg-surface">
      <CabecalhoDoPainel
        contact={contact}
        displayName={displayName}
        orgId={conversation.organization_id}
        leitura={leitura}
        onIrParaProximoPasso={() => irPara("proximo-passo")}
        onIrParaDetalhes={() => irPara("detalhes")}
        onIrParaObservacoes={() => irPara("observacoes")}
      />
      <TabsPrimitive.Root value={aba} onValueChange={(v) => setAba(v as AbaDoPainel)} activationMode="automatic">
        <TabsPrimitive.List
          aria-label={t("Seções do lead")}
          // `scrollbar-none`: nas larguras em que as quatro abas não cabem (o
          // painel estreito do `xl`), a faixa ainda rola de lado, mas sem
          // desenhar a barra que aparecia como um risco embaixo das abas.
          className="pele-ruido scrollbar-none sticky top-0 z-10 flex gap-0.5 overflow-x-auto border-b border-border bg-surface px-3"
        >
          {ABAS_DO_PAINEL.map((a) => (
            <TabsPrimitive.Trigger
              key={a}
              value={a}
              data-testid={`painel-aba-${a}`}
              className="relative h-[42px] shrink-0 whitespace-nowrap px-2 text-[13.5px] font-semibold text-text-muted hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent dark:data-[state=active]:after:bg-(image:--pele-grad)"
            >
              {t(ROTULO_DA_ABA[a])}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="resumo" forceMount hidden={aba !== "resumo"} className="p-4 focus-visible:outline-hidden">
          <AbaResumo
            conversation={conversation}
            resumo={resumo}
            displayName={displayName}
            usuarioId={user.id}
            leitura={leitura}
            leadEmFocoId={leadEmFoco?.status === "open" ? leadEmFoco.id : null}
            desfechoDraft={desfechoDraft}
            setDesfechoDraft={setDesfechoDraft}
            refProximoPasso={refProximoPasso}
            refDetalhes={refDetalhes}
            refObservacoes={refObservacoes}
          />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="negocios" forceMount hidden={aba !== "negocios"} className="p-4 focus-visible:outline-hidden">
          <AbaNegocios
            contactId={resumo.contactId}
            leads={resumo.leads}
            orders={resumo.orders}
            carregando={resumo.carregando}
            erro={resumo.erro}
            leitura={leitura}
            leadAtivoId={leadAtivoId}
            onSelecionarLead={(leadId) => setLeadEscolhido({ contactId: resumo.contactId, leadId })}
            recarregar={resumo.recarregar}
          />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="empresa" forceMount hidden={aba !== "empresa"} className="p-4 focus-visible:outline-hidden">
          <LeadEnrichment
            data={doContato && !resumo.erro && !contact?.is_anonymized ? resumo.enrichment : null}
            loading={resumo.carregando}
            error={resumo.erro || (doContato && resumo.enrichmentError)}
            onRetry={resumo.recarregar}
          />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="atividade" forceMount hidden={aba !== "atividade"} className="p-4 focus-visible:outline-hidden">
          <AbaAtividade
            activities={resumo.activities}
            carregando={resumo.carregando}
            erro={resumo.erro}
            onTentarDeNovo={resumo.recarregar}
          />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </aside>
  );
}
