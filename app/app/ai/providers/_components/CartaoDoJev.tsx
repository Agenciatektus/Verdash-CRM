"use client";

/**
 * O cartão "Jev — decisões rápidas", no painel de provedores.
 *
 * O Jev não conversa com o cliente — só decide coisas pequenas, e hoje só uma:
 * se o cliente está irritado. Por isso ele não aparece no "Modelo padrão" nem
 * no seletor de cada ponto (escolhido ali, todo atendimento morreria), e ganha
 * este cartão, que leva quem nunca ouviu falar dele da chave até os números:
 * pegar a chave, colar, testar, concordar com o envio para fora do país, ligar,
 * comparar com a IA de sempre e, só então, deixá-lo decidir.
 *
 * Os dados vêm de `GET /api/v1/ai/jev`; o estado mostrado é derivado deles, e
 * nunca guardado aqui, para a tela não discordar da rota que o worker obedece.
 *
 * Ligado, ele lista as TAREFAS (`lib/ai/decisao/tarefas.ts`), cada uma com o
 * seu estado e o seu "Deixar o Jev decidir": deixar decidir o clima não é
 * deixar decidir a tarefa seguinte.
 */
import { useState } from "react";
import { Aviso } from "@/components/ui/aviso";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";

import { AceiteDoPadrao, type DadosDoJev, type Estado, estadoDoJev, decideEmParte, origemDoCartao } from "./jev-dados";
import { ProntoParaLigar } from "./JevConfiguracao";
import { DeOndeResponde, SemChave, ProblemaDaChave } from "./JevChave";
import { Ligado } from "./JevTarefas";

