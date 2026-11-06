"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AddCredentialDialog } from "@/app/app/ai/credentials/_components/AddCredentialDialog";
import { Button } from "@/components/ui/button";
import { Escolha } from "@/components/ui/escolha";
import { useT } from "@/hooks/i18n/useT";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { DadosDoJev, roda, origemDoCartao, provedorDaCredencialDoCartao } from "./jev-dados";
import { useMudarOJev } from "./JevMudar";

/**
 * DE ONDE O JEV RESPONDE (`lib/ai/decisao/origem`).
 *
 * O Jev é o mesmo modelo nos dois caminhos, e o que muda é o ENDEREÇO, o NOME do
 * modelo e a CHAVE: a TypeSafe direto, com uma chave só para ele, ou via
 * OpenRouter, reaproveitando a credencial OpenRouter que a empresa já cadastrou
 * para a conversa — sem segunda conta e sem segunda chave (issue #2947).
 *
 * A troca é um PATCH com `origem`, e a rota só a aceita com a credencial da
 * origem nova já validada: sem isto, trocar para OpenRouter numa empresa sem
 * chave de lá deixaria o Jev mudo. A recusa da rota já vem escrita para leigo, e
 * é ela que explica o que falta.
 */
export function DeOndeResponde({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const { mudar, enviando } = useMudarOJev(recarregar);
  const origem = origemDoCartao(dados);
  const podeReaproveitar = dados.openrouter?.disponivel === true;
  // O aceite gravado nomeava só a TypeSafe AI: ir para a OpenRouter pede o
  // aceite de novo antes do PATCH (a rota recusa sem ele).
  const [confirmandoOpenRouter, setConfirmandoOpenRouter] = useState(false);
  const [concordo, setConcordo] = useState(false);
  const escolher = (nova: string) => {
    if (nova === "openrouter" && dados.config.aceite !== null) {
      setConcordo(false);
      setConfirmandoOpenRouter(true);
      return;
    }
    setConfirmandoOpenRouter(false);
    void mudar({ origem: nova }, t("Origem do Jev salva."));
  };

  return (
    <div className="mt-4 space-y-1" data-testid="jev-origem">
      <label htmlFor="jev-origem-escolha" className="block text-xs font-medium">
        {t("De onde o Jev responde")}
      </label>
      <Escolha
        id="jev-origem-escolha"
        className="w-full max-w-md"
        value={confirmandoOpenRouter ? "openrouter" : origem}
        disabled={!dados.pode_editar || enviando}
        onValueChange={(v) => escolher(v)}
      >
        <option value="typesafe">{t("TypeSafe AI (chave própria)")}</option>
        <option value="openrouter">{t("OpenRouter (reaproveita a credencial OpenRouter)")}</option>
      </Escolha>
      {confirmandoOpenRouter && (
        <div className="rounded-md border border-border p-3 text-sm" data-testid="jev-origem-aceite">
          <div className="flex items-start gap-2">
            <input
              id="jev-origem-aceite"
              type="checkbox"
              className="mt-0.5"
              checked={concordo}
              onChange={(e) => setConcordo(e.target.checked)}
            />
            <label htmlFor="jev-origem-aceite" className="text-sm">
              {t(
                "Concordo com o envio de cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, pela OpenRouter, nos Estados Unidos.",
              )}
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!concordo || enviando}
              onClick={() => {
                setConfirmandoOpenRouter(false);
                void mudar({ origem: "openrouter", aceite_lgpd: true }, t("Origem do Jev salva."));
              }}
            >
              {t("Trocar para a OpenRouter")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmandoOpenRouter(false)}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      )}
      {origem === "openrouter" ? (
        <p className="text-xs text-muted-foreground" data-testid="jev-origem-openrouter">
          {podeReaproveitar
            ? t(
                "O Jev responde pela OpenRouter usando a credencial OpenRouter desta empresa — a mesma chave da conversa, sem segunda conta e sem segunda chave.",
              )
            : t(
                "Para o Jev responder pela OpenRouter, cadastre a chave da OpenRouter em Credenciais. É a mesma chave que a sua IA de conversa usa.",
              )}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="jev-origem-typesafe">
          {t("O Jev responde direto na TypeSafe AI, com a chave dele cadastrada em Credenciais.")}
        </p>
      )}
      {podeReaproveitar && origem === "typesafe" && (
        <p className="text-xs text-muted-foreground" data-testid="jev-origem-pode-reaproveitar">
          {t("Esta empresa já tem uma credencial OpenRouter conferida: dá para o Jev usá-la sem cadastrar chave nova.")}
        </p>
      )}
    </div>
  );
}

