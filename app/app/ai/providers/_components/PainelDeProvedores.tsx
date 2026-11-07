"use client";

/**
 * O painel de provedores de IA.
 *
 * ## A decisão de desenho que manda em tudo aqui
 *
 * São 23 pontos configuráveis. Mostrar 23 seletores de uma vez transformaria a
 * tela num painel de avião para alguém que não é engenheiro — e o resultado
 * previsível seria ninguém tocar em nada, o que devolve o problema original.
 *
 * Então a tela abre agrupada por PAPEL ("Atender o cliente", "Entender a
 * conversa"…), mostrando o que cada grupo usa hoje. Quem quiser precisão
 * abre "Configuração avançada" e escolhe ponto a ponto. O agrupamento é só de
 * exibição: o que se grava é sempre por ponto, porque o roteiro do produto
 * prevê modelo local, e modelo local pequeno só é confiável como especialista
 * de uma tarefa só.
 *
 * ## Por que cada cartão mostra "o que acontece se falhar"
 *
 * A pergunta que trouxe esta tela à existência não foi "qual modelo está aqui",
 * foi "por que isso falhou e eu não vi". Um painel que só lista provedor e
 * modelo responde a primeira e deixa a segunda de pé. Por isso cada ponto
 * carrega o sintoma em português de gente — é o que liga uma linha de
 * configuração a algo que a pessoa já viu acontecer no negócio dela.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { CabecalhoDaPagina, Pagina } from "@/components/pagina";
import { Aviso } from "@/components/ui/aviso";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

import { CartaoDeMapas } from "./CartaoDeMapas";
import { CartaoDoJev, useDadosDoJev } from "./CartaoDoJev";
import { CartaoDoPadrao } from "./CartaoDoPadrao";
import { CartaoDeVoz } from "./CartaoDeVoz";
import { ListaDeGrupos } from "./ListaDeGrupos";
import type { Dados, Ponto } from "./tipos";

export function PainelDeProvedores({ antesDosPontos }: { antesDosPontos?: ReactNode } = {}) {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const jev = useDadosDoJev();

  const carregar = useCallback(async () => {
    // O try/catch não é zelo genérico: sem ele, qualquer exceção (rede caindo,
    // resposta que não é JSON, erro 500 com corpo HTML) deixava a tela presa em
    // "Carregando…" PARA SEMPRE, sem nada explicando. Medido na primeira
    // execução do e2e desta tela — que é a mesma falha muda que este painel
    // veio acabar, recriada dentro dele.
    try {
      const res = await fetch("/api/v1/ai/providers");
      const texto = await res.text();
      type Resposta = { data?: unknown; error?: { message?: string } };
      let json: Resposta | null = null;
      try {
        json = JSON.parse(texto) as Resposta;
      } catch {
        // Corpo não-JSON quer dizer que a resposta nem chegou ao handler
        // (proxy, erro de runtime). O começo do corpo é o que há de mais
        // informativo, então ele vai para a tela em vez de sumir no console.
        setErro(`${t("resposta inesperada do servidor")} (${res.status}): ${texto.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setErro(
          json?.error?.message
            ? t(json.error.message)
            : `${t("não consegui carregar a configuração")} (${res.status})`,
        );
        return;
      }
      setErro(null);
      setDados(json?.data as Dados);
    } catch {
      // A mensagem do navegador ("Failed to fetch") é inglês e não diz nada.
      setErro(t("não consegui falar com o servidor"));
    }
  }, [t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const porPapel = useMemo(() => {
    if (!dados) return [];
    const grupos = new Map<string, Ponto[]>();
    for (const p of dados.pontos) {
      grupos.set(p.papel, [...(grupos.get(p.papel) ?? []), p]);
    }
    return [...grupos.entries()].map(([papel, pontos]) => ({
      papel,
      info: dados.papeis[papel] ?? { rotulo: papel, explicacao: "" },
      pontos,
    }));
  }, [dados]);

  if (erro) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40 p-6">
          <h2 className="font-medium">{t("Não consegui carregar a configuração de IA")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{erro}</p>
          <Button className="mt-4" variant="outline" onClick={() => void carregar()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      </div>
    );
  }

  if (!dados) {
    return <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>;
  }

  const semChave = dados.credenciais.length === 0;

  return (
    <Pagina testId="painel-de-provedores" largura="leitura">
      <CabecalhoDaPagina
        titulo={t("Provedores de IA")}
        descricao={
          <>
            {t("Seu sistema usa inteligência artificial em")} {dados.pontos.length}{" "}
            {t("lugares diferentes. Aqui você vê qual está atendendo cada um — e troca, se quiser.")}
          </>
        }
      />
      {/* Molde Leitura: cada filho direto para em 768px; o `mb:px-4` é o respiro do celular. */}
      <div className="flex flex-col gap-5 mb:px-4">
        {semChave && (
          <div data-testid="aviso-sem-chave">
          <Aviso
            tom="warn"
            acao={
              <Link className="underline underline-offset-4" href="/app/ai/credentials">
                {t("Cadastrar uma chave")}
              </Link>
            }
          >
            {t("Você ainda não cadastrou a chave da sua IA principal, a que conversa com os clientes.")}{" "}
            {/* Só é verdade quando a instalação tem chave; sem ela, a frase
                contradizia o cartão do Jev logo abaixo. */}
            {dados.instalacaoTemChave && t("Enquanto isso, o atendimento usa a chave que veio na instalação.")}
          </Aviso>
          </div>
        )}

        <CartaoDoPadrao dados={dados} aoSalvar={carregar} midia={antesDosPontos} />
        <CartaoDeVoz podeEditar={dados.podeEditar} />

        <ListaDeGrupos grupos={porPapel} dados={dados} jev={jev.dados} aoSalvar={carregar} />

        <CartaoDoJev dados={jev.dados} erro={jev.erro} recarregar={jev.recarregar} />

        <CartaoDeMapas />
      </div>
    </Pagina>
  );
}
