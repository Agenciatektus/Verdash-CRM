"use client";

import type { Locale } from "date-fns";
import { format, isToday, isYesterday } from "date-fns";

import { Button } from "@/components/ui/button";
import { NoteCard } from "@/components/inbox/NoteCard";
import { PassagemCard } from "@/components/inbox/PassagemCard";
import type { ReacaoNoBalao } from "@/lib/inbox/reacoes-no-fio";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { Message } from "@/lib/types/messaging";

import { DivisorDeNovas, DivisorDoDia } from "./Divisores";
import { LinhaDaMensagem, type AcoesDoFio } from "./LinhaDaMensagem";
import type { LinhaDoFio } from "./linhas";

function dayLabel(d: Date, t: (texto: string) => string, locale: Locale): string {
  if (isToday(d)) return t("Hoje");
  if (isYesterday(d)) return t("Ontem");
  return format(d, "dd/MM/yyyy", { locale });
}

/** O que o fio sabe e cada linha precisa — montado UMA vez por render do fio. */
export interface ContextoDoFio {
  carregarMais: () => void;
  carregandoMais: boolean;
  resultados: Set<string>;
  porId: Map<string, Message>;
  debugCitations: boolean;
  temResponder: boolean;
  temEncaminhar: boolean;
  reacoesPorAlvo: Map<string, ReacaoNoBalao[]>;
  usuarioId: string;
  canalAlteraEnviada: boolean;
  podeGerir: boolean;
  acoes: AcoesDoFio;
  contatoId: string | null;
  assumindo: boolean;
  onAssumir: () => void;
  onExcluirNota: (id: string) => void;
  /** B15: a bolha oferece "Tentar de novo"? (`useReenvioDoFio`) */
  ofereceReenvio?: (m: Message) => boolean;
  reenviar?: (m: Message) => void;
}

/**
 * Uma linha do fio virtualizado. Saiu de `ChatThread.tsx` na fase 3.5 para o
 * fio caber em 300 linhas; o comportamento de cada tipo é o mesmo de antes.
 *
 * As linhas que não são bolha (dia, novas, carregar mais) têm altura própria e
 * são MEDIDAS pelo virtualizador como qualquer outra: o padding mora dentro da
 * linha, e não como margem, porque margem não entra no `getBoundingClientRect`
 * que o `measureElement` lê — e uma altura medida a menos desloca a âncora.
 */
export function ConteudoDaLinha({ linha, inicioDoBloco, ctx }: { linha: LinhaDoFio; inicioDoBloco: boolean; ctx: ContextoDoFio }) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  if (linha.tipo === "mais")
    return (
      <div className="flex justify-center py-2">
        <Button size="sm" variant="ghost" onClick={ctx.carregarMais} disabled={ctx.carregandoMais}>
          {ctx.carregandoMais ? t("Carregando…") : t("Carregar mais antigas")}
        </Button>
      </div>
    );
  if (linha.tipo === "dia") return <DivisorDoDia rotulo={dayLabel(linha.data, t, localeDaData)} />;
  if (linha.tipo === "novas") return <DivisorDeNovas quantas={linha.quantas} />;
  const item = linha.item;
  if (item.kind === "passagem")
    return (
      <div className="pt-1">
        <PassagemCard
          cartao={item.data}
          contatoId={ctx.contatoId}
          assumindo={ctx.assumindo}
          // O MESMO gesto do cabeçalho — uma rota, um efeito. Uma segunda
          // maneira de assumir seria uma segunda chance de os dois caminhos
          // divergirem sobre o que "assumir" faz.
          onAssumir={ctx.onAssumir}
        />
      </div>
    );
  if (item.kind === "note")
    return (
      <div className="pt-1">
        <NoteCard
          note={item.data}
          // Só o autor ou manager+ vê o excluir — o backend barra o resto (403),
          // então não mostramos um botão que daria erro.
          onDelete={
            item.data.created_by_user_id === ctx.usuarioId || ctx.podeGerir
              ? () => ctx.onExcluirNota(item.data.id)
              : undefined
          }
        />
      </div>
    );
  return (
    <LinhaDaMensagem
      message={item.data}
      searchMatch={ctx.resultados.has(item.data.id)}
      debugCitations={ctx.debugCitations}
      temResponder={ctx.temResponder}
      temEncaminhar={ctx.temEncaminhar}
      reacoes={ctx.reacoesPorAlvo.get(item.data.id)}
      // A citada sai da MESMA lista já carregada: buscar no servidor por cada
      // citação faria uma consulta por bolha. Quando a citada é antiga demais e
      // ficou fora da página, o fio some — melhor que segurar a conversa.
      citada={ctx.porId.get(item.data.reply_to_message_id ?? "") ?? null}
      // Sem isto o balão diz "Você" em toda mensagem digitada no CRM —
      // inclusive nas do colega, porque `sent_via='user'` só registra que um
      // humano digitou, nunca qual.
      viewerUserId={ctx.usuarioId}
      podeAlterar={ctx.canalAlteraEnviada && item.data.sent_by_user_id === ctx.usuarioId}
      podeModerar={ctx.podeGerir && item.data.direction === "inbound"}
      inicioDoBloco={inicioDoBloco}
      acoes={ctx.acoes}
      podeReenviar={ctx.ofereceReenvio?.(item.data) ?? false}
      reenviar={ctx.reenviar}
    />
  );
}