export function SemChave({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const [colando, setColando] = useState(false);
  const pelaOpenRouter = origemDoCartao(dados) === "openrouter";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button asChild size="sm" variant="outline">
        <a href={dados.provedor.ondePegarAChave} target="_blank" rel="noreferrer">
          {pelaOpenRouter ? t("Pegar a chave na OpenRouter") : t("Pegar a chave na TypeSafe")}
        </a>
      </Button>
      {dados.pode_editar ? (
        <>
          <Button size="sm" onClick={() => setColando(true)}>
            {t("Colar a chave")}
          </Button>
          <AddCredentialDialog
            open={colando}
            onOpenChange={setColando}
            providerInicial={provedorDaCredencialDoCartao(dados)}
            aoSalvar={() => {
              void recarregar();
              // O teste da chave roda depois da resposta (ver a rota de criar), com
              // teto de 5 s: as releituras pegam o resultado sem a pessoa
              // recarregar a tela, até no teste mais lento.
              setTimeout(() => void recarregar(), 3000);
              setTimeout(() => void recarregar(), 8000);
            }}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("Só quem administra a empresa pode colar a chave e ligar o Jev.")}
        </p>
      )}
      {/* O Jev é pago à parte, numa conta da TypeSafe: sem esta frase a pessoa
          só descobria o crédito pela falha. Via OpenRouter, quem cobra é a
          OpenRouter, pela chave que a empresa já tem — e a frase muda. */}
      <p className="w-full text-xs text-muted-foreground" data-testid="jev-como-pegar-a-chave">
        {pelaOpenRouter ? (
          t(
            "Não precisa de uma segunda conta: o Jev via OpenRouter usa a credencial OpenRouter desta empresa, e quem cobra o uso é a própria OpenRouter. A chave começa com",
          )
        ) : (
          t(
            "Para pegar a chave, você cria uma conta na TypeSafe AI e põe crédito: cada mensagem medida custa uma fração de centavo de dólar, cobrada lá. A chave começa com",
          )
        )}{" "}
        <span className="font-mono">{dados.provedor.prefixoDaChave}</span>
      </p>
    </div>
  );
}

export function ProblemaDaChave({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const [testando, setTestando] = useState(false);
  // O nome na frase de recusa acompanha a origem: via OpenRouter, quem recusou
  // foi a OpenRouter (issue #2947) — dizer "a TypeSafe recusou" à chave errada
  // mandaria a pessoa conferir a conta errada.
  const pelaOpenRouter = origemDoCartao(dados) === "openrouter";
  const erro = descreverErroDeValidacao(dados.chave.erro_de_validacao, provedorDaCredencialDoCartao(dados));
  const motivo = !dados.chave.existe
    ? t("O Jev está ligado, mas sem chave ativa: enquanto isso, ele não mede nada.")
    : !dados.chave.erro_de_validacao
      ? dados.pode_editar
        ? t("A chave está sendo testada. Se esta mensagem não sumir em alguns segundos, clique em “Testar de novo”.")
        : t("A chave está sendo testada. Se esta mensagem não sumir em alguns segundos, recarregue a página.")
      : erro.generico
        ? t("Não consegui testar a chave. Tente de novo em instantes.")
        : t(erro.frase);

  async function testar() {
    setTestando(true);
    try {
      const res = await fetch(`/api/v1/ai/credentials/${dados.chave.credencial_id}/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { validated_at: string | null };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        toast.error(
          json?.error?.message
            ? t(json.error.message)
            : t("Não consegui testar a chave agora. Tente de novo em instantes."),
        );
      }
      else if (json?.data?.validated_at) toast.success(t("A chave passou no teste."));
      else toast.error(t("A chave não passou no teste."));
      await recarregar();
    } catch {
      toast.error(t("não consegui falar com o servidor"));
    } finally {
      setTestando(false);
    }
  }

  return (
    <div className="mt-4 rounded-md bg-warning-bg p-3 text-sm text-warning-fg" data-testid="jev-chave">
      {/* O código cru fica no `title`, para quem for investigar — nunca na frase. */}
      <p title={dados.chave.erro_de_validacao ?? undefined}>{motivo}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {dados.pode_editar && dados.chave.credencial_id && (
          <Button size="sm" variant="outline" disabled={testando} onClick={() => void testar()}>
            {testando ? t("Testando…") : t("Testar de novo")}
          </Button>
        )}
        {/* "Gere uma nova" precisa de caminho: a chave recusada leva ao provedor
            DA ORIGEM — via OpenRouter, à OpenRouter. */}
        {erro.chaveErrada && (
          <a
            className="text-xs underline underline-offset-4"
            href={dados.provedor.ondePegarAChave}
            target="_blank"
            rel="noreferrer"
          >
            {pelaOpenRouter ? t("Pegar uma chave nova na OpenRouter") : t("Pegar uma chave nova na TypeSafe")}
          </a>
        )}
        <Link className="text-xs underline underline-offset-4" href="/app/ai/credentials">
          {t("Trocar a chave em Credenciais")}
        </Link>
      </div>
    </div>
  );
}
