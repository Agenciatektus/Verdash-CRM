"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";
import { DadosDoJev, parada, roda, estadoAoLigar, tarefasDoCartao, origemDoCartao, avisaAEquipe, podeDecidir, decide, fraseObservando } from "./jev-dados";
import { useMudarOJev } from "./JevMudar";

export function ProntoParaLigar({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { mudar, enviando } = useMudarOJev(recarregar);
  const [concordo, setConcordo] = useState(false);
  // O aceite é da empresa, e vale uma vez (D6): religar não pergunta de novo.
  const aceite = dados.config.aceite;
  const pedeAceite = aceite === null;
  // Cada tarefa diz como volta — a frase única de antes falava do clima como se
  // fosse o Jev inteiro, e errava quando as outras tarefas voltavam diferentes.
  const tarefas = tarefasDoCartao(dados).map((tarefa) => ({ tarefa, aoLigar: estadoAoLigar(tarefa, dados) }));
  const doClima = tarefas.find(({ tarefa }) => tarefa.id === TAREFA_DO_CLIMA.id);
  const climaSozinho = !dados.tem_ia_de_sempre && doClima !== undefined && doClima.aoLigar !== "desligada";
  const climaPausadoSemIa = !dados.tem_ia_de_sempre && doClima?.aoLigar === "desligada";
  // O que vai rodar ao ligar, pela família — a frase é verdadeira para isso,
  // como a do cartão ligado (`fraseObservando`): nos pedidos do cliente não há
  // IA de sempre nem o que comparar, e com só eles rodando a frase de comparar
  // era falsa por inteiro.
  const vaoRodar = tarefas.filter(({ tarefa, aoLigar }) => aoLigar !== "desligada" && !parada(tarefa));
  const comparam = vaoRodar.filter(({ tarefa }) => !avisaAEquipe(tarefa.id));
  const pedidos = vaoRodar.filter(({ tarefa }) => avisaAEquipe(tarefa.id));
  const algumaDecide = comparam.some(({ aoLigar }) => aoLigar === "decidindo");
  // As que vão só observar são todas das que não decidem nesta versão (a do
  // follow-up): "antes de deixar o Jev decidir" prometeria um botão que não há.
  const observam = comparam.filter(({ aoLigar }) => aoLigar === "observando");
  const observamSemPoderDecidir = observam.length > 0 && observam.every(({ tarefa }) => !podeDecidir(tarefa.id));
  const algumaPausada = tarefas.some(({ aoLigar }) => aoLigar === "desligada");

  return (
    <div className="mt-4 space-y-4">
      <div>
        <p className="text-sm font-medium">{t("O que o Jev vai fazer")}</p>
        <ul className="mt-1 space-y-1 text-sm">
          {tarefas.map(({ tarefa, aoLigar }) => (
            <li key={tarefa.id} data-testid={`jev-ao-ligar-${tarefa.id}`}>
              <span className="font-medium">{t(tarefa.rotulo)}</span>{" "}
              <span className="text-xs text-muted-foreground">
                (
                {aoLigar === "desligada"
                  ? t("Pausada")
                  : parada(tarefa)
                    ? t("Não roda")
                    : tarefa.id === TAREFA_DO_CLIMA.id && climaSozinho
                      ? t("Decide sozinho")
                      : aoLigar === "decidindo"
                        ? avisaAEquipe(tarefa.id)
                          ? t("Avisa a equipe")
                          : t("Decide")
                        : t("Só observa")}
                )
              </span>
              <span className="text-muted-foreground"> — {t(tarefa.oQueFaz)}</span>
              {/* Antes de ligar também: "Não roda" sem o porquê deixava o leigo
                  sem saber o que fazer — é a primeira impressão de quem ainda
                  não publicou um agente. */}
              {aoLigar !== "desligada" && tarefa.sem_atendente === "ninguem_no_ar" && (
                <span className="text-muted-foreground" data-testid={`jev-ao-ligar-sem-atendente-${tarefa.id}`}>
                  {" "}
                  {t("Não roda agora: nenhum atendente automático está no ar — o Jev só é perguntado onde um atendente responderia. Publique um agente num número, ou tire um agente da pausa, em Agentes.")}
                </span>
              )}
              {aoLigar !== "desligada" && tarefa.sem_atendente === "externo" && (
                <span className="text-muted-foreground" data-testid={`jev-ao-ligar-sem-atendente-${tarefa.id}`}>
                  {" "}
                  {t("Não roda agora: quem conduz as conversas desta empresa é um sistema de fora. O Jev só é perguntado onde um atendente automático daqui responderia.")}
                </span>
              )}
              {aoLigar !== "desligada" && tarefa.sem_fluxo === true && (
                <span className="text-muted-foreground" data-testid={`jev-ao-ligar-sem-fluxo-${tarefa.id}`}>
                  {" "}
                  {t("Não roda agora: nenhum follow-up publicado tem o passo “Classificar (IA)” com duas saídas ou mais. O Jev só lê a resposta do cliente onde a sua IA de sempre escolhe entre saídas — publique, em Follow-ups, um fluxo com esse passo.")}{" "}
                  <Link className="underline underline-offset-4" href="/app/ai/followups">
                    {t("Abrir os follow-ups")}
                  </Link>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="jev-ao-ligar">
          {climaSozinho
            ? t(
                "Sem uma IA principal que meça o clima, o Jev já começa decidindo sozinho nessa tarefa: não há com quem comparar nem quem cubra uma falha dele.",
              )
            : comparam.length === 0
              ? null
              : algumaDecide
                ? observamSemPoderDecidir
                  ? t(
                      "Onde ele decide, vale a escolha que você fez antes de desligá-lo; onde só observa, a sua IA de sempre continua decidindo.",
                    )
                  : t(
                      "Onde ele decide, vale a escolha que você fez antes de desligá-lo; onde só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.",
                    )
                : observamSemPoderDecidir
                  ? t("Onde ele só observa, a sua IA de sempre continua decidindo.")
                  : t(
                      "Onde ele só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.",
                    )}{" "}
          {pedidos.length > 0 &&
            (pedidos.some(({ aoLigar }) => aoLigar === "decidindo")
              ? t(
                  "Nos pedidos do cliente, o Jev conta as mensagens em que a regra de hoje não reconheceu o pedido e avisa a equipe na Central — ele não decide nada no atendimento.",
                )
              : t(
                  "Nos pedidos do cliente, o Jev só conta as mensagens em que a regra de hoje não reconheceu o pedido — nada muda no atendimento.",
                ))}{" "}
          {algumaPausada &&
            t("As tarefas pausadas continuam assim: depois de ligar o Jev, religue-as na lista que aparece aqui.")}{" "}
          {climaPausadoSemIa &&
            t("Sem uma IA principal, o clima religado volta decidindo sozinho: não há com quem comparar nem quem cubra uma falha do Jev.")}
        </p>
      </div>

      <div className="rounded-md border border-border p-3 text-sm">
        <p>
          {/* O aceite nomeia QUEM recebe: via OpenRouter a mensagem passa por ela antes da TypeSafe. */}
          {origemDoCartao(dados) === "openrouter"
            ? t(
                "Ao ligar, cada mensagem que o cliente manda vai para a TypeSafe AI, pela OpenRouter, nos Estados Unidos, uma de cada vez e sem o resto da conversa, para o Jev avaliar. Antes de sair, o sistema apaga CPF, telefone e e-mail do texto. Com o Jev desligado, nada é enviado.",
              )
            : t(
                "Ao ligar, cada mensagem que o cliente manda vai para a TypeSafe AI, nos Estados Unidos, uma de cada vez e sem o resto da conversa, para o Jev avaliar. Antes de sair, o sistema apaga CPF, telefone e e-mail do texto. Com o Jev desligado, nada é enviado.",
              )}
        </p>
        {aceite === null ? (
          <div className="mt-3 flex items-start gap-2">
            <input
              id="jev-aceite"
              type="checkbox"
              className="mt-0.5"
              checked={concordo}
              onChange={(e) => setConcordo(e.target.checked)}
              disabled={!dados.pode_editar}
            />
            <label htmlFor="jev-aceite" className="text-sm">
              {origemDoCartao(dados) === "openrouter"
                ? t(
                    "Concordo com o envio de cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, pela OpenRouter, nos Estados Unidos.",
                  )
                : t(
                    "Concordo com o envio de cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, nos Estados Unidos.",
                  )}
            </label>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Envio aceito pela empresa em")}{" "}
            {new Date(aceite.em).toLocaleDateString(tagDoIdioma)}.
          </p>
        )}
      </div>

      {dados.pode_editar && (
        <Button
          size="sm"
          disabled={enviando || (pedeAceite && !concordo)}
          onClick={() =>
            void mudar(pedeAceite ? { ligado: true, aceite_lgpd: true } : { ligado: true }, t("O Jev foi ligado."))
          }
        >
          {enviando ? t("Ligando…") : t("Ligar o Jev")}
        </Button>
      )}
    </div>
  );
}
