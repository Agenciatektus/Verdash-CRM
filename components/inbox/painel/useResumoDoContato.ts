"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ouvirMudancaNoCrmDoContato } from "@/lib/inbox/releitura-do-contato";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import type { PersonalizacaoProspeccao } from "@/lib/prospecting/personalizar";

import type { AnuncioDeOrigem, AnuncioMaisRecente } from "../AnuncioDoContato";

import type {
  ActivityRow,
  DemandaEncerrada,
  DemandaRow,
  Enriquecimento,
  Fato,
  LeadRow,
  OrderRow,
} from "./tipos";

interface RespostaDoResumo {
  data: {
    enrichment?: Enriquecimento;
    enrichment_error?: boolean;
    personalizacao?: PersonalizacaoProspeccao | null;
    leads: LeadRow[];
    orders: OrderRow[];
    activities: ActivityRow[];
    demandas: DemandaRow[];
    fatos?: Fato[];
    historico?: DemandaEncerrada[];
    anuncio_de_origem?: AnuncioDeOrigem | null;
    anuncio_mais_recente?: AnuncioMaisRecente | null;
  };
}

/**
 * O resumo de CRM do contato, buscado UMA vez por conversa.
 *
 * Saiu do corpo do `CRMSidePanel` quando o painel ganhou abas, e o motivo de
 * morar num hook e não em cada aba é o pedido único: as quatro abas leem o
 * MESMO `crm-summary`. Buscar por aba multiplicaria as leituras e, pior, faria
 * duas abas mostrarem retratos de momentos diferentes do mesmo contato.
 *
 * Pela ROTA, não pelo cliente de navegador: o cookie de sessão é httpOnly, então
 * o supabase-js do browser consultava como `anon` (ver o cabeçalho da rota).
 */
export function useResumoDoContato(conversation: ConversationWithContact | null) {
  const contact = conversation?.contacts ?? null;
  const contactId = contact?.id ?? null;

  const [enrichment, setEnrichment] = useState<Enriquecimento>(null);
  const [enrichmentError, setEnrichmentError] = useState(false);
  const [personalizacao, setPersonalizacao] = useState<PersonalizacaoProspeccao | null>(null);
  const [anuncios, setAnuncios] = useState<{ origem: AnuncioDeOrigem | null; recente: AnuncioMaisRecente | null }>({ origem: null, recente: null });
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [activities, setActivities] = useState<ActivityRow[] | null>(null);
  const [demandas, setDemandas] = useState<DemandaRow[] | null>(null);
  const [fatos, setFatos] = useState<Fato[]>([]);
  const [historico, setHistorico] = useState<DemandaEncerrada[]>([]);
  const [summaryContactId, setSummaryContactId] = useState<string | null>(null);
  /**
   * O TERCEIRO ESTADO. A falha era traduzida para lista vazia, virando "Sem
   * leads.": uma afirmação sobre o NEGÓCIO feita em cima de um erro de leitura.
   * Distinguir "não tem" de "não consegui ler" é a diferença entre informar e
   * mentir.
   */
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    if (!contactId) {
      setLeads(null);
      setOrders(null);
      setActivities(null);
      setDemandas(null);
      setFatos([]);
      setHistorico([]);
      setAnuncios({ origem: null, recente: null });
      return;
    }
    let cancelled = false;
    setErro(false);

    async function load() {
      try {
        const r = await apiClient.get<RespostaDoResumo>(`/api/v1/contacts/${contactId}/crm-summary`);
        if (cancelled) return;
        setSummaryContactId(contactId);
        setEnrichment(r.data.enrichment ?? null);
        setEnrichmentError(r.data.enrichment_error ?? false);
        setPersonalizacao(r.data.personalizacao ?? null);
        setLeads(r.data.leads);
        setOrders(r.data.orders);
        setActivities(r.data.activities);
        // `?? []` e não `?? null`: aqui a leitura DEU CERTO. Cair em `null`
        // disfarçaria a lista vazia de terceiro estado, e o painel mostraria
        // esqueleto para sempre num contato sem demanda aberta.
        setDemandas(r.data.demandas ?? []);
        setFatos(r.data.fatos ?? []);
        setHistorico(r.data.historico ?? []);
        setAnuncios({ origem: r.data.anuncio_de_origem ?? null, recente: r.data.anuncio_mais_recente ?? null });
      } catch {
        if (cancelled) return;
        // Falha NÃO vira lista vazia: os dados ficam `null` e o painel diz que
        // não conseguiu ler, nunca que não há.
        setErro(true);
        setLeads(null);
        setOrders(null);
        setActivities(null);
        setDemandas(null);
        setFatos([]);
        setHistorico([]);
        setAnuncios({ origem: null, recente: null });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // AS DEPS DA CONVERSA SÃO O REFETCH DA TROCA DE COMANDO. O painel não usa
    // react-query, então `invalidateQueries` não o alcança, e `contactId` não
    // muda quando o dono muda. `assigned_to_user_id` cobre assumir, transferir e
    // liberar; `bot_silenced_until` cobre pausar e devolver: os gestos que geram
    // linha na Atividade.
  }, [
    contactId,
    contact?.is_anonymized,
    tentativa,
    conversation?.assigned_to_user_id,
    conversation?.bot_silenced_until,
    conversation?.service_revision,
    conversation?.current_demanda_id,
  ]);

  // Recarregar pelo MESMO caminho do "Tentar de novo": o que acabou de ser
  // gravado volta do servidor em vez de ser remendado no cliente. Escrita que
  // só parece ter dado certo é o defeito que esta tela inteira combate.
  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  // Gravação no negócio feita FORA do painel (o menu de contexto da lista):
  // relê pelo mesmo caminho, só se o aviso for deste contato.
  useEffect(
    () => ouvirMudancaNoCrmDoContato((id) => {
      if (id === contactId) recarregar();
    }),
    [contactId, recarregar],
  );

  // `erro` PRIMEIRO: as listas voltam a `null` quando a leitura falha, e sem
  // esta guarda o painel mostraria esqueleto para sempre em vez da falha.
  const carregando = useMemo(
    () =>
      !erro &&
      (summaryContactId !== contactId ||
        (leads === null && orders === null && activities === null && demandas === null)),
    [erro, summaryContactId, contactId, leads, orders, activities, demandas],
  );

  return {
    contactId,
    summaryContactId,
    enrichment,
    enrichmentError,
    personalizacao,
    anuncios,
    leads,
    orders,
    activities,
    demandas,
    fatos,
    historico,
    erro,
    carregando,
    recarregar,
  };
}

export type ResumoDoContato = ReturnType<typeof useResumoDoContato>;
