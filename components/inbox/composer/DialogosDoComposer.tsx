"use client";

import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import type { useSendMessage } from "@/hooks/inbox/useSendMessage";

interface Props {
  conversationId: string;
  currentContactId?: string | null;
  /** A FILA de anexos (#2526): um arquivo escolhido, ou as imagens de uma resposta pronta. */
  files: File[];
  /** A legenda que a prévia mostra ao abrir (o texto da resposta pronta com imagem). */
  legendaInicial: string | null;
  /** Anexo de NOTA interna: a legenda é o corpo dela, vale com áudio também. */
  notaInterna?: boolean;
  sending: boolean;
  onCancelarAnexo: () => void;
  onRemoverAnexo: (indice: number, caption: string) => void;
  /** Sobe e envia a fila (`enviarAnexos` do Composer), no modo CONGELADO NA ESCOLHA. */
  onEnviarAnexos: (caption: string) => void;
  contactPickerOpen: boolean;
  setContactPickerOpen: (aberto: boolean) => void;
  send: ReturnType<typeof useSendMessage>;
}

/**
 * Os dois diálogos do composer: a prévia do anexo e o seletor de contato.
 *
 * Saíram de `Composer.tsx` na fase 3.5 sem mudar comportamento. As mutações
 * continuam sendo as do Composer: o `isPending` do upload trava o campo lá, e
 * duas instâncias do mesmo hook discordariam sobre isso. Desde a subida 1.85 a
 * prévia recebe a FILA de anexos (#2526) e o envio é o `enviarAnexos` do Composer
 * (reply → `whatsapp-media` + `useSendMessage`; note → `internal-media` +
 * `useCreateNote`, #1863 F3).
 */
export function DialogosDoComposer({
  conversationId, currentContactId, files, legendaInicial, notaInterna, sending,
  onCancelarAnexo, onRemoverAnexo, onEnviarAnexos,
  contactPickerOpen, setContactPickerOpen, send,
}: Props) {
  return (
    <>
      <AttachmentPreviewDialog
        files={files}
        legendaInicial={legendaInicial}
        notaInterna={notaInterna}
        sending={sending}
        onCancel={onCancelarAnexo}
        onRemove={onRemoverAnexo}
        onSend={onEnviarAnexos}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : { shared_contact: { name: payload.name, phone_number: payload.phone_number } },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
}
