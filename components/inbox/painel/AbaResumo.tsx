"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";

import { CartaoDaCarteira } from "@/components/contacts/CartaoDaCarteira";
import { UltimasComprasDoContato } from "@/components/contacts/UltimasCompras";
import { RoteirosDoContato } from "@/components/contacts/RoteirosDoContato";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/auth/AuthProvider";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { roleAtLeast } from "@/lib/auth/types";

import { AnuncioDoContato } from "../AnuncioDoContato";
import { ConversationTagsEditor } from "../ConversationTagsEditor";
import { FollowupDoContato } from "../FollowupDoContato";
import { TarefasDaDemanda } from "../TarefasDaDemanda";
import { Demandas } from "./Demandas";
import { DetalhesDoContato } from "./DetalhesDoContato";
import { MemoriaDoContato } from "./MemoriaDoContato";
import { ObservacoesDoContato } from "./ObservacoesDoContato";
import { OrigemNoPainel } from "./OrigemNoPainel";
import { ProximoPasso } from "./ProximoPasso";
import type { DesfechoDraft } from "./tipos";
import type { ResumoDoContato } from "./useResumoDoContato";

interface Props {
  conversation: ConversationWithContact;
  resumo: ResumoDoContato;
  displayName: string;
  usuarioId: string;
  leitura: boolean;
  leadEmFocoId: string | null;
  desfechoDraft: DesfechoDraft | null;
  setDesfechoDraft: Dispatch<SetStateAction<DesfechoDraft | null>>;
  refProximoPasso: RefObject<HTMLElement | null>;
  refDetalhes: RefObject<HTMLElement | null>;
  refObservacoes: RefObject<HTMLElement | null>;
}

/**
 * A aba Resumo, que abre por padrão: o que fazer agora (próximo passo), quem é
 * a pessoa (detalhes e observações da equipe), o que ainda não acabou
 * (demandas) e o que se sabe dela (memória, roteiros).
 *
 * A ordem é a do atendimento, não a do banco. A demanda continua ANTES do
 * negócio (doutrina cap. 5): agora ela está na primeira aba e o negócio na
 * segunda, que é a mesma afirmação feita pela navegação.
 */
export function AbaResumo({
  conversation, resumo, displayName, usuarioId, leitura, leadEmFocoId,
  desfechoDraft, setDesfechoDraft, refProximoPasso, refDetalhes, refObservacoes,
}: Props) {
  const contact = conversation.contacts ?? null;
  const { user, activeOrg } = useAuth();
  // Carteira (#2591): o GET da rota cobra `agent`+; `viewer` não vê o bloco em vez de levar 403.
  const podeVerCarteira = (user.is_platform_admin && !user.support) || roleAtLeast(activeOrg?.role, "agent");
  // Iniciar/parar follow-up é `manager`+ no servidor (#3178); `leitura` cobre o suporte só leitura.
  const podeFollowup = !leitura && ((user.is_platform_admin && !user.support) || roleAtLeast(activeOrg?.role, "manager"));
  return (
    <div className="flex flex-col gap-4">
      <ProximoPasso
        ref={refProximoPasso}
        contactId={resumo.contactId}
        leadId={leadEmFocoId}
        conversationId={conversation.id}
        usuarioId={usuarioId}
        leitura={leitura}
      />
      <Separator />
      <DetalhesDoContato
        ref={refDetalhes}
        contactId={resumo.contactId}
        nomeDaConversa={displayName}
        telefone={contact?.phone_number ?? null}
        anonimizado={!!contact?.is_anonymized}
        leitura={leitura}
      />
      <Separator />
      {resumo.contactId && podeVerCarteira && (
        <section data-testid="inbox-bloco-carteira">
          <CartaoDaCarteira contactId={resumo.contactId} papelDoUsuario={activeOrg?.role ?? null} />
        </section>
      )}
      {resumo.contactId && resumo.summaryContactId === resumo.contactId && !resumo.erro && (
        <AnuncioDoContato contactId={resumo.contactId} origem={resumo.anuncios.origem} recente={resumo.anuncios.recente} />
      )}
      <OrigemNoPainel contactId={resumo.contactId} />
      <ObservacoesDoContato
        ref={refObservacoes}
        contactId={resumo.contactId}
        anonimizado={!!contact?.is_anonymized}
        leitura={leitura}
      />
      <Separator />
      <Demandas
        demandas={resumo.demandas}
        carregando={resumo.carregando}
        erro={resumo.erro}
        leitura={leitura}
        conversationId={conversation.id}
        currentDemandaId={conversation.current_demanda_id}
        contactId={resumo.contactId}
        desfechoDraft={desfechoDraft}
        setDesfechoDraft={setDesfechoDraft}
        recarregar={resumo.recarregar}
        usuarioId={usuarioId}
        leadEmFocoId={leadEmFocoId}
      />
      {/* A TAREFA DO ATENDIMENTO (#2818/#2842, upstream): presa à demanda
          vigente AINDA ABERTA (`current_demanda_id` continua apontando depois de
          encerrar). A seção traz o próprio divisor e some sem demanda. Criar é
          de quem grava no painel (`leitura` já cobre viewer e suporte só leitura). */}
      <TarefasDaDemanda
        demandaId={resumo.demandas?.find((d) => d.id === conversation.current_demanda_id)?.id ?? null}
        contactId={resumo.contactId}
        leadId={leadEmFocoId}
        podeEditar={!leitura}
      />
      {/* Follow-up na conversa (#3178): auto-oculta sem enrollment vivo nem fluxo ativo. */}
      {resumo.contactId && !contact?.is_anonymized && (
        <FollowupDoContato contactId={resumo.contactId} podeEscrever={podeFollowup} />
      )}
      <Separator />
      <MemoriaDoContato fatos={resumo.fatos} historico={resumo.historico} carregando={resumo.carregando} />
      {/* O que os roteiros de atendimento coletaram (módulo opcional; desligado
          ou sem roteiro, não desenha nada). */}
      {resumo.contactId && !contact?.is_anonymized && (
        <RoteirosDoContato contactId={resumo.contactId} variante="painel" />
      )}
      {/* Últimas compras (#3179): negócios ganhos em todos os funis. */}
      {resumo.contactId && !contact?.is_anonymized && <UltimasComprasDoContato contactId={resumo.contactId} />}
      {!leitura && (
        <>
          <Separator />
          <ConversationTagsEditor
            conversationId={conversation.id}
            orgId={conversation.organization_id}
            tags={conversation.tags ?? []}
          />
        </>
      )}
    </div>
  );
}
