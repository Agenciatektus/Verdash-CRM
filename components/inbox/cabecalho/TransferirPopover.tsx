"use client";
import { useState, type ComponentProps } from "react";

import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { FotoDaPessoa } from "@/components/fotos/FotoDaPessoa";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTransferConversation } from "@/hooks/inbox/useTransferConversation";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { outrosNumerosDoContato } from "@/lib/inbox/outros-numeros";
import { ArrowsLeftRight, Robot } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<string, string> = {
  agent: "Atendente",
  manager: "Gestor",
  admin: "Admin",
};

/** Acima disto a lista ganha busca: rolar procurando um nome é mais lento que digitar. */
const LIMIAR_DA_BUSCA = 6;

const ITEM =
  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-hidden disabled:opacity-50";

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return (partes[0]![0]! + partes[partes.length - 1]![0]!).toUpperCase();
}

interface Props {
  conversationId: string;
  /** Há trava a desfazer: a lista oferece devolver ao automático (mesma mutação do botão). */
  devolver?: { onDevolver: () => void; pendente: boolean };
  /**
   * A saída por outro número do contato. Só vira item quando há OUTRO número com
   * telefone, a mesma regra da aba Número do diálogo (`outrosNumerosDoContato`).
   */
  numero?: ComponentProps<typeof ReassignDialog>["numero"];
}

/**
 * TRANSFERIR, em popover ancorado no ícone.
 *
 * Era um diálogo modal com um `Select` dentro: três cliques e a tela inteira
 * escurecida para escolher um nome. A fonte dos destinos e a rota são as
 * MESMAS (`useAssignableMembers` e `useTransferConversation`): a rota é que
 * valida destino ativo da org e grava o evento auditável. O motivo opcional
 * continua aqui, porque o histórico de atribuição o mostra.
 *
 * A aba "Número" (continuar por outro número do contato) não coube num
 * popover: ela segue no `ReassignDialog`, aberto pelo último item da lista.
 */
export function TransferirPopover({ conversationId, devolver, numero }: Props) {
  const t = useT();
  const { user } = useAuth();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [motivo, setMotivo] = useState("");
  // Escolher um nome SÓ seleciona; quem transfere é o botão de confirmar. Um
  // clique errado na lista (rolagem, toque no celular) passava a conversa para
  // outra pessoa sem volta (revisão do @Cassio_SecRev).
  const [destino, setDestino] = useState<string | null>(null);
  const members = useAssignableMembers(aberto);
  const transfer = useTransferConversation();
  const [numeroAberto, setNumeroAberto] = useState(false);
  const { data: sessoes } = useChannelSessions({ enabled: aberto && numero != null });
  const temOutroNumero = numero != null && outrosNumerosDoContato(sessoes, numero.channelSessionId).length > 0;

  const opcoes = (members.data ?? []).filter((m) => m.user_id !== user.id);
  const termo = busca.trim().toLocaleLowerCase();
  const escolhido = opcoes.find((m) => m.user_id === destino) ?? null;
  // #3023: a régua única do rótulo do membro (sem pedaço de uuid na tela).
  const nomeDe = (m: { full_name: string | null; user_id: string }) => rotuloDoMembro(m, t);
  const visiveis = termo
    ? opcoes.filter((m) => (m.full_name ?? "").toLocaleLowerCase().includes(termo))
    : opcoes;

  function alternar(v: boolean) {
    if (!v) {
      setBusca("");
      setMotivo("");
      setDestino(null);
    }
    setAberto(v);
  }

  return (
    <Popover open={aberto} onOpenChange={alternar}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="w-9 px-0"
          aria-label={t("Transferir conversa")}
          // Guia curta (#3003): "Transferir" não diz PARA QUEM.
          title={t("Passa esta conversa para outro atendente. Se houver outro número conectado, dá para continuar o atendimento por ele.")}
        >
          <ArrowsLeftRight size={18} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent folhaNoCelular align="end" className="w-72 p-1.5" aria-label={t("Transferir para")}>
        <p className="px-2 pb-1 pt-1.5 text-xs font-semibold text-text-muted">{t("Transferir para")}</p>
        {/* O motivo vem ANTES da lista: lido depois da escolha, ficava fora da
            vista de quem já tinha decidido. */}
        <Input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          maxLength={500}
          placeholder={t("Motivo (opcional)")}
          aria-label={t("Motivo (opcional)")}
          className="mb-1 h-8 text-sm"
        />
        {opcoes.length > LIMIAR_DA_BUSCA && (
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Buscar atendente")}
            aria-label={t("Buscar atendente")}
            className="mb-1 h-8 text-sm"
          />
        )}
        <div className="max-h-64 overflow-y-auto" role="radiogroup" aria-label={t("Transferir para")}>
          {members.isLoading && <p className="px-2 py-2 text-xs text-text-muted">{t("Carregando atendentes…")}</p>}
          {!members.isLoading && opcoes.length === 0 && (
            <p className="px-2 py-2 text-xs text-text-muted">
              {t("Nenhum outro atendente disponível nesta organização.")}
            </p>
          )}
          {visiveis.map((m) => {
            const nome = nomeDe(m);
            const marcado = destino === m.user_id;
            return (
              <button
                key={m.user_id}
                type="button"
                role="radio"
                aria-checked={marcado}
                className={cn(ITEM, marcado && "bg-accent-soft font-semibold text-accent")}
                disabled={transfer.isPending}
                onClick={() => setDestino(m.user_id)}
              >
                <FotoDaPessoa
                  userId={m.user_id}
                  iniciais={iniciais(nome)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{nome}</span>
                <span className="text-xs text-text-muted">{t(ROLE_LABEL[m.role] ?? m.role)}</span>
              </button>
            );
          })}
        </div>
        {devolver && (
          <button type="button" className={ITEM} disabled={devolver.pendente} onClick={() => { devolver.onDevolver(); alternar(false); }}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent text-accent" aria-hidden>
              <Robot size={12} />
            </span>
            <span className="flex-1">{t("Devolver à IA")}</span>
          </button>
        )}
        <Button
          size="sm"
          className="mt-1 w-full"
          disabled={!escolhido || transfer.isPending}
          onClick={() =>
            escolhido &&
            transfer.mutate(
              { conversation_id: conversationId, to_user_id: escolhido.user_id, reason: motivo.trim() || undefined },
              { onSuccess: () => alternar(false) },
            )
          }
        >
          {transfer.isPending
            ? t("Transferindo…")
            : escolhido
              ? `${t("Transferir para")} ${nomeDe(escolhido)}`
              : t("Escolha o atendente")}
        </Button>
        <div className="my-1 h-px bg-border" />
        {temOutroNumero && (
          <button type="button" className={`${ITEM} mt-1`} onClick={() => { alternar(false); setNumeroAberto(true); }}>
            <span className="flex-1">{t("Continuar por outro número")}</span>
          </button>
        )}
      </PopoverContent>
      {numero && (
        <ReassignDialog
          conversationId={conversationId}
          open={numeroAberto}
          onOpenChange={setNumeroAberto}
          abaInicial="numero"
          numero={numero}
        />
      )}
    </Popover>
  );
}
