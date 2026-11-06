"use client";

import Link from "next/link";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ROTEADOR_SOB_DEMANDA, TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";

import { TarefaNoCartao, Concordancia, doRegistro, avisaAEquipe } from "./jev-dados";

/**
 * "Deixar o Jev decidir" muda o atendimento de toda mensagem seguinte: antes de
 * o clique valer, o efeito daquela tarefa (do registro, `aoConfirmarDecidir`) e
 * o caminho de volta.
 */
export function ConfirmarDecidir({
  modoRoteador,
  pedido,
  aoFechar,
  aoConfirmar,
}: {
  modoRoteador?: "comparacao" | "sob_demanda";
  pedido: { tarefa: TarefaNoCartao; aberto: boolean } | null;
  aoFechar: () => void;
  aoConfirmar: (tarefa: TarefaNoCartao) => void;
}) {
  const t = useT();
  const tarefa = pedido?.tarefa ?? null;
  const efeito = tarefa?.id === "roteador" && modoRoteador === "sob_demanda"
    ? ROTEADOR_SOB_DEMANDA : tarefa ? doRegistro(tarefa.id)?.aoConfirmarDecidir : undefined;
  const avisa = tarefa !== null && avisaAEquipe(tarefa.id);
  return (
    <AlertDialog open={pedido?.aberto === true} onOpenChange={(aberto) => !aberto && aoFechar()}>
      <AlertDialogContent data-testid="jev-confirmar-decidir" data-tarefa={tarefa?.id}>
        <AlertDialogHeader>
          <AlertDialogTitle>{avisa ? t("Avisar a equipe?") : t("Deixar o Jev decidir?")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {tarefa && <p className="font-medium text-foreground">{t(tarefa.rotulo)}</p>}
              {efeito !== undefined && <p>{t(efeito)}</p>}
              <p>{t("Dá para voltar a só observar quando quiser.")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => tarefa && aoConfirmar(tarefa)}>
            {avisa ? t("Avisar a equipe") : t("Deixar o Jev decidir")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ConcordanciaDaTarefa({
  tarefa,
  o,
  frase,
  formatar,
}: {
  tarefa: TarefaNoCartao;
  o: Concordancia;
  /** EM QUE os dois concordaram — a régua da tarefa, do registro. */
  frase: { antes: string; depois: string };
  formatar: (n: number) => string;
}) {
  const t = useT();
  const doClima = tarefa.id === TAREFA_DO_CLIMA.id;
  // O testid do clima é o da onda 1: as specs o leem.
  return (
    <p className="text-sm" data-testid={doClima ? "jev-concordancia" : `jev-concordancia-${tarefa.id}`}>
      {o.comparadas === 0 ? (
        t("Ainda não há mensagens medidas pelos dois. A comparação aparece aqui assim que houver.")
      ) : (
        <>
          {t("Nos últimos")} {o.dias} {t(frase.antes)}{" "}
          {/* A fonte do texto, com algarismos de largura igual: a mono, no meio
              da frase, abria "5  de  7" com espaços largos. */}
          <span className="font-medium tabular-nums" data-testid={`jev-concordancia-numeros-${tarefa.id}`}>
            {formatar(o.concordaram)} {t("de")} {formatar(o.comparadas)}
          </span>{" "}
          {t(frase.depois)}
          {o.teto_da_amostra !== undefined && (
            <>
              {" "}
              {t("A conta usa só as")} {formatar(o.teto_da_amostra)} {t("mensagens mais recentes do período.")}
            </>
          )}
          {/* O que decidir muda na manipulação: o alerta forte que só ele daria. */}
          {o.so_o_jev_alto !== undefined && (
            <>
              {" "}
              {t("Só o Jev daria o alerta forte em")}{" "}
              <span className="font-medium tabular-nums">{formatar(o.so_o_jev_alto)}</span>{" "}
              {t("delas — é o que muda se você deixar o Jev decidir.")}
            </>
          )}
        </>
      )}
    </p>
  );
}

/**
 * "Nos últimos 30 dias, o Jev percebeu N mensagens pedindo … em que a regra de
 * hoje não reconheceu o pedido." — e, quando há, as conversas das mais
 * recentes, para quem quer ver o que o cliente disse. Cada link diz de quando é
 * a mensagem: cinco "Abrir conversa" iguais não diriam qual é qual.
 *
 * A frase é traduzida INTEIRA (a do registro, para nenhuma, uma ou várias) e só
 * então recebe os números: o `{n}` em destaque é onde a tradução o pôs. O zero
 * tem frase própria, sem número: "percebeu 0 mensagens" lia-se como defeito.
 */
export function PercebidosDaTarefa({
  tarefa,
  p,
  frase,
  formatar,
}: {
  tarefa: TarefaNoCartao;
  p: NonNullable<TarefaNoCartao["percebidos"]>;
  /** A frase do registro, com `{dias}` e `{n}` (a de nenhuma, só `{dias}`). */
  frase: { nenhuma: string; uma: string; varias: string };
  formatar: (n: number) => string;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const quando = new Intl.DateTimeFormat(tagDoIdioma, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const escolhida = p.mensagens === 0 ? frase.nenhuma : p.mensagens === 1 ? frase.uma : frase.varias;
  const [antes = "", depois] = t(escolhida).replace("{dias}", formatar(p.dias)).split("{n}");
  return (
    <div className="space-y-1 text-sm">
      <p data-testid={`jev-percebidos-${tarefa.id}`}>
        {antes}
        {depois !== undefined && (
          <>
            <span className="font-medium tabular-nums">{formatar(p.mensagens)}</span>
            {depois}
          </>
        )}
      </p>
      {p.mensagens > 0 && p.conversas.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`jev-percebidos-conversas-${tarefa.id}`}>
          <span className="text-muted-foreground">{t("Ver as conversas:")}</span>
          {p.conversas.map((c) => {
            const em = quando.format(new Date(c.em));
            return (
              <Link
                key={c.href}
                className="inline-block py-1 underline underline-offset-4"
                href={c.href}
                aria-label={`${t("Abrir a conversa do pedido de")} ${em}`}
              >
                {em}
              </Link>
            );
          })}
        </p>
      )}
    </div>
  );
}

export function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{rotulo}</dt>
      <dd className="mt-0.5 font-mono text-lg break-words">{valor}</dd>
    </div>
  );
}
