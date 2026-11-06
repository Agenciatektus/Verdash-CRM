"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Escolha } from "@/components/ui/escolha";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { CaretRight } from "@/lib/ui/icons";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { ROTEADOR_SOB_DEMANDA, ROTEADOR_SOB_DEMANDA_SEM_IA, TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";
import { O_QUE_FAZER_DO_JEV } from "@/lib/ai/decisao/textos";

import { DadosDoJev, TarefaNoCartao, parada, roda, concordanciaDa, tarefasDoCartao, corpoDaMudanca, Estado, doRegistro, avisaAEquipe, podeDecidir, decide, fraseObservando, fraseDecidindo, roteadorSobDemanda } from "./jev-dados";
import { ConfirmarDecidir, ConcordanciaDaTarefa, PercebidosDaTarefa, Numero } from "./JevPecas";
import { useMudarOJev } from "./JevConfiguracao";
import { LinhaDaTarefa } from "./JevLinhaDaTarefa";

export function Ligado({
  dados,
  estado,
  recarregar,
}: {
  dados: DadosDoJev;
  estado: Estado;
  recarregar: () => Promise<void>;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { mudar, enviando } = useMudarOJev(recarregar);
  // A tarefa cujo "Deixar o Jev decidir" espera confirmação. Só decidir pede:
  // pausar e voltar a observar só tiram o Jev do caminho do cliente. Fechado, o
  // diálogo guarda a tarefa: o texto não some durante a animação de saída.
  const [aConfirmar, setAConfirmar] = useState<{ tarefa: TarefaNoCartao; aberto: boolean } | null>(null);
  const n = dados.numeros;

  // `cost_cents` é centavo de DÓLAR, e o Jev custa fração de centavo por
  // mensagem: com 2 casas a semana inteira mostraria "US$ 0,00".
  const usd = new Intl.NumberFormat(tagDoIdioma, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const segundos = new Intl.NumberFormat(tagDoIdioma, { maximumFractionDigits: 1 });
  const inteiro = new Intl.NumberFormat(tagDoIdioma);
  // Só com o Jev medindo de verdade a linha de cada tarefa mostra o estado e o
  // botão — e em pausa também, que é de onde se religa a tarefa desligada. E
  // decidindo sozinho: o clima decide sem reserva, mas as outras tarefas rodam
  // como sempre, e sem a linha delas a única saída de uma tarefa nova era
  // desligar o Jev inteiro.
  const rodando = estado === "observando" || estado === "decidindo" || estado === "em_pausa" || estado === "sozinho";
  const observando = tarefasDoCartao(dados).filter((x) => x.estado === "observando").length;
  const decidindo = tarefasDoCartao(dados).filter((x) => x.estado === "decidindo").length;
  const todasPausadas = tarefasDoCartao(dados).every((t) => t.estado === "desligada");
  const falha = dados.ultima_falha;
  const frasesDeFalha: Readonly<Record<string, string>> = O_QUE_FAZER_DO_JEV;
  const oQueFazer = falha?.motivo ? frasesDeFalha[falha.motivo] : undefined;

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm">
        {estado === "observando" && fraseObservando(dados, t)}
        {estado === "decidindo" && fraseDecidindo(dados, t)}
        {estado === "sozinho" &&
          t(
            "Decidindo sozinho no clima — a empresa ainda não tem uma IA principal que meça o clima, então o Jev mede sem reserva. As outras tarefas dizem abaixo o que fazem.",
          )}
        {estado === "parado" &&
          t("Ligado, mas parado: o Jev só volta a medir quando a chave passar no teste.")}
        {estado === "em_pausa" &&
          (todasPausadas
            ? t("Ligado, mas com todas as tarefas pausadas: o Jev não mede nada até você religar uma abaixo.")
            : t(
                "Ligado, mas nenhuma tarefa está rodando agora: o Jev não mede nada. Veja abaixo o que falta nas que dizem “Não roda”, ou religue uma pausada.",
              ))}
      </p>

      {/* Uma linha por tarefa: o estado dela e o "Deixar o Jev decidir" dela.
          Com a chave parada, o selo do cartão já diz o estado de todas, e a
          linha não repete nem oferece o botão. Sem a IA de sempre, o clima
          decide sozinho e só se pausa; as outras seguem como sempre. */}
      <details className="group rounded-md border border-border" data-testid="jev-tarefas">
        <summary
          className="flex cursor-pointer list-none items-center gap-3 p-3 text-sm [&::-webkit-details-marker]:hidden"
          data-testid="jev-tarefas-resumo"
        >
          <span className="min-w-0 flex-1 font-medium">
            {observando} {t("observando")}, {decidindo} {t("decidindo")}
          </span>
          <span className="text-muted-foreground">{t("Ver tarefas")}</span>
          <CaretRight size={16} aria-hidden className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
      <ul className="divide-y divide-border border-t border-border" data-testid="jev-tarefas-lista">
        {tarefasDoCartao(dados).map((tarefa) => (
          <LinhaDaTarefa
            key={tarefa.id}
            tarefa={tarefa}
            dados={dados}
            estado={estado}
            rodando={rodando}
            enviando={enviando}
            mudar={mudar}
            aoPedirDecidir={(tarefa) => setAConfirmar({ tarefa, aberto: true })}
          />
        ))}
      </ul>
      </details>

      <div>
        <p className="text-xs text-muted-foreground">
          {t("Nos últimos")} {n.dias} {t("dias")}
        </p>
        {/* As colunas seguem a largura do CARTÃO, não a da tela: com a barra
            lateral aberta, um tablet de 800 px dava 3 colunas de 117 px e
            partia "US$ 0,000049" (130 px) em duas linhas. 9rem cabe o número
            mais largo; abaixo disso a coluna desce para a linha seguinte. */}
        <dl
          className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-3 border-t border-border pt-3"
          data-testid="jev-numeros"
        >
          {/* Respostas, e não mensagens: com mais de uma tarefa, cada mensagem
              do cliente rende uma resposta por tarefa. */}
          <Numero rotulo={t("Respostas do Jev")} valor={inteiro.format(n.decisoes)} />
          <Numero rotulo={t("Clientes irritados percebidos")} valor={inteiro.format(n.irritados)} />
          <Numero
            rotulo={t("Custo")}
            valor={n.custo_cents === null ? "—" : usd.format(n.custo_cents / 100)}
          />
          <Numero
            rotulo={t("Tempo médio")}
            valor={n.latencia_media_ms === null ? "—" : `${segundos.format(n.latencia_media_ms / 1000)} s`}
          />
          {/* Sem IA de sempre para o clima não há quem o cubra: um zero que nunca
              muda só confunde. Mas o roteador tem a IA dele, e a cobertura dele
              conta aqui também. */}
          {(dados.tem_ia_de_sempre || n.reservas > 0) && (
            <Numero rotulo={t("Vezes que a IA de sempre cobriu o Jev")} valor={inteiro.format(n.reservas)} />
          )}
        </dl>
        {n.custo_incompleto && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="jev-custo-parcial">
            {t(
              "Parte das medições veio de uma versão do Jev sem preço conhecido: o custo mostrado soma só as outras.",
            )}
          </p>
        )}
      </div>

      {falha && (
        <p className="rounded-md bg-warning-bg p-2 text-xs text-warning-fg" data-testid="jev-ultima-falha">
          <span className="font-medium">
            {t("Última falha")}
            {falha.tarefa ? <> — {t(falha.tarefa)}</> : null} ({new Date(falha.em).toLocaleString(tagDoIdioma)}):
          </span>{" "}
          {oQueFazer ? t(oQueFazer) : t("O Jev não conseguiu medir.")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* `py-1`: 28 px de alvo de toque (tinha 20), sem deixar de parecer link. */}
        <Link
          className="inline-block py-1 text-sm underline underline-offset-4"
          href={`/app/ai/runs?provider=${PROVEDOR_DO_JEV}`}
        >
          {t("Ver as decisões do Jev")}
        </Link>
        {dados.pode_editar && (
          <Button
            size="sm"
            variant="ghost"
            disabled={enviando}
            onClick={() => void mudar({ ligado: false }, t("O Jev foi desligado."))}
          >
            {t("Desligar")}
          </Button>
        )}
      </div>

      <ConfirmarDecidir
        modoRoteador={roteadorSobDemanda(dados) ? "sob_demanda" : "comparacao"}
        pedido={aConfirmar}
        aoFechar={() => setAConfirmar((p) => p && { ...p, aberto: false })}
        aoConfirmar={(tarefa) =>
          void mudar(
            corpoDaMudanca(tarefa, "decidindo"),
            avisaAEquipe(tarefa.id) ? t("Agora o Jev avisa a equipe.") : t("Agora o Jev decide."),
          )
        }
      />
    </div>
  );
}
