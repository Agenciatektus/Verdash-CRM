"use client";
/**
 * Criar campanha (PRD §8).
 *
 * ═══ Por que SEÇÕES e não um wizard de cinco passos ═══
 *
 * O PRD recomenda o wizard; a ordem das perguntas aqui é a mesma dele
 * (Informações → Público → Mensagem → Entrega), mas numa página só. O wizard
 * acrescentaria estado de passo, navegação entre passos e rascunho parcial
 * gravado a cada etapa — máquina para um formulário que cabe numa tela. O que
 * ele daria de útil, que é não deixar apertar "enviar" antes de conferir, já
 * existe: criar uma campanha cria um RASCUNHO, e preparar/testar/iniciar são
 * ações da tela de detalhe, cada uma com sua confirmação.
 *
 * A prévia do público fica ao lado do filtro, e não depois: o número que o
 * operador precisa ver antes de apertar é "quantas pessoas isto pega".
 */
import { CabecalhoDaPagina, Pagina, SecaoDaPagina } from "@/components/pagina";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AvisoDeRitmo } from "@/components/campanhas/AvisoDeRitmo";
import { EntradaDaCampanha } from "@/components/campanhas/EntradaDaCampanha";
import { MensagemDaCampanha } from "@/components/campanhas/MensagemDaCampanha";
import { PassosDaCampanha } from "@/components/campanhas/PassosDaCampanha";
import { SaidasDaCampanhaEditor, saidasDaTela } from "@/components/campanhas/SaidasDaCampanha";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Escolha } from "@/components/ui/escolha";
import {
  useCriarCampanha,
  useModelosDaCampanha,
  usePreviaDaAudiencia,
} from "@/hooks/campanhas/useCampanhas";
import { useConfiguracaoDeCampanhas } from "@/hooks/campanhas/useConfiguracao";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import type { SaidasDaCadencia } from "@/lib/cadencia/saidas";
import {
  COMPRA_VAZIA,
  CamposDeCompraDoFiltro,
  compraDoFiltro,
  criteriosDeCompra,
  excluirDoFiltro,
  temCriterioDeCompra,
} from "../_campos-de-compra";
import { ritmoDaCampanhaNova } from "@/lib/campanhas/ritmo-recomendado";
import { minutosParaSegundos, segundosParaMinutos } from "@/lib/campanhas/unidades";
import type { PassoDaRegua } from "@/lib/regua/timeline";
import {
  useAgentesPublicados,
  useEtapas,
  useFunis,
} from "@/hooks/campanhas/useDestinoDaCampanha";

import {
  ModeloDaCampanha,
  variaveisIncompletas,
  type EscolhaDoModelo,
} from "../_components/ModeloDaCampanha";
import { VelocidadeDaCampanha, type Velocidade } from "../_components/VelocidadeDaCampanha";

