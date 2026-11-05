"use client";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import type { ChannelSummary } from "@/hooks/inbox/useConversationsRealtime";
import { useT } from "@/hooks/i18n/useT";
import { channelBrand, CHANNEL_BRAND_LABEL } from "@/lib/channels/presentation";
import type { Comando } from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";

/** O separador do protótipo: um ponto desenhado, não um caractere na frase. */
function Sep() {
  return <i className="h-1 w-1 shrink-0 rounded-full bg-border-strong" aria-hidden />;
}

interface Props {
  nome: string;
  /** Rótulo do ciclo de vida, já traduzido (Aberta, Fechada…). */
  status: string;
  encerrada: boolean;
  canal: ChannelSummary | null | undefined;
  /** O nome do canal dado em Conexões (#2383); sem ele, a marca do provedor. */
  rotuloCanal?: string | null;
  telefone: string | null;
  comando: Comando;
  meuUserId: string;
}

/**
 * QUEM é a conversa: nome, ciclo de vida, canal, telefone e quem atende.
 *
 * Quem atende vira frase na sub-linha (H2 da auditoria), na mesma régua de
 * `comandoDaConversa` que a lista e a faixa do composer usam. O testid é
 * contrato de `inbox-quem-manda.spec.ts`.
 */
export function IdentidadeDaConversa({ nome, status, encerrada, canal, rotuloCanal, telefone, comando, meuUserId }: Props) {
  const t = useT();
  const marca = channelBrand(canal);
  const rotuloDoCanal = marca === "unknown" ? null : CHANNEL_BRAND_LABEL[marca];

  return (
    // Sem avatar: no protótipo ele mora só no painel do lead, ao lado, e
    // repeti-lo aqui gastava 52px da linha do nome na coluna mais disputada.
    // `basis-56`: no cabeçalho com `flex-wrap`, sem base o nome encolhia a zero e as
    // ações cobriam a linha (iPad 820px, chat estreito); com base, as ações descem.
    <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-base font-bold" title={nome}>
            {nome}
          </h1>
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-2 py-px text-xs font-semibold",
              encerrada ? "bg-surface-elevated text-text-muted" : "bg-success-bg text-success-fg",
            )}
          >
            {status}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[13px] text-text-muted">
          {canal && (
            <span
              className="inline-flex min-w-0 max-w-[12rem] items-center gap-1"
              title={rotuloCanal ? `${t("Entrou por")} ${rotuloCanal}` : undefined}
              data-testid={rotuloCanal ? "canal-da-conversa" : undefined}
            >
              <ChannelLogo channel={canal} size={14} />
              <span className="truncate">{rotuloCanal ?? rotuloDoCanal}</span>
            </span>
          )}
          {canal && telefone && <Sep />}
          {telefone && <span className="truncate font-mono text-xs">{telefone}</span>}
          {(canal || telefone) && <Sep />}
          {/* H2: quem atende como FRASE na sub-linha ("Você está atendendo",
              "IA atendendo"), como no protótipo, e não um selo. O testid é
              contrato de `inbox-quem-manda.spec.ts`. */}
          <span className="min-w-0 truncate font-semibold text-text-muted" data-testid="comando-da-conversa">
            {comando.quem === "humano"
              ? comando.userId === meuUserId
                ? t("Você está atendendo")
                : `${comando.nome ?? t("Atendente")} ${t("está atendendo")}`
              : comando.quem === "automatico"
                ? t("IA atendendo")
                : t("Sem responsável")}
          </span>
        </div>
      </div>
    </div>
  );
}
