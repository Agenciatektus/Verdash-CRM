"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Escolha } from "@/components/ui/escolha";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ROTEADOR_SOB_DEMANDA, ROTEADOR_SOB_DEMANDA_SEM_IA, TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";

import {
  type DadosDoJev,
  type Estado,
  type TarefaNoCartao,
  avisaAEquipe,
  concordanciaDa,
  corpoDaMudanca,
  doRegistro,
  parada,
  podeDecidir,
  roda,
  roteadorSobDemanda,
} from "./jev-dados";
import { ConcordanciaDaTarefa, PercebidosDaTarefa } from "./JevPecas";
import type { useMudarOJev } from "./JevConfiguracao";

/** Uma linha por tarefa: o estado dela e o "Deixar o Jev decidir" dela. */
export function LinhaDaTarefa({
  tarefa,
  dados,
  estado,
  rodando,
  enviando,
  mudar,
  aoPedirDecidir,
}: {
  tarefa: TarefaNoCartao;
  dados: DadosDoJev;
  estado: Estado;
  rodando: boolean;
  enviando: boolean;
  mudar: ReturnType<typeof useMudarOJev>["mudar"];
  aoPedirDecidir: (tarefa: TarefaNoCartao) => void;
}) {
  const t = useT();
  const inteiro = new Intl.NumberFormat(useTagDeIdioma());
          const registro = doRegistro(tarefa.id);
          const aoDecidir = tarefa.id === "roteador" && roteadorSobDemanda(dados)
            ? ROTEADOR_SOB_DEMANDA : registro?.aoDecidir;
          const avisa = avisaAEquipe(tarefa.id);
          const climaSozinho = estado === "sozinho" && tarefa.id === TAREFA_DO_CLIMA.id;
          const climaSemIa = tarefa.id === TAREFA_DO_CLIMA.id && !dados.tem_ia_de_sempre;
  return (
          <li
            className="space-y-2 p-3"
            data-testid={`jev-tarefa-${tarefa.id}`}
            data-estado={tarefa.estado}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t(tarefa.rotulo)}</span>
              {rodando && (
                <Badge
                  variant={
                    climaSozinho ? "warning" : roda(tarefa) && tarefa.estado === "decidindo" ? "success" : "neutral"
                  }
                >
                  {/* "Pausada", o verbo do botão: "Desligada" ao lado de "Pausar
                      esta tarefa" e do "Desligar" do Jev inteiro confundia os dois. */}
                  {tarefa.estado === "desligada"
                    ? t("Pausada")
                    : parada(tarefa)
                      ? t("Não roda")
                      : climaSozinho
                        ? t("Decide sozinho")
                        : tarefa.estado === "observando"
                          ? t("Só observa")
                          : avisa
                            ? t("Avisa a equipe")
                            : t("Decide")}
                </Badge>
              )}
              {/* "Nova": a tarefa é feminina. A chave "Novo" é a do agente novo. */}
              {tarefa.novo && <Badge variant="info">{t("Nova")}</Badge>}
            </div>

            {/* O selo sozinho não explicava nada e nunca sumia: diz o que ele
                quer dizer, e "Manter só observando" (abaixo) o tira. Parada, ela
                não observa nada — a linha do "Não roda" diz por quê. */}
            {rodando && tarefa.novo && tarefa.estado === "observando" && !parada(tarefa) && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-nova-${tarefa.id}`}>
                {avisa
                  ? t("Começou sozinha, só observando: nada muda até você pedir para o Jev avisar a equipe.")
                  : podeDecidir(tarefa.id)
                    ? t("Começou sozinha, só observando: nada muda para o cliente até você deixar o Jev decidir.")
                    : t("Começou sozinha, só observando: nada muda para o cliente.")}
              </p>
            )}

            {/* Sem esta linha, a tarefa ficava "Só observa" esperando uma
                comparação que nunca vem: o turno só pergunta ao Jev onde a IA
                de sempre também pergunta. Hoje só a manipulação acompanha camada.
                O nome é o que a tela do agente mostra — "Segurança" é só o nosso. */}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_camada && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-camada-${tarefa.id}`}>
                {t(
                  "Não roda agora: a verificação “Detectar tentativa de manipular o assistente” está desligada. Ela vale para a empresa toda: ligue-a abrindo qualquer agente, na aba “Confere antes de enviar”, em “Antes de o assistente ler”. O Jev só pergunta onde a sua IA de sempre também pergunta.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/agents">
                  {t("Abrir os agentes")}
                </Link>
              </p>
            )}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_roteador && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-roteador-${tarefa.id}`}>
                {t(
                  "Não roda agora: nenhum roteador de intenção ativo tem intenções para o Jev escolher. O Jev só escolhe o agente onde um roteador já escolhe — ative um, com as intenções dele, em Roteadores.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/routers">
                  {t("Abrir os roteadores")}
                </Link>
              </p>
            )}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_fluxo === true && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-fluxo-${tarefa.id}`}>
                {t(
                  "Não roda agora: nenhum follow-up publicado tem o passo “Classificar (IA)” com duas saídas ou mais. O Jev só lê a resposta do cliente onde a sua IA de sempre escolhe entre saídas — publique, em Follow-ups, um fluxo com esse passo.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/followups">
                  {t("Abrir os follow-ups")}
                </Link>
              </p>
            )}
            {/* As de pedido só são perguntadas onde o atendimento automático
                responderia: sem ele em número nenhum, "Só observa" com "nenhuma
                mensagem" seria para sempre. */}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_atendente === "ninguem_no_ar" && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-atendente-${tarefa.id}`}>
                {t(
                  "Não roda agora: nenhum atendente automático está no ar — o Jev só é perguntado onde um atendente responderia. Publique um agente num número, ou tire um agente da pausa, em Agentes.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/agents">
                  {t("Abrir os agentes")}
                </Link>
              </p>
            )}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_atendente === "externo" && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-atendente-${tarefa.id}`}>
                {t(
                  "Não roda agora: quem conduz as conversas desta empresa é um sistema de fora. O Jev só é perguntado onde um atendente automático daqui responderia.",
                )}
              </p>
            )}

            {/* Sem o botão, o porquê: a tarefa que só observa nesta versão. */}
            {rodando && roda(tarefa) && registro?.soObserva !== undefined && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-so-observa-${tarefa.id}`}>
                {t(registro.soObserva)}
              </p>
            )}

            {rodando && roda(tarefa) && tarefa.estado === "decidindo" && aoDecidir !== undefined && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-decide-${tarefa.id}`}>
                {t(aoDecidir)}
              </p>
            )}

            {/* A concordância de cada tarefa com a IA de sempre — o que se lê antes
                de deixar o Jev decidir. O clima conta "chamariam uma pessoa"; as
                outras, o mesmo rótulo (em `jev_observacoes`). A em cascata não
                concorda com nada — a regra de hoje sempre disse não onde ele foi
                perguntado —, e conta as mensagens em que ele percebeu o pedido. */}
            {rodando && roda(tarefa) && registro?.familia === "cascata" && tarefa.percebidos && (
              <PercebidosDaTarefa
                tarefa={tarefa}
                p={tarefa.percebidos}
                frase={registro.percebidos}
                formatar={(n) => inteiro.format(n)}
              />
            )}
            {rodando && roda(tarefa) && tarefa.estado === "observando" && !climaSozinho && registro?.familia !== "cascata" && concordanciaDa(tarefa, dados) !== null && (
              <ConcordanciaDaTarefa
                tarefa={tarefa}
                o={concordanciaDa(tarefa, dados)!}
                frase={registro?.concordancia ?? TAREFA_DO_CLIMA.concordancia}
                formatar={(n) => inteiro.format(n)}
              />
            )}

            {dados.pode_editar && rodando && (
              <div className="flex flex-wrap items-center gap-3">
                {/* Parada pela camada ou sem roteador, não há o que comparar antes
                    de decidir; e o clima sem a IA de sempre já decide sozinho. */}
                {tarefa.estado === "observando" && !parada(tarefa) && !climaSozinho && podeDecidir(tarefa.id) && (
                  <Button
                    size="sm"
                    disabled={enviando}
                    onClick={() => aoPedirDecidir(tarefa)}
                  >
                    {avisa ? t("Avisar a equipe") : t("Deixar o Jev decidir")}
                  </Button>
                )}
                {/* Sem este caminho, quem deixou o Jev decidir só voltaria a
                    comparar desligando — e religar mantém o estado gravado. */}
                {tarefa.estado === "decidindo" && !climaSozinho && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() =>
                      void mudar(corpoDaMudanca(tarefa, "observando"), t("O Jev voltou a só observar."))
                    }
                  >
                    {t("Voltar a só observar")}
                  </Button>
                )}
                {/* Grava o estado que já vale: o selo "Nova" sai, e nada muda.
                    Parada, ela não observa nada — o botão prometeria o contrário. */}
                {tarefa.novo && tarefa.estado === "observando" && !parada(tarefa) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() =>
                      void mudar(
                        { tarefa: tarefa.id, estado: "observando" },
                        t("A tarefa segue só observando."),
                      )
                    }
                  >
                    {t("Manter só observando")}
                  </Button>
                )}
                {/* Uma tarefa só, sem desligar o Jev: a tarefa nova começa
                    observando sozinha (R7), e quem não a quer precisa de uma
                    saída que não leve as outras junto. */}
                {tarefa.estado !== "desligada" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={enviando}
                    onClick={() => void mudar(corpoDaMudanca(tarefa, "desligada"), t("A tarefa foi pausada."))}
                  >
                    {t("Pausar esta tarefa")}
                  </Button>
                )}
                {/* Pausada, a tarefa volta observando — nunca direto a decidir.
                    A exceção é o clima sem a IA de sempre: não há com quem
                    comparar, e o worker o deixa decidir sozinho (DEC-012 #5). O
                    aviso vem ANTES do clique. */}
                {tarefa.estado === "desligada" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() => void mudar(corpoDaMudanca(tarefa, "observando"), t("A tarefa foi religada."))}
                  >
                    {t("Religar")}
                  </Button>
                )}
              </div>
            )}
            {tarefa.id === "roteador" && tarefa.estado === "decidindo" && rodando && (
              <div className="mt-2 space-y-1 text-xs" data-testid="jev-modo-roteador">
                <label htmlFor="jev-router-mode" className="block font-medium">{t("Como o roteador consulta as IAs")}</label>
                <Escolha id="jev-router-mode" className="block rounded-md border bg-background p-2 text-sm"
                  value={roteadorSobDemanda(dados) ? "sob_demanda" : "comparacao"} disabled={!dados.pode_editar || enviando}
                  onValueChange={(valor) => void mudar({ modo_roteador: valor }, t("Modo do roteador salvo."))}>
                  <option value="comparacao">{t("Comparar o Jev e a IA de sempre")}</option>
                  <option value="sob_demanda" disabled={dados.roteador_tem_ia_de_sempre !== true}>{t("Jev; IA de sempre só como reserva")}</option>
                </Escolha>
                {dados.roteador_tem_ia_de_sempre !== true ? (
                  <p className="text-muted-foreground" data-testid="jev-modo-roteador-sem-ia">{t(ROTEADOR_SOB_DEMANDA_SEM_IA)}</p>
                ) : (
                  <p className="text-muted-foreground">{roteadorSobDemanda(dados)
                    ? t("A IA de sempre só é chamada se o Jev falhar ou estiver inseguro.")
                    : t("As duas IAs respondem; a escolha do Jev decide.")}</p>
                )}
                <Link href="/app/ai/runs?tab=roteamento" className="underline underline-offset-4">{t("Ver resultados do roteamento")}</Link>
              </div>
            )}
            {dados.pode_editar && rodando && tarefa.estado === "desligada" && climaSemIa && (
              <p className="text-xs text-muted-foreground" data-testid="jev-religar-clima-sozinho">
                {t(
                  "Sem uma IA principal, o clima religado volta decidindo sozinho: não há com quem comparar nem quem cubra uma falha do Jev.",
                )}
              </p>
            )}
          </li>
  );
}
