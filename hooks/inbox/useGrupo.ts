"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { InfoDoGrupo } from "@/lib/grupos/acoes";

const base = (sessionId: string) => `/api/v1/channel-sessions/${sessionId}/groups`;

/** O `info` do grupo (vai ao WhatsApp): só roda com o painel aberto. */
export function useInfoDoGrupo(sessionId: string, chatId: string, aberto: boolean) {
  return useQuery({
    queryKey: ["grupo-info", sessionId, chatId],
    enabled: aberto,
    retry: false,
    staleTime: 0,
    queryFn: () =>
      apiClient.post<{ data: InfoDoGrupo }>(`${base(sessionId)}/acao`, { group_chat_id: chatId, acao: "info" }).then((r) => r.data),
  });
}

/** Qualquer ação de gestão. O `info` e o estado do composer são relidos depois. */
export function useAcaoDoGrupo(sessionId: string, chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (corpo: { acao: string } & Record<string, unknown>) =>
      apiClient.post<{ data: unknown }>(`${base(sessionId)}/acao`, { group_chat_id: chatId, ...corpo }).then((r) => r.data),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grupo-info", sessionId, chatId] });
      qc.invalidateQueries({ queryKey: ["grupo-estado", sessionId, chatId] });
    },
  });
}

/** Papel deste número e "só admins enviam", do diretório (cache): trava o composer. */
export function useEstadoDoGrupo(sessionId: string | null, chatId: string | null) {
  return useQuery({
    queryKey: ["grupo-estado", sessionId, chatId],
    enabled: !!sessionId && !!chatId,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      apiClient
        .get<{ data: { papel: "dono" | "admin" | "membro" | null; is_announce: boolean } }>(
          `${base(sessionId!)}/estado?group_chat_id=${encodeURIComponent(chatId!)}`,
        )
        .then((r) => r.data),
  });
}