export function CartaoDoJev({
  dados,
  erro,
  recarregar,
}: {
  dados: DadosDoJev | null;
  erro: string | null;
  recarregar: () => Promise<void>;
}) {
  const t = useT();
  const [aceitoNoPadrao, setAceitoNoPadrao] = useState(false);

  if (erro) {
    return (
      <Card className="border-destructive/40 p-4" data-testid="cartao-do-jev">
        <h2 className="text-base font-semibold">{t("Não consegui carregar o cartão do Jev")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{erro}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => void recarregar()}>
          {t("Tentar de novo")}
        </Button>
      </Card>
    );
  }
  // Sem esqueleto: o cartão entra pronto, e o resto do painel não espera por ele.
  if (!dados) return null;

  const estado = estadoDoJev(dados);
  const ligado = dados.config.ligado;
  const noPadrao = dados.config.no_padrao === true;

  return (
    <AceiteDoPadrao.Provider value={{ exigido: noPadrao, dado: aceitoNoPadrao }}>
    <Card className="p-4" data-testid="cartao-do-jev" data-estado={estado}>
      {/* No celular o selo desce para baixo do título e a descrição ocupa a
          largura toda: lado a lado, o selo espremia o texto numa coluna
          estreita (medido a 375 px). Do `sm` para cima, selo à direita. */}
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        <h2 className="text-base font-semibold">{t("Jev — decisões rápidas")}</h2>
        <div className="sm:col-start-2 sm:row-start-1">
          <SeloDoEstado estado={estado} emParte={estado === "decidindo" && decideEmParte(dados)} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground sm:col-span-2">{t(dados.provedor.quandoUsar)}</p>
      </div>

      {/* DEC-012 #2: quem é da área da saúde manda dado sensível (LGPD), e o
          contrato da TypeSafe precisa cobrir isso. O produto não guarda o nicho
          como categoria, então o aviso aparece para todos em forma condicional.
          A ida para os EUA já está no consentimento, mais abaixo. */}
      <Aviso tom="warn" className="mt-3">
        <span data-testid="jev-aviso-area-saude">
          {t(
          "Se a sua empresa é da área da saúde: as mensagens que o Jev lê podem conter dado de saúde, que a LGPD trata como sensível. Antes de ligar, confira com quem cuida da LGPD da empresa se o contrato da TypeSafe cobre esse tipo de dado.",
        )}
        </span>
      </Aviso>

      {/* Depois de colar a chave nada confirmava que ela FUNCIONA: esta linha é
          o resultado do teste, dito em palavras (o ✓ é enfeite). O nome do
          provedor acompanha a origem: via OpenRouter, quem conferiu foi a
          OpenRouter, e a chave é a mesma da conversa. */}
      {dados.chave.fonte_da_chave === "plataforma" && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="jev-da-plataforma">
          {t("Usando o Jev da plataforma. As mensagens processadas pelo Jev são enviadas à TypeSafe AI, nos Estados Unidos, pela conta da Tektus. Cadastre a sua chave para usar a sua conta.")}
        </p>
      )}
      {/* A chave própria foi recusada e a plataforma atende: o erro dela não pode
          sumir só porque o Jev segue funcionando. */}
      {dados.chave.fonte_da_chave === "plataforma" && dados.chave.erro_de_validacao && (
        <p className="mt-2 text-xs text-warning-fg" data-testid="jev-chave-propria-recusada">
          {t("Sua chave foi recusada pela TypeSafe:")}{" "}
          {t(descreverErroDeValidacao(dados.chave.erro_de_validacao, PROVEDOR_DO_JEV).frase) ||
            t("não consegui testar a chave.")}{" "}
          {t("Enquanto isso, a plataforma atende.")}
        </p>
      )}
      {dados.chave.validada && dados.chave.fonte_da_chave !== "plataforma" && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-success-fg" data-testid="jev-chave-conferida">
          <span aria-hidden>✓</span>
          {origemDoCartao(dados) === "openrouter"
            ? t("Chave conferida na OpenRouter")
            : t("Chave conferida com a TypeSafe")}
        </p>
      )}

      {/* Ligado pelo padrão da plataforma, ninguém aceitou ainda: antes de mudar
          qualquer coisa, o aceite de verdade (o mesmo texto de ligar). Desligar não pede. */}
      {noPadrao && dados.pode_editar && (
        <div className="mt-3 rounded-md border border-border p-3 text-sm" data-testid="jev-aceite-do-padrao">
          <p>
            {t(
              "Cada mensagem que o cliente manda vai para a TypeSafe AI, nos Estados Unidos, uma de cada vez e sem o resto da conversa, para o Jev avaliar. Antes de sair, o sistema apaga CPF, telefone e e-mail do texto. Para mudar qualquer ajuste do Jev, confirme o aceite abaixo. Desligar não pede aceite.",
            )}
          </p>
          <div className="mt-3 flex items-start gap-2">
            <input
              id="jev-aceite-do-padrao"
              type="checkbox"
              className="mt-0.5"
              checked={aceitoNoPadrao}
              onChange={(e) => setAceitoNoPadrao(e.target.checked)}
            />
            <label htmlFor="jev-aceite-do-padrao" className="text-sm">
              {t(
                "Concordo com o envio de cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, nos Estados Unidos.",
              )}
            </label>
          </div>
        </div>
      )}

      <DeOndeResponde dados={dados} recarregar={recarregar} />

      {estado === "sem_chave" && <SemChave dados={dados} recarregar={recarregar} />}

      {/* Também com o Jev ligado: chave girada para uma que não passa, ou
          desativada, deixa-o mudo, e é aqui que a pessoa descobre por quê. */}
      {!dados.chave.validada && (dados.chave.existe || ligado) && (
        <ProblemaDaChave dados={dados} recarregar={recarregar} />
      )}

      {estado === "pronto" && <ProntoParaLigar dados={dados} recarregar={recarregar} />}

      {/* A falta da IA principal NÃO é avisada aqui: o topo da página já a
          avisa, e a linha de estado ("Decidindo sozinho — …") explica o efeito
          no Jev. Repetida dentro do cartão, com o Jev funcionando, lia-se como
          erro dele. */}

      {ligado && <Ligado dados={dados} estado={estado} recarregar={recarregar} />}

      {!dados.pode_editar && estado !== "sem_chave" && (
        <p className="mt-3 text-xs text-muted-foreground">{t("Só quem administra a empresa pode mudar o Jev.")}</p>
      )}
    </Card>
    </AceiteDoPadrao.Provider>
  );
}

function SeloDoEstado({ estado, emParte }: { estado: Estado; emParte: boolean }) {
  const t = useT();
  if (estado === "observando") return <Badge variant="info">{t("Observando")}</Badge>;
  if (estado === "decidindo") return <Badge variant="success">{emParte ? t("Decide em parte") : t("Decidindo")}</Badge>;
  if (estado === "sozinho") return <Badge variant="warning">{t("Decidindo sozinho")}</Badge>;
  if (estado === "parado") return <Badge variant="warning">{t("Parado")}</Badge>;
  if (estado === "em_pausa") return <Badge variant="neutral">{t("Em pausa")}</Badge>;
  return <Badge variant="neutral">{t("Desligado")}</Badge>;
}

// Os testes e o cartão do ponto importam daqui desde antes de o arquivo ser dividido.
export { corpoComAceiteDoPadrao, jevNoPonto, useDadosDoJev, type DadosDoJev } from "./jev-dados";
