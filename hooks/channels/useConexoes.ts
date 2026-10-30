"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { usePhoneNumbers } from "@/hooks/telefonia/usePhoneNumbers";
import { apiClient } from "@/lib/api/client";
import { montarConexoes, type FontesDaLista, type ItemDeConexao } from "@/lib/channels/conexoes-lista";

interface Hospedado {
  sessions?: { channel_session_id: string; origem?: string }[];
  nativo_habilitado?: boolean;
}

/**
 * A lista unificada de Conexões. A lista de verdade é `/channel-sessions`: se ela falha, a
 * página mostra erro. As demais fontes só ACRESCENTAM (quais canais são por QR, a linha de
 * voz, os números de telefone); se uma delas falha, a página segue com o que tem em vez de
 * esconder canais que existem.
 */
/**
 * 10 s só enquanto algum canal está subindo ou esperando o QR; parado, 60 s basta
 * para a queda de um canal aparecer (o foco da janela também recarrega).
 */
export function intervaloDasConexoes(sessoes: { status: string }[] | undefined): number {
  return sessoes?.some((s) => s.status === "STARTING" || s.status === "SCAN_QR_CODE") ? 10_000 : 60_000;
}

export function useConexoes() {
  const canais = useChannelSessions({ refetchInterval: intervaloDasConexoes });
  const hospedado = useQuery({
    queryKey: ["channels-hosted"],
    queryFn: async () => (await apiClient.get<{ data: Hospedado }>("/api/v1/channels/hosted")).data,
    staleTime: 15_000,
    retry: false,
  });
  const voz = useQuery({
    queryKey: ["voice-session-status"],
    queryFn: async () =>
      (await apiClient.get<{ data: NonNullable<FontesDaLista["voz"]> }>("/api/v1/voice/sessions/status")).data,
    staleTime: 15_000,
    retry: false,
  });
  const telefones = usePhoneNumbers();

  const itens: ItemDeConexao[] = useMemo(() => {
    const origens: FontesDaLista["origens"] = {};
    for (const s of hospedado.data?.sessions ?? []) origens[s.channel_session_id] = s.origem;
    return montarConexoes({
      sessoes: canais.data ?? [],
      origens,
      voz: voz.data ?? null,
      telefones: telefones.data ?? [],
    });
  }, [canais.data, hospedado.data, voz.data, telefones.data]);

  return {
    itens,
    sessoes: canais.data ?? [],
    carregando: canais.isLoading,
    erro: canais.isError,
    bancoAtrasado: canais.schemaOutdated,
    nativoHabilitado: hospedado.data?.nativo_habilitado === true,
  };
}
