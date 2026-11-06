"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";
import { invalidarListasDaConversa } from "@/hooks/inbox/cacheDasConversas";

interface UpdateTagsArgs {
  conversation_id: string;
  adicionar?: string[];
  remover?: string[];
}

/** O corpo do PATCH: só o lado do delta que tem etiqueta (o Zod recusa lista vazia). */
export function corpoDoDelta(args: UpdateTagsArgs): { tags_adicionar?: string[]; tags_remover?: string[] } {
  return {
    ...(args.adicionar?.length ? { tags_adicionar: args.adicionar } : {}),
    ...(args.remover?.length ? { tags_remover: args.remover } : {}),
  };
}

/**
 * G3-05 + 9045: acrescenta/remove tags de uma conversa por DELTA; refaz o inbox.
 * Só viaja o que mudou, e o banco aplica sobre o valor atual: a etiqueta que
 * outra pessoa (ou a IA) pôs no meio não se perde, como acontecia mandando a
 * lista inteira que a tela tinha carregado.
 */
export function useUpdateConversationTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: UpdateTagsArgs) =>
      apiClient.patch<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}`,
        corpoDoDelta(args),
      ),
    onError: (err, args) => {
      invalidarListasDaConversa(qc, args.conversation_id);
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      invalidarListasDaConversa(qc, args.conversation_id);
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      // Gravar tag é o que ALIMENTA o vocabulário (`staleTime` de 5 min): sem
      // reler, o marcador recém-criado não aparece no filtro do Inbox nem nas
      // sugestões até a página recarregar. O lado do contato já relia (#852).
      qc.invalidateQueries({ queryKey: ["conversation-tag-vocabulary"] });
    },
  });
}

/**
 * G3-05: vocabulário canônico de tags de conversa da org (sugestões).
 * Via server route — o cookie de sessão é HttpOnly, então o browser-supabase
 * não autentica; a leitura org-scoped passa pelo servidor.
 */
export function useConversationTagVocabulary(orgId: string | null, busca = "") {
  return useQuery({
    queryKey: ["conversation-tag-vocabulary", orgId, busca],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<string[]> => {
      const res = busca
        ? await apiClient.get<{ data: string[] }>("/api/v1/conversation-tags?busca="+encodeURIComponent(busca), { signal })
        : await apiClient.get<{ data: string[] }>("/api/v1/conversation-tags");
      return res.data;
    },
  });
}
