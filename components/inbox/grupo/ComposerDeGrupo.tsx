"use client";
import { forwardRef, type ComponentProps } from "react";

import { Composer, type ComposerHandle } from "@/components/inbox/Composer";
import { useT } from "@/hooks/i18n/useT";
import { useEstadoDoGrupo } from "@/hooks/inbox/useGrupo";

/**
 * O composer de uma conversa de GRUPO: quando só administradores enviam e este número é membro comum
 * (estado do diretório), a faixa substitui a caixa. Papel desconhecido (`null`) não trava: o WhatsApp decide.
 */
export const ComposerDeGrupo = forwardRef<ComposerHandle, ComponentProps<typeof Composer>>(
  function ComposerDeGrupo(props, ref) {
    const t = useT();
    const { conversa } = props;
    const estado = useEstadoDoGrupo(conversa?.channel_session_id ?? null, conversa?.group_chat_id ?? null);
    const soAdmins = estado.data?.is_announce === true && estado.data.papel === "membro";
    return (
      <Composer
        ref={ref}
        {...props}
        blockedReason={props.blockedReason ?? (soAdmins ? t("Só administradores podem enviar mensagens neste grupo.") : null)}
      />
    );
  },
);