export function NovaCampanha() {
  const t = useT();
  const router = useRouter();
  const canais = useChannelSessions();
  const criar = useCriarCampanha();
  const previa = usePreviaDaAudiencia();

  const [nome, setNome] = useState("");
  const [canal, setCanal] = useState("");
  const [baseLegal, setBaseLegal] = useState<"consent" | "legitimate_interest">("consent");
  const [liaRef, setLiaRef] = useState("");
  const [comAlgumaTag, setComAlgumaTag] = useState("");
  const [semTags, setSemTags] = useState("");
  const [semInteracao, setSemInteracao] = useState("");
  const [compra, setCompra] = useState(COMPRA_VAZIA);
  const [excluirCompra, setExcluirCompra] = useState(COMPRA_VAZIA);
  const [limite, setLimite] = useState("100");
  // `variantes[0]` é o `message_body`; as demais são as EXTRAS (migration 9034).
  const [variantes, setVariantes] = useState<string[]>([""]);
  // A régua do 2º toque em diante (9037). Vazia = campanha de uma mensagem só.
  const [passos, setPassos] = useState<PassoDaRegua[]>([]);
  // QUANDO A RÉGUA PARA (9046). Nasce no padrão, que é o que o servidor usa
  // quando a coluna é nula: a campanha nova se comporta como as de antes até
  // alguém mexer aqui.
  const [saidas, setSaidas] = useState<SaidasDaCadencia>(() => saidasDaTela(null));
  // ⚠️ SE A SEÇÃO FOI MEXIDA, e não "qual é o valor dela" (parecer do
  // @Cassio_SecRev, P2.1). Sem este flag a tela mandava `saidas` SEMPRE — já
  // preenchida com o objeto do padrão —, então o `?? null` da rota nunca
  // produzia nulo e toda campanha nova gravava o padrão. A coluna existe
  // nulável justamente para distinguir "o operador escolheu" de "herdou", e a
  // distinção morria aqui, calada, contra o que a migration e o MANIFEST
  // afirmam. Enquanto ninguém encostar, vai `null`.
  const [saidasMexidas, setSaidasMexidas] = useState(false);
  const texto = variantes[0] ?? "";
  const variacoesExtras = useMemo(
    () => variantes.slice(1).map((v) => v.trim()).filter((v) => v !== ""),
    [variantes],
  );
  // ═══ O RITMO JÁ VEM PREENCHIDO (preset anti-bloqueio) ═══
  //
  // Abre vazio e é PREENCHIDO quando a configuração da organização chega
  // (`ritmoDaCampanhaNova`: o que a organização definiu, e o recomendado onde
  // ela não definiu nada). Começar vazio em vez de já com o recomendado evita o
  // caso em que a configuração chega depois e sobrescreve o que o operador
  // digitou enquanto ela carregava — o `preenchido` fecha essa porta de vez.
  //
  // ⚠️ Só aqui. A edição e a tela de detalhe continuam lendo o ritmo da
  // campanha como ele está gravado: preencher lá mudaria em silêncio a escolha
  // de quem criou o rascunho.
  const [intervalo, setIntervalo] = useState("");
  const [janelaInicio, setJanelaInicio] = useState("");
  const [janelaFim, setJanelaFim] = useState("");
  const [tetoDiario, setTetoDiario] = useState("");
  const [tetoHorario, setTetoHorario] = useState("");
  const [preenchido, setPreenchido] = useState(false);
  const [extras, setExtras] = useState<string[]>([]);
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");
  const [funilDoPublico, setFunilDoPublico] = useState("");
  const [etapaDoPublico, setEtapaDoPublico] = useState("");
  // O MODO DE PÚBLICO (9039). Nasce em LISTA, e nada aqui o liga sozinho.
  const [continua, setContinua] = useState(false);
  const [etapaDeEntrada, setEtapaDeEntrada] = useState("");

  const [modelo, setModelo] = useState<EscolhaDoModelo | null>(null);
  const [velocidade, setVelocidade] = useState<Velocidade>("gradual");

  // O que o número escolhido aceita: texto livre (QR) ou modelo aprovado
  // (oficial). Quem decide é o servidor, pela capability do canal.
  const doCanal = useModelosDaCampanha(canal);
  const ehOficial = doCanal.data?.modo === "template";
  // Rápida só no número oficial: trocar para um número por QR volta a gradual.
  const rapida = ehOficial && velocidade === "rapida";
  const providerDoCanal = (canais.data ?? []).find((c) => c.id === canal)?.provider ?? null;
  const modeloEscolhido =
    modelo && doCanal.data
      ? (doCanal.data.modelos.find(
          (m) => m.name === modelo.name && m.language === modelo.language,
        ) ?? null)
      : null;
  const modeloPronto =
    modelo !== null &&
    modeloEscolhido !== null &&
    variaveisIncompletas(modeloEscolhido, modelo.variables).length === 0;

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const etapasDoPublico = useEtapas(funilDoPublico || null);
  const agentes = useAgentesPublicados();

  const padroes = useConfiguracaoDeCampanhas();
  useEffect(() => {
    if (preenchido || padroes.isLoading) return;
    // Quem já digitou MANDA, e o preset desiste. A guarda sozinha era
    // `preenchido`, que só é marcado pelo próprio preenchimento: enquanto o GET
    // da configuração estava no ar nada impedia digitar, e na volta os cinco
    // `setX` rodavam sem condição. O operador que escrevesse 300 em Intervalo
    // via o campo virar 120 e salvava sem reler, e a campanha saía 2,5x mais
    // RÁPIDA que a escolha dele. Atropelar para o lado rápido é o único
    // desfecho que este módulo existe para impedir.
    if (intervalo || janelaInicio || janelaFim || tetoDiario || tetoHorario) {
      setPreenchido(true);
      return;
    }
    // Erro ao ler a configuração não deixa o formulário vazio: `data` ausente
    // cai no recomendado, que é o lado seguro. Ficar em branco por causa de uma
    // falha de rede devolveria ao operador exatamente o problema que o preset
    // existe para resolver.
    const r = ritmoDaCampanhaNova(padroes.data?.configuracao);
    setIntervalo(comoTexto(segundosParaMinutos(r.intervaloSegundos)));
    setJanelaInicio(comoTexto(r.janelaInicioHora));
    setJanelaFim(comoTexto(r.janelaFimHora));
    setTetoDiario(comoTexto(r.tetoDiario));
    setTetoHorario(comoTexto(r.tetoHorario));
    setPreenchido(true);
  }, [
    padroes.data,
    padroes.isLoading,
    preenchido,
    intervalo,
    janelaInicio,
    janelaFim,
    tetoDiario,
    tetoHorario,
  ]);

  const ritmoEscolhido = {
    intervaloSegundos: minutosParaSegundos(comoNumero(intervalo)),
    janelaInicioHora: comoNumero(janelaInicio),
    janelaFimHora: comoNumero(janelaFim),
    tetoDiario: comoNumero(tetoDiario),
    tetoHorario: comoNumero(tetoHorario),
  };

  const filtro = useMemo(
    () => ({
      com_alguma_tag: listar(comAlgumaTag),
      sem_tags: listar(semTags),
      sem_interacao_ha_dias: semInteracao ? Number(semInteracao) : null,
      funis: funilDoPublico ? [funilDoPublico] : [],
      etapas: etapaDoPublico ? [etapaDoPublico] : [],
      ...criteriosDeCompra(compra),
      excluir: excluirDoFiltro(excluirCompra),
      limite: Number(limite) || 100,
    }),
    [comAlgumaTag, semTags, semInteracao, funilDoPublico, etapaDoPublico, compra, excluirCompra, limite],
  );

  const temCriterio =
    filtro.com_alguma_tag.length > 0 ||
    filtro.sem_tags.length > 0 ||
    filtro.funis.length > 0 ||
    filtro.etapas.length > 0 ||
    filtro.sem_interacao_ha_dias !== null ||
    temCriterioDeCompra(criteriosDeCompra(compra));

  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    (ehOficial ? modeloPronto : texto.trim() !== "") &&
    // No modo CONTÍNUO o público é a etapa, e o recorte de contatos não é usado:
    // exigir critério ali prenderia o operador num filtro que a campanha ignora.
    // O que o contínuo exige (funil, etapa, teto, janela) é cobrado no Preparar,
    // porque um RASCUNHO pode estar incompleto — a mesma regra dos passos.
    (continua || temCriterio) &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  async function salvar() {
    const criada = await criar.mutateAsync({
      name: nome.trim(),
      channel_session_id: canal,
      ...(ehOficial && modelo
        ? {
            message_mode: "template",
            provider_template_name: modelo.name,
            provider_template_language: modelo.language,
            provider_template_variables: modelo.variables,
          }
        : { message_body: texto.trim(), message_variants: variacoesExtras }),
      base_legal: baseLegal,
      lia_ref: liaRef.trim() || null,
      audience_filter: filtro,
      // Na rápida o intervalo não vale (a rajada tem o próprio espaçamento).
      intervalo_segundos: rapida ? null : ritmoEscolhido.intervaloSegundos,
      velocidade: rapida ? "rapida" : "gradual",
      janela_inicio_hora: ritmoEscolhido.janelaInicioHora,
      janela_fim_hora: ritmoEscolhido.janelaFimHora,
      teto_diario: ritmoEscolhido.tetoDiario,
      teto_horario: ritmoEscolhido.tetoHorario,
      channel_session_ids: ehOficial ? [] : extras,
      pipeline_id: funil || null,
      stage_id: etapa || null,
      agent_id: agente || null,
      passos,
      saidas: saidasMexidas ? saidas : null,
      entrada_continua: continua,
      entrada_etapa_id: continua ? etapaDeEntrada || null : null,
    });
    router.push(`/app/campaigns/${criada.id}`);
  }

  return (
    <Pagina>
      <CabecalhoDaPagina
        titulo={t("Nova campanha")}
        descricao={t("Isto cria um rascunho. Nada é enviado antes de você preparar a lista e iniciar.")}
      />
      <SecaoDaPagina className="max-w-3xl gap-4">

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="nome">{t("Nome da campanha")}</Label>
          <Input
            id="nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t("Ex.: Reativação de clientes parados")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="canal">{t("Enviar pelo número")}</Label>
          <Escolha
            id="canal"
            className="h-9 w-full"
            value={canal}
            onValueChange={(valorEscolhido) => {
              setCanal(valorEscolhido);
              // Cada número tem os próprios modelos: o escolhido no outro não vale aqui.
              setModelo(null);
            }}
          >
            <option value="">{t("Escolha um número")}</option>
            {(canais.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {channelLabel(c, t)}
              </option>
            ))}
          </Escolha>
          {canais.data?.length === 0 && (
            <p className="text-sm text-warning-fg">
              {t("Nenhum número conectado. Conecte um em Conexões antes de criar a campanha.")}
            </p>
          )}
        </div>

        {ehOficial && (canais.data ?? []).length > 1 && (
          <p className="text-sm text-muted-foreground">
            {t(
              "Campanha com modelo aprovado sai por um número só: cada número tem os próprios modelos na plataforma.",
            )}
          </p>
        )}
        {!ehOficial && (canais.data ?? []).length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Falar também por estes números")}</legend>
            <p className="text-sm text-muted-foreground">
              {t(
                "A campanha reveza entre os números marcados, escolhendo a cada envio o que tem mais folga no teto do dia. Quem já conversa com você por um deles recebe por esse mesmo, para não chegar de um número desconhecido.",
              )}
            </p>
            {(canais.data ?? [])
              .filter((c) => c.id !== canal)
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extras.includes(c.id)}
                    onChange={(e) =>
                      setExtras((atual) =>
                        e.target.checked ? [...atual, c.id] : atual.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {channelLabel(c, t)}
                </label>
              ))}
            {extras.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Atenção: o intervalo e os tetos da CAMPANHA somam todos os números. Para o rodízio aumentar o volume, deixe o ritmo da campanha em branco e cada número usa o dele.",
                )}
              </p>
            )}
          </fieldset>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <p className="text-sm text-muted-foreground">
            {t(
              "Quem recebe pode perguntar por que recebeu, e a resposta precisa existir antes do envio.",
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="consent"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="legitimate_interest"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input
                id="lia"
                value={liaRef}
                onChange={(e) => setLiaRef(e.target.value)}
                placeholder={t("Ex.: LIA-2026-01")}
              />
            </div>
          )}
        </fieldset>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Público")}</h2>
        <EntradaDaCampanha
          continua={continua}
          onContinuaChange={setContinua}
          etapaId={etapaDeEntrada}
          onEtapaChange={setEtapaDeEntrada}
          etapas={etapas.data ?? []}
          temFunil={!!funil}
          tetoPorDia={tetoDiario ? Number(tetoDiario) : null}
          janelaInicio={janelaInicio === "" ? null : Number(janelaInicio)}
          janelaFim={janelaFim === "" ? null : Number(janelaFim)}
        />
        {/* O recorte de contatos só existe no modo LISTA: no contínuo o público
            é a etapa, e deixar o filtro à vista sugeriria que ele também vale —
            tela que oferece controle sem efeito é tela que ensina errado. */}
        {!continua && (
        <>
        <p className="text-sm text-muted-foreground">
          {t(
            "Escolha pelo menos um critério — uma lista sem recorte ninguém confere antes de apertar.",
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="com-tags">{t("Com alguma destas etiquetas")}</Label>
            <Input
              id="com-tags"
              value={comAlgumaTag}
              onChange={(e) => setComAlgumaTag(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sem-tags">{t("Sem nenhuma destas etiquetas")}</Label>
            <Input
              id="sem-tags"
              value={semTags}
              onChange={(e) => setSemTags(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="silencio">{t("Sem falar com a gente há (dias)")}</Label>
            <Input
              id="silencio"
              type="number"
              min={1}
              value={semInteracao}
              onChange={(e) => setSemInteracao(e.target.value)}
            />
          </div>
          <CamposDeCompraDoFiltro
            prefixo="silencio-compra"
            compra={compra}
            onCompra={setCompra}
            excluir={excluirCompra}
            onExcluir={setExcluirCompra}
          />
          <div className="space-y-2">
            <Label htmlFor="pub-funil">{t("Com negócio no funil")}</Label>
            <Escolha
              id="pub-funil"
              className="h-9 w-full"
              value={funilDoPublico}
              onValueChange={(valorEscolhido) => {
                setFunilDoPublico(valorEscolhido);
                setEtapaDoPublico("");
              }}
            >
              <option value="">{t("Qualquer um")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Escolha>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-etapa">{t("Na etapa")}</Label>
            <Escolha
              id="pub-etapa"
              className="h-9 w-full"
              value={etapaDoPublico}
              onValueChange={(valorEscolhido) => setEtapaDoPublico(valorEscolhido)}
              disabled={!funilDoPublico}
            >
              <option value="">{t("Qualquer etapa")}</option>
              {(etapasDoPublico.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Escolha>
          </div>
          <div className="space-y-2">
            <Label htmlFor="limite">{t("Máximo de contatos nesta campanha")}</Label>
            <Input
              id="limite"
              type="number"
              min={1}
              max={5000}
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!temCriterio || previa.isPending}
            onClick={() =>
              previa.mutate({
                audience_filter: filtro,
                message_body: ehOficial ? "" : texto,
                message_variants: ehOficial ? [] : variacoesExtras,
                ...(ehOficial && modelo
                  ? {
                      modelo: {
                        channel_session_id: canal,
                        name: modelo.name,
                        language: modelo.language,
                        variables: modelo.variables,
                      },
                    }
                  : {}),
              })
            }
          >
            {previa.isPending ? t("Contando…") : t("Ver quantas pessoas")}
          </Button>
          {previa.data && (
            <p className="text-sm">
              <strong>{previa.data.elegiveis}</strong> {t("podem receber")}
              {previa.data.excluidos > 0 ? ` · ${previa.data.excluidos} ${t("ficam de fora")}` : ""}
            </p>
          )}
        </div>
        {previa.data && previa.data.excluidos > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {Object.entries(previa.data.motivos).map(([motivo, quantos]) => (
              <li key={motivo}>
                {quantos} — {t(previa.data!.legenda[motivo] ?? motivo)}
              </li>
            ))}
          </ul>
        )}
        {previa.data?.truncado && (
          <p className="text-sm text-amber-600">
            {t(
              "O recorte bateu o teto de 20.000 negócios desta prévia — a lista pode estar incompleta. Refine o filtro para ver o todo.",
            )}
          </p>
        )}
        </>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Mensagem")}</h2>
        {ehOficial ? (
          <ModeloDaCampanha
            channelSessionId={canal}
            provider={providerDoCanal}
            valor={modelo}
            onChange={setModelo}
          />
        ) : (
          <MensagemDaCampanha variantes={variantes} onChange={setVariantes} />
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Passos depois da primeira mensagem")}</h2>
        <PassosDaCampanha
          passos={passos}
          onChange={setPassos}
          etapas={etapas.data ?? []}
          temFunil={!!funil}
          // O número de cards é o número de ELEGÍVEIS da prévia: o excluído não
          // recebe mensagem, logo não vira card. Sem prévia pedida ainda, a
          // frase do aviso fica sem número em vez de chutar um. No modo
          // CONTÍNUO não há número possível — a campanha aborda quem chegar, e
          // quantos chegarão não se sabe hoje.
          quantosCards={continua ? null : (previa.data?.elegiveis ?? null)}
          tetoPorDia={tetoDiario ? Number(tetoDiario) : null}
        />
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Quando a régua para")}</h2>
        <SaidasDaCampanhaEditor
          saidas={saidas}
          onChange={(s) => {
            setSaidas(s);
            setSaidasMexidas(true);
          }}
          etapas={etapas.data ?? []}
          temPassos={passos.length > 0}
          temFunil={!!funil}
        />
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Quem responder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Em branco, tudo segue como hoje: o card nasce no funil do número e quem atende é o agente publicado nele.",
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="funil">{t("Vira card no funil")}</Label>
            <Escolha
              id="funil"
              className="h-9 w-full"
              value={funil}
              onValueChange={(valorEscolhido) => {
                setFunil(valorEscolhido);
                setEtapa("");
              }}
            >
              <option value="">{t("Funil do número (padrão)")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Escolha>
          </div>
          <div className="space-y-2">
            <Label htmlFor="etapa">{t("Na etapa")}</Label>
            <Escolha
              id="etapa"
              className="h-9 w-full"
              value={etapa}
              onValueChange={(valorEscolhido) => setEtapa(valorEscolhido)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((e) => !e.is_won && !e.is_lost)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </Escolha>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agente">{t("Quem atende a resposta")}</Label>
          <Escolha
            id="agente"
            className="h-9 w-full"
            value={agente}
            onValueChange={(valorEscolhido) => setAgente(valorEscolhido)}
          >
            <option value="">{t("Agente publicado no número (padrão)")}</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Escolha>
          <p className="text-sm text-muted-foreground">
            {t(
              "Vale só para conversas que nascem desta campanha: quem já falava com você continua com quem o atendia. Quem aborda precisa saber dizer de onde veio o contato — essa resposta tem de estar no material do agente escolhido.",
            )}
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Ritmo desta campanha")}</h2>
        {canal && <VelocidadeDaCampanha valor={velocidade} onChange={setVelocidade} ehOficial={ehOficial} />}
        <p className="text-sm text-muted-foreground">
          {t(
            "Em branco, vale o ritmo do número (Conexões › Proteção de envio). O que você puser aqui só pode deixar mais devagar.",
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(
            "Os campos já vêm com o ritmo que a organização definiu em Configuração de campanhas, e com o recomendado para lista fria onde ela não definiu nada. Tudo é editável, e campo esvaziado volta a herdar o número.",
          )}
        </p>
        <AvisoDeRitmo ritmo={ritmoEscolhido} />
        <div className="grid gap-4 sm:grid-cols-2">
          {!rapida && (
          <div className="space-y-2">
            <Label htmlFor="intervalo">{t("Intervalo mínimo entre disparos (minutos)")}</Label>
            <Input
              id="intervalo"
              type="number"
              min={1}
              value={intervalo}
              onChange={(e) => setIntervalo(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("Tempo de espera entre um envio e o próximo contato da lista. Não é o intervalo dentro de uma conversa.")}
            </p>
          </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="teto">{t("Máximo por dia")}</Label>
            <Input
              id="teto"
              type="number"
              min={1}
              value={tetoDiario}
              onChange={(e) => setTetoDiario(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="teto-hora">{t("Máximo por hora")}</Label>
            <Input
              id="teto-hora"
              type="number"
              min={1}
              value={tetoHorario}
              onChange={(e) => setTetoHorario(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="janela-inicio">{t("Enviar só a partir das (hora)")}</Label>
            <Input
              id="janela-inicio"
              type="number"
              min={0}
              max={23}
              value={janelaInicio}
              onChange={(e) => setJanelaInicio(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="janela-fim">{t("Parar de enviar às (hora)")}</Label>
            <Input
              id="janela-fim"
              type="number"
              min={1}
              max={24}
              value={janelaFim}
              onChange={(e) => setJanelaFim(e.target.value)}
            />
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/app/campaigns")}>
          {t("Cancelar")}
        </Button>
        <Button disabled={!podeSalvar || criar.isPending} onClick={() => void salvar()}>
          {criar.isPending ? t("Salvando…") : t("Salvar rascunho")}
        </Button>
      </div>
      </SecaoDaPagina>
    </Pagina>
  );
}

/** Campo vazio é `null`, que é "herda o número" (o mesmo par das outras telas). */
function comoTexto(valor: number | null): string {
  return valor === null ? "" : String(valor);
}

function comoNumero(bruto: string): number | null {
  const limpo = bruto.trim();
  if (limpo === "") return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

function listar(bruto: string): string[] {
  return bruto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
