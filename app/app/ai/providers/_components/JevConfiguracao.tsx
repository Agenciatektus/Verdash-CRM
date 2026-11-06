"use client";

import Link from "next/link";
import { useContext, useState } from "react";
import { toast } from "sonner";
import { AddCredentialDialog } from "@/app/app/ai/credentials/_components/AddCredentialDialog";
import { Button } from "@/components/ui/button";
import { Escolha } from "@/components/ui/escolha";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";

import { AceiteDoPadrao, corpoComAceiteDoPadrao, DadosDoJev, parada, roda, estadoAoLigar, tarefasDoCartao, avisaAEquipe, podeDecidir, decide, fraseObservando, origemDoCartao, provedorDaCredencialDoCartao } from "./jev-dados";

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

/** Um PATCH na rota do Jev, com o aviso de volta e a releitura do cartão. */
export function useMudarOJev(recarregar: () => Promise<void>) {
  const t = useT();
  const [enviando, setEnviando] = useState(false);

  const aceiteDoPadrao = useContext(AceiteDoPadrao);

  async function mudar(corpoPedido: Record<string, unknown>, sucesso: string) {
    // Empresa no padrão da plataforma: qualquer mudança (menos desligar) é ela
    // assumindo o Jev, e a rota exige o aceite real. Sem o checkbox marcado, nada sai.
    const corpo = corpoComAceiteDoPadrao(corpoPedido, aceiteDoPadrao);
    if (corpo === null) {
      toast.error(t("Marque o aceite do envio das mensagens à TypeSafe AI antes de mudar o Jev."));
      return;
    }
    setEnviando(true);
    try {
      const res = await fetch("/api/v1/ai/jev", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        // A recusa da rota já vem escrita para leigo e no idioma de quem pediu.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      toast.success(sucesso);
      await recarregar();
    } catch {
      toast.error(t("não consegui falar com o servidor"));
    } finally {
      setEnviando(false);
    }
  }

  return { mudar, enviando };
}

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
