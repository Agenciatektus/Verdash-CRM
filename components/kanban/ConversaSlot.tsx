"use client";
import Link from "next/link";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ChatCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";
import { AbrirConversaDoLead, temAlvoParaAbrir } from "./AbrirConversaDoLead";

/**
 * A última mensagem do negócio. Fora do card do funil, com atalho para o inbox;
 * no card (`enxuto`), só leitura: o clique é do card e abre o dossiê.
 *
 * ─── Por que atalho e não um composer aqui dentro ───────────────────────────
 *
 * Responder de dentro do quadro exigiria trazer o composer inteiro — anexos,
 * templates, notas internas, gravação de áudio — para uma segunda tela. Duas
 * cópias do mesmo campo divergem: a correção entra numa e não na outra, e o
 * atendente aprende que "no Kanban não funciona igual". O inbox já é o lugar
 * onde se conversa; o que faltava era chegar nele sem procurar.
 *
 * ─── O que a prévia resolve ─────────────────────────────────────────────────
 *
 * Sem ela o atalho é uma aposta: clicar para descobrir se vale a pena. Com a
 * última mensagem à vista, o vendedor decide olhando o quadro — que é para o
 * que o quadro serve.
 *
 * ─── Ausência é estado normal, não erro ─────────────────────────────────────
 *
 * Negócio criado à mão ou por webhook não tem contato; contato pode não ter
 * conversa. Nesses casos o slot não aparece — e NÃO aparece um "sem mensagens"
 * cinza, que ocuparia a mesma linha em metade dos cards para não dizer nada.
 *
 * ─── Sem conversa, mas com contato: a AÇÃO no lugar da prévia ────────────────
 *
 * O lead do webhook chega com telefone e sem thread (issue #1993). Para ele a
 * linha não some: vira o botão "Abrir conversa", que usa a rota já existente e
 * leva para a Inbox. `conversa === undefined` continua mudo — é "ainda não
 * carregou", e prometer ação sobre um dado que pode existir seria mentir.
 */
export function ConversaSlot({
  conversa,
  enxuto = false,
  contactId,
  phone,
}: {
  conversa: Lead["conversa"];
  contactId?: string | null;
  phone?: string | null;
  /**
   * No card novo do funil o canal já está no selo do avatar e as não lidas no
   * topo: aqui fica só a última mensagem. Repetir os dois seria o mesmo dado
   * duas vezes no mesmo card.
   */
  enxuto?: boolean;
}) {
  const t = useT();
  if (conversa === undefined) return null;
  if (conversa === null) {
    // A guarda de alvo fica AQUI, antes de montar: montar o botão sem contato
    // nem telefone desenharia (e custaria router + query client) uma linha que
    // não tem o que dizer.
    return temAlvoParaAbrir(contactId, phone) ? (
      <AbrirConversaDoLead contactId={contactId} phone={phone} />
    ) : null;
  }

  const preview = conversa.preview?.trim();
  const temNaoLidas = conversa.unread > 0;

  // POR ONDE o negócio chegou. Só aparece quando há valor: card de WhatsApp não
  // ganha selo vazio, e é a ausência que mantém a linha legível nos outros.
  //
  // Importa para quem vai atender: quem mandou Direct escreveu no privado e
  // espera resposta ali; quem veio de comentário deixou um recado público. A
  // abordagem não é a mesma, e sem o selo o card não distingue as duas.
  const entrada = conversa.instagram_entrada ?? null;
  const rotuloEntrada = enxuto
    ? null
    : entrada === "direct" ? t("Direct") : entrada === "comentario" ? t("Comentário") : null;

  const conteudo = (
    <>
      <ChatCircle size={12} weight="regular" className="shrink-0" aria-hidden />
      {rotuloEntrada && (
        <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 text-text-muted">
          {rotuloEntrada}
        </span>
      )}
      <span className="truncate">
        {preview || <span className="italic">{t("conversa sem mensagens")}</span>}
      </span>
      {temNaoLidas && !enxuto && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
    </>
  );

  // No card do funil a prévia é só leitura: o clique sobe para o card e abre o
  // dossiê, que já tem a conversa e o composer (pedido do Peterson, 20/10). Antes
  // era um atalho para o Inbox, do tempo em que o dossiê não tinha a conversa, e
  // o mesmo card levava a dois lugares conforme o ponto clicado.
  if (enxuto) {
    return <p className="mt-1 flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-text-muted">{conteudo}</p>;
  }

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      // O card inteiro é arrastável e clicável (abre o dossiê). Sem parar a
      // propagação, o clique no atalho também abriria o dossiê por baixo — dois
      // destinos para um gesto.
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onPointerDown={(e: MouseEvent) => e.stopPropagation()}
      className={cn(
        "group/conversa mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px]",
        "text-text-muted transition-colors hover:bg-muted hover:text-foreground",
      )}
      title={t("Abrir esta conversa no Inbox")}
    >
      {conteudo}
    </Link>
  );
}
