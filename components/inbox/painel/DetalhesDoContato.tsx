"use client";

import { SecaoRecolhivel } from "./SecaoRecolhivel";
import { forwardRef, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useContact } from "@/hooks/contacts/useContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ContactPatch } from "@/lib/schemas/contacts";
import { PencilSimple, UserCircle } from "@/lib/ui/icons";

type Campo = "name" | "email" | "birthdate";

/** O rótulo de cada campo editável, na ordem em que a ficha os mostra. */
const ROTULO_DO_CAMPO: Record<Campo, string> = {
  name: "Nome",
  email: "E-mail",
  birthdate: "Data de nascimento",
};
const CAMPOS = Object.keys(ROTULO_DO_CAMPO) as Campo[];
const TIPO_DO_INPUT: Record<Campo, string> = { name: "text", email: "email", birthdate: "date" };

interface Props {
  contactId: string | null;
  /** Nome e telefone que a conversa já trouxe: aparecem antes do GET responder. */
  nomeDaConversa: string | null;
  telefone: string | null;
  anonimizado: boolean;
  leitura: boolean;
}

/**
 * Detalhes do contato, editáveis NO LUGAR, pelo PATCH de contatos que já existe
 * (`/api/v1/contacts/[id]`, `agent`+, schema do país da organização).
 *
 * O telefone fica só de leitura de propósito: é a identidade do contato no
 * WhatsApp. Trocá-lo daqui desligaria a conversa aberta do contato sem aviso; a
 * ficha completa ("Ver contato") é onde essa troca tem o contexto certo.
 *
 * Esvaziar um campo não é oferecido: o PATCH aceita só valor (nome com 1+
 * caractere, e-mail válido), e um "salvar vazio" que o servidor recusa seria
 * um botão que sempre falha.
 */
export const DetalhesDoContato = forwardRef<HTMLElement, Props>(function DetalhesDoContato(
  { contactId, nomeDaConversa, telefone, anonimizado, leitura },
  ref,
) {
  const t = useT();
  const id = useId();
  // Contato anonimizado não tem o que mostrar nem editar: a consulta nem sai.
  const contato = useContact(anonimizado || !contactId ? "" : contactId);
  const atualizar = useUpdateContact(contactId ?? "");
  const [editando, setEditando] = useState<Campo | null>(null);
  const [valor, setValor] = useState("");

  const dados = contato.data?.data;
  const atual = (c: Campo): string => {
    if (c === "name") {
      // O campo edita o nome ESCOLHIDO (`name`, o mesmo do "Editar contato") e
      // mostra o nome de gente pela regra única (`nomeDoContato`): o escolhido
      // vence o perfil do WhatsApp (#907). Editar `display_name` aqui deixava o
      // pushName à vista depois de a pessoa renomear o contato na ficha.
      return nomeDoContato(dados) ?? nomeDaConversa ?? "";
    }
    return (dados?.[c] as string | null | undefined) ?? "";
  };
  const podeEditar = !leitura && !anonimizado && !!contactId;

  function salvar(c: Campo) {
    const novo = valor.trim();
    if (!novo || novo === atual(c)) {
      setEditando(null);
      return;
    }
    const patch: ContactPatch = { [c]: novo };
    atualizar.mutate(patch, {
      onSuccess: () => {
        toast.success(t("Contato atualizado."));
        setEditando(null);
      },
    });
  }

  return (
    <SecaoRecolhivel
      ref={ref}
      testId="inbox-detalhes-do-contato"
      icone={<UserCircle size={14} aria-hidden />}
      titulo={t("Detalhes do contato")}
      // P6: fechada, a seção diz quantos campos estão preenchidos.
      resumo={`${CAMPOS.filter((c) => !!atual(c)).length} ${t("de")} ${CAMPOS.length} ${t("campos")}`}
    >
      <dl className="mt-1 text-xs">
        {CAMPOS.map((c) =>
          editando === c ? (
            <div key={c} className="grid gap-1.5 border-t border-border py-2 first:border-t-0">
              <label htmlFor={`${id}-${c}`} className="text-text-muted">{t(ROTULO_DO_CAMPO[c])}</label>
              <input
                id={`${id}-${c}`}
                type={TIPO_DO_INPUT[c]}
                autoFocus
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") salvar(c);
                  if (e.key === "Escape") setEditando(null);
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditando(null)}>{t("Cancelar")}</Button>
                <Button size="sm" className="h-7 text-xs" disabled={atualizar.isPending || !valor.trim()} onClick={() => salvar(c)}>
                  {atualizar.isPending ? t("Salvando…") : t("Salvar")}
                </Button>
              </div>
            </div>
          ) : (
            <div key={c} className="grid min-h-9 grid-cols-[104px_minmax(0,1fr)_24px] items-center gap-2 border-t border-border first:border-t-0">
              <dt className="text-text-muted">{t(ROTULO_DO_CAMPO[c])}</dt>
              <dd className={atual(c) ? "wrap-anywhere text-text" : "text-text-muted"}>
                {atual(c) || t("Não informado")}
              </dd>
              {podeEditar ? (
                <button
                  type="button"
                  aria-label={`${t("Editar")} ${t(ROTULO_DO_CAMPO[c])}`}
                  onClick={() => { setValor(atual(c)); setEditando(c); }}
                  className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface-elevated hover:text-text"
                >
                  <PencilSimple size={12} aria-hidden />
                </button>
              ) : <span />}
            </div>
          ),
        )}
        <div className="grid min-h-9 grid-cols-[104px_minmax(0,1fr)_24px] items-center gap-2 border-t border-border">
          <dt className="text-text-muted">{t("Telefone")}</dt>
          <dd className="tabular-nums text-text">{telefone ? phoneForDisplay(telefone) : t("Não informado")}</dd>
          <span />
        </div>
      </dl>
    </SecaoRecolhivel>
  );
});
