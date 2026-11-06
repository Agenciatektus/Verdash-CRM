"use client";
/**
 * Editar o rascunho (Spec 12 §6).
 *
 * ═══ Por que esta tela é obrigatória, e não um luxo ═══
 *
 * Sem ela, um erro de digitação no texto não tinha conserto: a API aceitava o
 * PATCH, mas nenhuma tela o oferecia, e duplicar não resolvia — a cópia também
 * não podia ser editada. O caminho real era recriar a campanha do zero, com o
 * público e o ritmo de novo. Medido em produção, no dia em que a feature subiu.
 *
 * ═══ O que esta tela NÃO faz ═══
 *
 * Não edita campanha que já foi preparada. Depois do snapshot, cada destinatário
 * carrega o texto congelado com que vai receber, e trocar a campanha ali faria a
 * tela mostrar uma coisa e a fila enviar outra. Para mexer no conteúdo é preciso
 * voltar ao rascunho — e isso só vale enquanto nada saiu. O RITMO é a exceção, e
 * ele se edita na própria tela de detalhe, com a campanha em pé.
 */
import { CabecalhoDaPagina, Pagina, SecaoDaPagina } from "@/components/pagina";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { MensagemDaCampanha } from "@/components/campanhas/MensagemDaCampanha";
import { EntradaDaCampanha } from "@/components/campanhas/EntradaDaCampanha";
import { PassosDaCampanha } from "@/components/campanhas/PassosDaCampanha";
import { SaidasDaCampanhaEditor, saidasDaTela } from "@/components/campanhas/SaidasDaCampanha";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Escolha } from "@/components/ui/escolha";
import {
  useCampanha,
  useEditarCampanha,
  useModelosDaCampanha,
  usePreviaDaAudiencia,
} from "@/hooks/campanhas/useCampanhas";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { filtroDeAudienciaSchema, limparFiltroSalvo } from "@/lib/campanhas/audiencia";
import {
  COMPRA_VAZIA,
  CamposDeCompraDoFiltro,
  compraDoFiltro,
  criteriosDeCompra,
  temCriterioDeCompra,
} from "../../_campos-de-compra";
import type { SaidasDaCadencia } from "@/lib/cadencia/saidas";
import type { PassoDaRegua } from "@/lib/regua/timeline";
import { useAgentesPublicados, useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";

/** Mantém o que o `excluir` gravado tem além da compra (tags/funil/silêncio via API); null se nada sobra. */
function excluirMesclado(original: Record<string, unknown> | null, compra: typeof COMPRA_VAZIA) {
  const novo = { ...original, ...criteriosDeCompra(compra) };
  return Object.values(novo).some((v) => v !== null && !(Array.isArray(v) && v.length === 0)) ? novo : null;
}

import {
  ModeloDaCampanha,
  variaveisIncompletas,
  type EscolhaDoModelo,
} from "../../_components/ModeloDaCampanha";

export function EditarCampanha({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const campanha = useCampanha(id);
  const canais = useChannelSessions();
  const salvar = useEditarCampanha(id);
  const previa = usePreviaDaAudiencia();

  const [nome, setNome] = useState("");
  const [canal, setCanal] = useState("");
  const [baseLegal, setBaseLegal] = useState<"consent" | "legitimate_interest">("consent");
  const [liaRef, setLiaRef] = useState("");
  const [comAlgumaTag, setComAlgumaTag] = useState("");
  const [semTags, setSemTags] = useState("");
  const [semInteracao, setSemInteracao] = useState("");
  const [limite, setLimite] = useState("100");
  // `variantes[0]` é o `message_body`; as demais são as EXTRAS (migration 9034).
  const [variantes, setVariantes] = useState<string[]>([""]);
  // A régua do 2º toque em diante (9037). Vazia = campanha de uma mensagem só.
  const [passos, setPassos] = useState<PassoDaRegua[]>([]);
  // QUANDO A RÉGUA PARA (9046). Carregado do rascunho; `null` vira o padrão,
  // que é o MESMO objeto que o servidor publica quando a coluna é nula.
  const [saidas, setSaidas] = useState<SaidasDaCadencia>(() => saidasDaTela(null));
  // ⚠️ SE A SEÇÃO FOI MEXIDA NESTA EDIÇÃO (parecer do @Cassio_SecRev, P2.1).
  // Mandar `saidas` sempre tinha dois efeitos ruins: a coluna nula de uma
  // campanha que nunca abriu a seção virava o objeto do padrão no primeiro
  // Salvar (matando a distinção "escolheu × herdou" que a coluna existe para
  // guardar), e uma coluna ILEGÍVEL era sobrescrita pelo padrão que
  // `saidasDaTela` mostrou, sem ninguém decidir isso. Não mexeu, não manda: o
  // laço da rota só copia campo `!== undefined`, então a coluna fica como está.
  const [saidasMexidas, setSaidasMexidas] = useState(false);
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");
  // O MODO DE PÚBLICO (9039). Carregado do rascunho; só muda por escolha.
  const [continua, setContinua] = useState(false);
  const [etapaDeEntrada, setEtapaDeEntrada] = useState("");
  const [compra, setCompra] = useState(COMPRA_VAZIA);
  const [excluirCompra, setExcluirCompra] = useState(COMPRA_VAZIA);
  // O `excluir` gravado (pode ter tags/funil/silêncio via API): a tela só edita os 4 campos de compra.
  const [excluirOriginal, setExcluirOriginal] = useState<Record<string, unknown> | null>(null);
  const [carregado, setCarregado] = useState(false);
  const [modelo, setModelo] = useState<EscolhaDoModelo | null>(null);

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const agentes = useAgentesPublicados();

  // Uma carga só: depois disso quem manda é o que a pessoa está digitando. Sem
  // a trava, o `refetchInterval` do detalhe apagaria a edição em andamento.
  useEffect(() => {
    const c = campanha.data;
    if (!c || carregado) return;
    const f = limparFiltroSalvo(c.audience_filter);
    setNome(c.name);
    setCanal(c.channel_session_id);
    setBaseLegal(c.base_legal === "legitimate_interest" ? "legitimate_interest" : "consent");
    setLiaRef(c.lia_ref ?? "");
    setComAlgumaTag(juntar(f.com_alguma_tag));
    setSemTags(juntar(f.sem_tags));
    setSemInteracao(f.sem_interacao_ha_dias == null ? "" : String(f.sem_interacao_ha_dias));
    setCompra(compraDoFiltro(f));
    setExcluirCompra(compraDoFiltro(f.excluir));
    setExcluirOriginal(f.excluir && typeof f.excluir === "object" ? (f.excluir as Record<string, unknown>) : null);
    setLimite(f.limite == null ? "100" : String(f.limite));
    setVariantes([c.message_body ?? "", ...(c.message_variants ?? [])]);
    setPassos(c.passos ?? []);
    setSaidas(saidasDaTela(c.saidas));
    setSaidasMexidas(false);
    setModelo(
      c.provider_template_name && c.provider_template_language
        ? {
            name: c.provider_template_name,
            language: c.provider_template_language,
            variables: c.provider_template_variables ?? {},
          }
        : null,
    );
    setFunil(c.pipeline_id ?? "");
    setEtapa(c.stage_id ?? "");
    setAgente(c.agent_id ?? "");
    setContinua(c.entrada_continua === true);
    setEtapaDeEntrada(c.entrada_etapa_id ?? "");
    setCarregado(true);
  }, [campanha.data, carregado]);

  const texto = variantes[0] ?? "";
  const extras = useMemo(
    () => variantes.slice(1).map((v) => v.trim()).filter((v) => v !== ""),
    [variantes],
  );

  // O que esta tela edita. É SÓ isto que o PATCH leva: o servidor mescla sobre o
  // filtro salvo, então funis/etapas/contatos incluídos no meio da edição ficam.
  const editados = useMemo(
    () => ({
      com_alguma_tag: listar(comAlgumaTag),
      sem_tags: listar(semTags),
      sem_interacao_ha_dias: semInteracao ? Number(semInteracao) : null,
      ...criteriosDeCompra(compra),
      excluir: excluirMesclado(excluirOriginal, excluirCompra),
      limite: Number(limite) || 100,
    }),
    [comAlgumaTag, semTags, semInteracao, compra, excluirCompra, excluirOriginal, limite],
  );
  // O filtro inteiro, só para a prévia (que não mescla no servidor).
  const filtro = useMemo(
    () => ({ ...limparFiltroSalvo(campanha.data?.audience_filter), ...editados }),
    [campanha.data?.audience_filter, editados],
  );

  // Mesmo critério do servidor (o refine do schema): conta também funis, etapas e
  // contatos incluídos do filtro salvo, que a tela não edita mas preserva.
  const temCriterio = filtroDeAudienciaSchema.safeParse(filtro).success;
  const salvo = limparFiltroSalvo(campanha.data?.audience_filter);
  const preservados = [
    [t("contatos incluídos"), listaDoSalvo(salvo.incluir_contatos)],
    [t("funis"), listaDoSalvo(salvo.funis)],
    [t("etapas"), listaDoSalvo(salvo.etapas)],
    [t("excluídos à mão"), listaDoSalvo(salvo.excluir_contatos)],
  ]
    .filter(([, n]) => (n as number) > 0)
    .map(([nome, n]) => `${nome as string}: ${n as number}`)
    .join(", ");

  // O que o número escolhido aceita: texto livre (QR) ou modelo aprovado (oficial).
  // Antes dos retornos de carregamento: hook não pode ser condicional.
  const doCanal = useModelosDaCampanha(canal);

  if (campanha.isLoading || !carregado) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const c = campanha.data;
  if (!c) {
    return (
      <div className="p-6">
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Não foi possível carregar a campanha.")}</p>
        </Card>
      </div>
    );
  }

  if (c.status !== "draft") {
    return (
      <Pagina>
        <CabecalhoDaPagina titulo={t("Editar campanha")} />
        <Card className="max-w-3xl space-y-3 p-4 mb:mx-4">
          <p className="text-sm">
            {t(
              "Esta campanha já foi preparada: cada pessoa da lista tem o texto que vai receber guardado. Para mudar o texto ou o público, volte a campanha para rascunho — isso descarta a lista montada.",
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("O ritmo você ajusta na própria tela da campanha, sem descartar nada.")}
          </p>
          <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
            {t("Voltar para a campanha")}
          </Button>
        </Card>
      </Pagina>
    );
  }

  const ehOficial = doCanal.data?.modo === "template";
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

  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    (ehOficial ? modeloPronto : texto.trim() !== "") &&
    // No modo CONTÍNUO o público é a etapa, e o recorte de contatos não é usado:
    // exigir critério ali prenderia o operador num filtro que a campanha ignora.
    (continua || temCriterio) &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  return (
    <Pagina>
      <CabecalhoDaPagina
        titulo={t("Editar campanha")}
        descricao={t("Enquanto é rascunho, tudo muda. Depois de preparada, só o ritmo.")}
      />
      <SecaoDaPagina className="max-w-3xl gap-4">

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="e-nome">{t("Nome da campanha")}</Label>
          <Input id="e-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-canal">{t("Enviar pelo número")}</Label>
          <Escolha
            id="e-canal"
            className="h-9 w-full"
            value={canal}
            onValueChange={(valorEscolhido) => {
              setCanal(valorEscolhido);
              // Cada número tem os próprios modelos: o escolhido no outro não vale aqui.
              setModelo(null);
            }}
          >
            {(canais.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {channelLabel(s, t)}
              </option>
            ))}
          </Escolha>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="e-lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input id="e-lia" value={liaRef} onChange={(e) => setLiaRef(e.target.value)} />
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
          tetoPorDia={c.teto_diario ?? null}
          janelaInicio={c.janela_inicio_hora ?? null}
          janelaFim={c.janela_fim_hora ?? null}
        />
        {/* O recorte de contatos só existe no modo LISTA: no contínuo o público
            é a etapa, e deixar o filtro à vista sugeriria que ele também vale. */}
        {!continua && (
        <>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="e-com-tags">{t("Com alguma destas etiquetas")}</Label>
            <Input
              id="e-com-tags"
              value={comAlgumaTag}
              onChange={(e) => setComAlgumaTag(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-sem-tags">{t("Sem nenhuma destas etiquetas")}</Label>
            <Input
              id="e-sem-tags"
              value={semTags}
              onChange={(e) => setSemTags(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-silencio">{t("Sem falar com a gente há (dias)")}</Label>
            <Input
              id="e-silencio"
              type="number"
              min={1}
              value={semInteracao}
              onChange={(e) => setSemInteracao(e.target.value)}
            />
          </div>
          <CamposDeCompraDoFiltro
            prefixo="e-compra"
            compra={compra}
            onCompra={setCompra}
            excluir={excluirCompra}
            onExcluir={setExcluirCompra}
          />
          <div className="space-y-2">
            <Label htmlFor="e-limite">{t("Máximo de contatos nesta campanha")}</Label>
            <Input
              id="e-limite"
              type="number"
              min={1}
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
            />
          </div>
        </div>
        {preservados !== "" && (
          <p className="text-xs text-muted-foreground">
            {t("Também no público")}: {preservados}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!temCriterio || previa.isPending}
            onClick={() =>
              previa.mutate({
                audience_filter: filtro,
                message_body: ehOficial ? "" : texto,
                message_variants: ehOficial ? [] : extras,
                campaign_id: id,
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
          {previa.data?.truncado && (
            <p className="text-sm text-amber-600">
              {t(
                "O recorte bateu o teto de 20.000 negócios desta prévia — a lista pode estar incompleta. Refine o filtro para ver o todo.",
              )}
            </p>
          )}
        </div>
        </>
        )}
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
            <Label htmlFor="e-funil">{t("Vira card no funil")}</Label>
            <Escolha
              id="e-funil"
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
            <Label htmlFor="e-etapa">{t("Na etapa")}</Label>
            <Escolha
              id="e-etapa"
              className="h-9 w-full"
              value={etapa}
              onValueChange={(valorEscolhido) => setEtapa(valorEscolhido)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((x) => !x.is_won && !x.is_lost)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Escolha>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-agente">{t("Quem atende a resposta")}</Label>
          <Escolha
            id="e-agente"
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
        </div>
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
          // frase do aviso fica sem número em vez de chutar um.
          quantosCards={continua ? null : (previa.data?.elegiveis ?? null)}
          tetoPorDia={c.teto_diario ?? null}
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

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
          {t("Cancelar")}
        </Button>
        <Button
          disabled={!podeSalvar || salvar.isPending}
          onClick={async () => {
            await salvar.mutateAsync({
              name: nome.trim(),
              channel_session_id: canal,
              ...(ehOficial && modelo
                ? {
                    message_mode: "template",
                    provider_template_name: modelo.name,
                    provider_template_language: modelo.language,
                    provider_template_variables: modelo.variables,
                  }
                : { message_body: texto.trim(), message_variants: extras }),
              base_legal: baseLegal,
              lia_ref: liaRef.trim() || null,
              audience_filter: editados,
              pipeline_id: funil || null,
              stage_id: etapa || null,
              agent_id: agente || null,
              passos,
              ...(saidasMexidas ? { saidas } : {}),
              entrada_continua: continua,
              entrada_etapa_id: continua ? etapaDeEntrada || null : null,
            });
            router.push(`/app/campaigns/${id}`);
          }}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar alterações")}
        </Button>
      </div>
      </SecaoDaPagina>
    </Pagina>
  );
}

function listar(bruto: string): string[] {
  return bruto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function juntar(valor: unknown): string {
  return Array.isArray(valor) ? valor.filter((v) => typeof v === "string").join(", ") : "";
}

function listaDoSalvo(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
