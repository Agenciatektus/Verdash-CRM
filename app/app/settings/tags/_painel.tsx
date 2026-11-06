"use client";
import { TABELA_EMPILHADA } from "@/components/pagina";

/**
 * O painel da tela de Tags: a lista do vocabulário com o PESO de cada etiqueta e
 * as operações — renomear, juntar, excluir (issue #852, fatia S4) e a cor
 * (issue #1271, fatia S6).
 *
 * ── Por que cada linha abre com os números, e não com o botão ───────────────
 *
 * A pergunta que traz o operador até aqui é "posso mexer nesta?". A resposta é o
 * número: quantos contatos, leads e conversas carregam a etiqueta, e quantas
 * regras de agente ainda escrevem esse nome. A coluna de regras é a que a lista
 * de conversas nunca mostrava — foi ela que deixou a grafia antiga voltar depois
 * da "arrumação".
 *
 * ── Por que excluir pede confirmação e renomear não ─────────────────────────
 *
 * Renomear é reversível: o nome novo aparece na lista e dá para voltar. Excluir
 * tira a etiqueta de todos os registros da organização e não existe desfazer —
 * então a confirmação diz exatamente o que sai, com o número na frente. As
 * regras `add_tag` NÃO são apagadas pela exclusão (decisão de outra tela, com o
 * runbook do agente na mão); o aviso informa quantas continuam escrevendo.
 *
 * ── Por que a cor mora NESTA tela, e não numa tela de aparência ─────────────
 *
 * Cor de etiqueta parece cosmético e não é: é a informação que faz o operador
 * achar "reclamação" numa fila de duzentas conversas antes de ler o texto, e é a
 * que denuncia a duplicata que a contagem de uso não mostra ("orçamento" e
 * "orçamento novo" em dois tons do mesmo verde). O lugar de decidir isso é a
 * tela que já responde "onde esta etiqueta está usada" — não um painel de tema,
 * porque quem escolhe a cor aqui é quem arruma o vocabulário.
 *
 * ── Por que os tons têm NOME, e a fileira não é um seletor de cor ───────────
 *
 * A fileira oferece oito tons medidos (`PALETA_DE_ETIQUETAS`), não um seletor
 * livre: seletor livre recria em cada instalação o problema que esta tela veio
 * consertar. Cada tom tem nome porque cor não é o único jeito de escolher —
 * quem não distingue matiz (ou está com o brilho no mínimo) escolhe por
 * "Âmbar"/"Roxo", e o leitor de tela anuncia o mesmo. É a régua de redundância
 * não-cromática que o design system já usa nos estados.
 */
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { invalidarCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { Escolha } from "@/components/ui/escolha";
import { normalizarCorDeEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { traduzir } from "@/lib/i18n/traducao";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { AcaoDeVocabulario, InventarioDeTags, LinhaDeVocabulario } from "@/lib/schemas/tags";
// ─── DIVERGÊNCIA TEKTUS (9038) — as sugestões da curadoria do fork ──────────
// O comportamento mora em `_sugestoes.tsx` (arquivo do fork); aqui ficam só a
// coluna, o bloco de acrescentar e a trava da etiqueta `cliente`.
import { AcrescentarEtiqueta, BotoesDeSugestao, unirComSugestoes } from "./_sugestoes";
import { BarraDeEtiquetasEmLote, ERRO_EM_PORTUGUES, FileiraDeTons } from "./_lote";

/**
 * O TETO DA LISTA, e por que ele é declarado aqui.
 *
 * `fn_vocabulario_de_tags` termina em `limit 500` (migration 0264). A rota
 * devolve `meta.total = tags.length`, que é o tamanho da PÁGINA e não o total —
 * então nem o `meta` denuncia o corte. Sem esta linha, numa organização com mais
 * de 500 etiquetas distintas a que o operador veio arrumar podia simplesmente
 * não estar na tela, nem na lista de destinos do "juntar", sem nada dizendo que
 * faltava alguma. Lista truncada em silêncio lê como lista completa.
 *
 * O número vive nos DOIS arquivos e é vigiado por
 * `tests/unit/tags-vocabulario.test.ts` ("o teto da tela é o mesmo `limit` do
 * SQL"), que lê o `limit` da migration e esta constante: mudar um sem o outro
 * reprova.
 */
const TETO_DA_LISTA = 500;

/**
 * O NOME DE CADA TOM DA PALETA mora em `@/lib/tags/cor-da-etiqueta` desde a
 * #2718 — junto da paleta, que o seletor de criação também usa. O teste
 * `tests/unit/tags-cor-de-etiqueta.test.ts` cobra que o mapa tenha
 * EXATAMENTE as chaves de `PALETA_DE_ETIQUETAS`.
 */

/**
 * ONDE O NOME DE UMA ETIQUETA ESTÁ EM CACHE no cliente — e por isso precisa ser
 * relido depois de renomear, juntar ou excluir. Prefixos: invalidar `["contact"]`
 * alcança `["contact", id]` e as sub-chaves. `invalidarCoresDasEtiquetas` sozinho
 * repintava o MAPA de cores, mas a lista, o cartão e o editor do Inbox seguiam com
 * o nome antigo (cinza, já sem verbete de cor) por até 30 s, e o filtro de
 * etiquetas oferecia o nome morto por até 5 min (`staleTime` dos vocabulários).
 * Medido na prova de tela do #2784.
 */
export const CHAVES_COM_NOME_DE_ETIQUETA = [
  ["conversations"],
  ["conversation"],
  ["conversation-tag-vocabulary"],
  ["contacts"],
  ["contact"],
  ["contact-tag-vocabulary"],
  ["board"],
] as const;

// O mapa das recusas (`ERRO_EM_PORTUGUES`) mora em `./_lote`: a barra em lote
// responde as mesmas recusas, e duas cópias desalinham na primeira frase nova.

const DESTINO_INEXISTENTE =
  "Essa etiqueta não existe. Juntar só leva para uma etiqueta que já existe; para dar um nome novo, use Renomear.";

export function PainelDeTags({
  tags: tagsDoVocabulario,
  idioma,
  sugestoes = null,
  paginado = false,
}: {
  tags: LinhaDeVocabulario[];
  idioma: Idioma;
  /** 9038: o inventário de sugestões da 9005 (`fn_tags_inventario`). */
  sugestoes?: InventarioDeTags | null;
  /** #2855: a lista é uma página; o destino da junção é digitado e checado no servidor. */
  paginado?: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  // 9038: as sugestões sem uso entram na lista (ver `unirComSugestoes`).
  const tags = useMemo(() => unirComSugestoes(tagsDoVocabulario, sugestoes), [tagsDoVocabulario, sugestoes]);
  // 9038: `cliente` reservada pela regra da agenda não oferece renomear, juntar
  // nem excluir — o servidor recusaria (`fn_tags_reserva`), e botão que só
  // devolve erro é promessa falsa. Cor e sugestão continuam valendo.
  const reservada = (tag: string) =>
    !!sugestoes?.cliente_pela_agenda && tag.trim().toLowerCase() === "cliente";
  const router = useRouter();
  const queryClient = useQueryClient();
  const [alvo, setAlvo] = useState<LinhaDeVocabulario | null>(null);
  const [acao, setAcao] = useState<AcaoDeVocabulario>("renomear");
  const [destino, setDestino] = useState("");
  const [cor, setCor] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // A SELEÇÃO do lote, por nome canônico (a mesma régua do banco): "VIP" e
  // "vip" são a mesma etiqueta.
  const [marcadas, setMarcadas] = useState<Set<string>>(() => new Set());

  const destinos = useMemo(
    () =>
      tags.filter(
        (linha) =>
          linha.tag.toLowerCase() !== alvo?.tag.toLowerCase() &&
          // 9038: `cliente` reservada também não é destino de junção.
          !reservada(linha.tag),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reservada` deriva de `sugestoes`
    [tags, alvo, sugestoes],
  );

  /**
   * O nome digitado já É uma etiqueta desta organização (issue #2801).
   *
   * Nesse caso `renomear` não renomeia: ele junta as duas entradas numa só, e
   * o que sobra de cor/descrição é decidido pelo vocabulário, não por quem
   * digitou. A tela avisa ANTES do clique — o marcador `juntou` da resposta
   * só chega depois, quando já não há o que desfazer. Mesma régua visual do
   * aviso de `excluir`: uma frase que diz o que vai acontecer, não um "tem
   * certeza?".
   *
   * Compara com `destinos`, que já exclui a própria etiqueta: mudar só a caixa
   * ("cliente" → "Cliente") é renome, não junção.
   */
  const nomeDigitado = destino.trim().toLowerCase();
  // #2855 — com a lista paginada, o nome pode estar em OUTRA página: pergunta ao
  // servidor pela mesma busca da tela (curado + em uso + regras). Serve ao aviso
  // de renomear (#2801) e à junção, que só aceita destino que existe.
  const { data: achadasNoServidor } = useQuery({
    queryKey: ["tags-vocabulario-busca", nomeDigitado],
    enabled: paginado && nomeDigitado.length > 0 && (acao === "renomear" || acao === "juntar"),
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<LinhaDeVocabulario[]> => {
      const resposta = await fetch(
        "/api/v1/tags/vocabulario?busca=" + encodeURIComponent(destino.trim()),
        { signal },
      );
      if (!resposta.ok) throw new Error(`busca_do_destino_${resposta.status}`);
      return ((await resposta.json()) as { data?: LinhaDeVocabulario[] }).data ?? [];
    },
  });
  const outraEtiqueta = (linha: LinhaDeVocabulario) =>
    linha.tag.toLowerCase() === nomeDigitado && linha.tag.toLowerCase() !== alvo?.tag.toLowerCase();
  const nomeJaExiste =
    nomeDigitado.length > 0 &&
    (destinos.some(outraEtiqueta) || (achadasNoServidor ?? []).some(outraEtiqueta));
  const destinoJaExiste = acao === "renomear" && nomeJaExiste;
  // Só acusa depois que o servidor respondeu: enquanto a busca corre, não há
  // como saber, e o servidor recusa de novo no POST (`destino_inexistente`).
  const destinoDaJuncaoInexistente =
    paginado && acao === "juntar" && achadasNoServidor !== undefined && nomeDigitado.length > 0 && !nomeJaExiste;

  /**
   * O que a tela relê depois de QUALQUER mudança no vocabulário: o mapa de
   * cores, os nomes em cache das outras telas e a própria lista.
   */
  function reler(tambemNomes: boolean) {
    invalidarCoresDasEtiquetas(queryClient);
    if (tambemNomes) {
      for (const queryKey of CHAVES_COM_NOME_DE_ETIQUETA) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    }
    router.refresh();
  }

  const chave = (tag: string) => tag.trim().toLowerCase();
  const selecionaveis = tags.filter((linha) => !reservada(linha.tag));
  const selecionadas = selecionaveis.filter((linha) => marcadas.has(chave(linha.tag)));
  const todasMarcadas = selecionaveis.length > 0 && selecionadas.length === selecionaveis.length;
  const algumaMarcada = selecionadas.length > 0;

  function alternar(tag: string) {
    setMarcadas((antes) => {
      const depois = new Set(antes);
      if (depois.has(chave(tag))) depois.delete(chave(tag));
      else depois.add(chave(tag));
      return depois;
    });
  }

  function alternarTodas() {
    setMarcadas(todasMarcadas ? new Set() : new Set(selecionaveis.map((linha) => chave(linha.tag))));
  }

  // `?.` porque o jsdom não implementa `scrollIntoView`.
  const rolarAteOCartao = useCallback((elemento: HTMLDivElement | null) => {
    elemento?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, []);

  function abrir(linha: LinhaDeVocabulario, qual: AcaoDeVocabulario) {
    setAlvo(linha);
    setAcao(qual);
    setDestino("");
    // A cor já vem do servidor (`linha.cor`): a fileira abre com a escolha atual
    // marcada. Sem isso, abrir a cor de uma etiqueta que JÁ tem uma faria parecer
    // que ela não tem nenhuma, e "Confirmar" apagaria o que estava lá. Lida pela
    // normalização porque `linha.cor` vem crua do SQL: uma etiqueta com o tom
    // antigo da #2373 abre com o tom novo marcado.
    setCor(qual === "definir_cor" ? normalizarCorDeEtiqueta(linha.cor) : null);
  }

  async function enviar() {
    if (!alvo) return;
    setOcupado(true);
    try {
      const resposta = await fetch("/api/v1/tags/vocabulario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `cor` só viaja na ação que fala dela: o servidor recusa o campo nas
        // outras (`cor_invalida_para_acao`), e mandar sempre faria a tela
        // depender de o servidor ignorar o que não pediu.
        body: JSON.stringify({
          acao,
          tag: alvo.tag,
          destino: destino || null,
          ...(acao === "definir_cor" ? { cor } : {}),
        }),
      });
      const corpo = (await resposta.json().catch(() => null)) as
        | { data?: Record<string, number | string | boolean | null>; error?: { code?: string } }
        | null;
      if (!resposta.ok) {
        const codigo = corpo?.error?.code ?? "internal_error";
        toast.error(t(ERRO_EM_PORTUGUES[codigo] ?? "Não foi possível concluir agora. Tente de novo."));
        // O diálogo de excluir fecha com o erro: ele é modal, e deixá-lo aberto
        // prenderia a tela num "Confirmar" que vai recusar de novo. O cartão das
        // outras ações fica, para corrigir o nome e tentar outra vez.
        if (acao === "excluir") setAlvo(null);
        return;
      }
      const dados = corpo?.data ?? {};
      // TODA ação mexe no verbete de cor, não só `definir_cor`. `renomear` move
      // o nome na MESMA escrita em que o verbete de cor vai junto (a 0336 faz o
      // `jsonb_set` só em `{tag}`), `juntar` junta dois verbetes e `excluir`
      // tira o de baixo — e é o MAPA do provider que pinta a lista de
      // conversas, o funil, os filtros e os editores do Inbox. Invalidar só na
      // cor era o que deixava o chip novo CINZO depois de um rename, por até 5
      // minutos (o `staleTime`), até alguém dar F5: "renomear descolora"
      // (#2771). O dado já estava certo no banco; quem não acompanhava era a
      // tela.
      if (acao === "definir_cor") {
        reler(false);
        toast.success(t("Cor da etiqueta atualizada."));
        setAlvo(null);
        return;
      }
      reler(true);
      // A etiqueta que saiu (ou foi juntada) não pode continuar marcada no lote.
      setMarcadas((antes) => {
        const depois = new Set(antes);
        depois.delete(chave(alvo.tag));
        return depois;
      });
      const alterados =
        Number(dados.contatos ?? 0) + Number(dados.leads ?? 0) + Number(dados.conversas ?? 0);
      if (dados.juntou === true) {
        // ⚠️ O AVISO DE JUNÇÃO (issue #2801). Renomear para um nome que já
        // existia JUNTAVA as duas etiquetas e respondia como renome simples:
        // a frase de sucesso abaixo era indistinguível da de um rename que não
        // juntou nada, e o operador só descobria depois, na lista. O marcador
        // vem do BANCO — é ali que se sabe se o destino já existia como
        // entrada do vocabulário; a tela só tem a lista que ela mesma leu, e o
        // caso interessante é justamente o que já vinha como duas linhas.
        //
        // `toast.warning` e não `toast.success`: a operação foi concluída, mas
        // ela fez ALGO A MAIS do que o botão prometia, e isso não pode sair
        // com o mesmo tom de um renome normal.
        toast.warning(
          `${t("Etiqueta juntada em")} ${destino} — ${t("as duas etiquetas viraram uma só.")}`,
        );
        setAlvo(null);
        return;
      }
      // ⚠️ O DADO ENTRA FORA DO `t()`. `traduzir()` casa a string EXATA, então
      // uma frase montada em runtime nunca casa chave nenhuma —
      // a frase sai em português para quem escolheu espanhol, e o guarda de i18n
      // não acusa (ele só registra literal sem substituição).
      toast.success(
        acao === "excluir"
          ? `${t("Etiqueta removida de")} ${alterados} ${t("registro(s).")}`
          : `${t("Etiqueta atualizada em")} ${alterados} ${t("registro(s) e em")} ${Number(dados.regras ?? 0)} ${t("regra(s) de agente.")}`,
      );
      setAlvo(null);
    } catch {
      // Sem este ramo, uma falha de REDE (app reiniciando, conexão caída) não
      // dizia nada: o botão voltava de "Aplicando..." para "Confirmar", que lê
      // como "nada aconteceu" — enquanto a operação pode ter sido aplicada no
      // servidor. O caminho de erro do SERVIDOR já era tratado acima.
      toast.error(
        t("Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo."),
      );
    } finally {
      setOcupado(false);
    }
  }

  if (tags.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <AcrescentarEtiqueta idioma={idioma} />
        <Card className="p-6 text-sm text-muted-foreground">
          {t(
            "Nenhuma etiqueta nesta organização ainda. Elas aparecem aqui conforme os agentes, o Inbox e o funil usarem.",
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AcrescentarEtiqueta idioma={idioma} />
      <Card className="overflow-x-auto">
        {/* No celular o `thead` some (tabela empilhada) e leva junto a caixa de
            "selecionar todas"; esta linha é a mesma caixa para essa largura. */}
        <label className="hidden items-center gap-2 border-b border-border/60 p-3 text-sm mb:flex">
          <input
            type="checkbox"
            checked={todasMarcadas}
            onChange={alternarTodas}
          />
          {t("Selecionar todas")}
        </label>
        <table className={`w-full text-sm ${TABELA_EMPILHADA}`}>
          <caption className="sr-only">{t("Etiquetas da organização e onde são usadas")}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-3 font-medium">
                <span className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={t("Selecionar todas as etiquetas")}
                    checked={todasMarcadas}
                    // Parcial é "algumas marcadas": o estado do meio é o que diz
                    // que clicar vai MARCAR o resto, não desmarcar.
                    ref={(caixa) => {
                      if (caixa) caixa.indeterminate = algumaMarcada && !todasMarcadas;
                    }}
                    onChange={alternarTodas}
                    disabled={selecionaveis.length === 0}
                  />
                  {t("Etiqueta")}
                </span>
              </th>
              <th className="p-3 font-medium">{t("Contatos")}</th>
              <th className="p-3 font-medium">{t("Leads")}</th>
              <th className="p-3 font-medium">{t("Conversas")}</th>
              <th className="p-3 font-medium">{t("Regras de agente")}</th>
              {sugestoes && <th className="p-3 font-medium">{t("Sugestão")}</th>}
              <th className="p-3 font-medium">{t("Ações")}</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((linha) => (
              <tr key={linha.tag} className="border-t border-border/60">
                <td className="p-3">
                  {/* 9038: a `cliente` reservada não entra no lote, pelo mesmo
                      motivo de não ter Renomear/Juntar/Excluir na linha. */}
                  {!reservada(linha.tag) && (
                    <input
                      type="checkbox"
                      aria-label={`${t("Selecionar")} ${linha.tag}`}
                      checked={marcadas.has(chave(linha.tag))}
                      onChange={() => alternar(linha.tag)}
                      className="mr-2 align-middle"
                    />
                  )}
                  {/* A cor do SERVIDOR, não a do cache do chip: esta lista acabou
                      de ler o vocabulário, e mostrar o que a outra leitura
                      devolveu seria a tela discordando de si mesma por alguns
                      segundos. */}
                  <ChipDeEtiqueta tag={linha.tag} cor={linha.cor} />
                  {!linha.no_vocabulario && (
                    // Em uso e fora do vocabulário curado: existe em algum
                    // registro sem passar por nenhuma tela de cadastro. Dar cor
                    // (o botão ao lado) traz a etiqueta para o vocabulário —
                    // escolher como ela aparece É curá-la.
                    <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("em uso, fora do vocabulário")}
                    </span>
                  )}
                </td>
                <td data-rotulo={t("Contatos")} className="p-3 tabular-nums">{linha.uso_em_contatos}</td>
                <td data-rotulo={t("Leads")} className="p-3 tabular-nums">{linha.uso_em_leads}</td>
                <td data-rotulo={t("Conversas")} className="p-3 tabular-nums">{linha.uso_em_conversas}</td>
                <td data-rotulo={t("Regras de agente")} className="p-3 tabular-nums">
                  {linha.em_regras > 0 ? (
                    <span className="font-medium">{linha.em_regras}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                {sugestoes && (
                  <td className="p-3">
                    <BotoesDeSugestao tag={linha.tag} inventario={sugestoes} idioma={idioma} />
                  </td>
                )}
                <td className="flex flex-wrap gap-2 p-3">
                  <Button size="sm" variant="outline" onClick={() => abrir(linha, "definir_cor")}>
                    {t("Cor")}
                  </Button>
                  {reservada(linha.tag) ? (
                    <span
                      className="self-center rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      title={t(
                        "A etiqueta cliente é posta pelo sistema enquanto a regra Clientes pela agenda estiver ligada. Desligue-a em Tipos de agendamento para editá-la aqui.",
                      )}
                    >
                      {t("do sistema")}
                    </span>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => abrir(linha, "renomear")}>
                        {t("Renomear")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => abrir(linha, "juntar")}>
                        {t("Juntar")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => abrir(linha, "excluir")}>
                        {t("Excluir")}
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!paginado && tags.length >= TETO_DA_LISTA && (
          <p className="border-t border-border/60 p-3 text-sm text-muted-foreground">
            {t(
              "Mostrando as 500 primeiras etiquetas em ordem alfabética. Se a que você procura não está aqui, arrume primeiro as que aparecem.",
            )}
          </p>
        )}
      </Card>

      <BarraDeEtiquetasEmLote
        selecionadas={selecionadas}
        destinos={selecionaveis}
        idioma={idioma}
        onClear={() => setMarcadas(new Set())}
        aoConcluir={() => reler(true)}
      />

      {/* ⚠️ EXCLUIR É UM DIÁLOGO, E NÃO O CARTÃO DE BAIXO (o "Excluir não
          funciona" de 20/10/2026). A confirmação morava no cartão que abre
          DEPOIS da tabela inteira. Numa organização com dezenas de etiquetas,
          clicar em Excluir numa linha do alto abria o cartão lá embaixo, fora
          da tela: nada mudava onde o operador estava olhando, e o pedido nunca
          saía (o log de auditoria tinha a cor de outra etiqueta e nenhum
          excluir). O diálogo abre onde a pessoa está, com os números na frente. */}
      <AlertDialog
        open={!!alvo && acao === "excluir"}
        onOpenChange={(aberto) => !aberto && !ocupado && setAlvo(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir etiqueta?")}</AlertDialogTitle>
            {alvo && (
              <AlertDialogDescription>
                {/* Mesma regra do toast: o texto estático passa por `t()`, a
                    etiqueta e os números entram fora dele. */}
                {t("Excluir")} <strong>{alvo.tag}</strong> {t("de")} {alvo.uso_em_contatos}{" "}
                {t("contato(s),")} {alvo.uso_em_leads} {t("lead(s) e")} {alvo.uso_em_conversas}{" "}
                {t("conversa(s).")}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {alvo && (
            <p className="text-sm">
              {alvo.uso_em_contatos + alvo.uso_em_leads + alvo.uso_em_conversas}{" "}
              {t("registro(s) perdem a etiqueta, e ela sai do vocabulário. Não dá para desfazer.")}
            </p>
          )}
          {alvo && alvo.em_regras > 0 && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {t("Atenção:")} {alvo.em_regras}{" "}
              {t(
                "regra(s) de agente continuam escrevendo esta etiqueta. Excluir aqui não apaga a regra — o agente vai recriar a etiqueta no próximo atendimento.",
              )}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ocupado}>{t("Cancelar")}</AlertDialogCancel>
            {/* Botão comum, e não `AlertDialogAction`: o Action fecha no clique,
                antes de a resposta chegar. */}
            <Button variant="destructive" onClick={enviar} disabled={ocupado}>
              {ocupado ? t("Aplicando...") : t("Confirmar")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {alvo && acao !== "excluir" && (
        <Card
          // O cartão abre DEPOIS da tabela: sem rolar até ele, clicar numa linha
          // do alto não mudava nada à vista (o mesmo defeito que tirou o
          // excluir daqui). A `key` remonta o cartão a cada linha/ação, para a
          // rolagem acontecer de novo; a ref é estável para não rolar a cada
          // tecla digitada no novo nome.
          key={`${alvo.tag}:${acao}`}
          ref={rolarAteOCartao}
          className="flex flex-col gap-4 p-4"
        >
          <p className="text-sm">
            {/* Mesma regra do toast: o texto estático passa por `t()`, a
                etiqueta entra fora dele. */}
            {acao === "renomear" && (
              <>
                {t("Renomear")} <strong>{alvo.tag}</strong> {t("para:")}
              </>
            )}
            {acao === "juntar" && (
              <>
                {t("Juntar")} <strong>{alvo.tag}</strong> {t("em outra etiqueta existente:")}
              </>
            )}
            {acao === "definir_cor" && (
              <>
                {t("Cor")} <strong>{alvo.tag}</strong>{" "}
                {t("nas listas e nos filtros:")}
              </>
            )}
          </p>

          {acao === "juntar" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="destino-da-juncao">{t("Etiqueta de destino")}</Label>
              {paginado ? <>
                <Input id="destino-da-juncao" list="destinos-da-juncao" value={destino}
                  onChange={e=>setDestino(e.target.value)} maxLength={60}
                  placeholder={t("Digite o nome exato da etiqueta de destino")}/>
                <datalist id="destinos-da-juncao">{destinos.map(linha=><option key={linha.tag} value={linha.tag}/>)}</datalist>
                {destinoDaJuncaoInexistente && (
                  <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                    {t(DESTINO_INEXISTENTE)}
                  </p>
                )}
              </> :
              <Escolha
                id="destino-da-juncao"
                className="h-9"
                value={destino}
                onValueChange={(valorEscolhido) => setDestino(valorEscolhido)}
              >
                <option value="">{t("Escolha a etiqueta que fica")}</option>
                {destinos.map((linha) => (
                  <option key={linha.tag} value={linha.tag}>
                    {linha.tag}
                  </option>
                ))}
              </Escolha>}
            </div>
          ) : acao === "definir_cor" ? (
            <div className="flex flex-col gap-3">
              <Label>{t("Cor da etiqueta")}</Label>
              <FileiraDeTons cor={cor} aoEscolher={setCor} t={t} />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t("Prévia:")}</span>
                {/* A prévia usa o TOM SELECIONADO antes de salvar: escolher cor
                    por paleta sem ver o resultado no próprio chip é adivinhação. */}
                <ChipDeEtiqueta tag={alvo.tag} cor={cor} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="novo-nome-da-tag">{t("Novo nome")}</Label>
              <Input
                id="novo-nome-da-tag"
                value={destino}
                onChange={(evento) => setDestino(evento.target.value)}
                maxLength={60}
                placeholder={alvo.tag}
              />
              {destinoJaExiste && (
                // O AVISO ANTES DO CLIQUE (issue #2801). Renomear para um nome
                // que já existe não renomeia: junta as duas etiquetas numa só,
                // e a cor/descrição que sobra é decidida pelo vocabulário. O
                // `juntou` da resposta só chega DEPOIS, quando já não há o que
                // desfazer — então quem lê este aviso ainda pode escolher
                // "Juntar" de propósito, ou outro nome. Mesma régua visual do
                // aviso do diálogo de excluir: a frase diz o que vai acontecer.
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  {t(
                    "Este nome já existe no vocabulário — confirmar vai juntar as duas etiquetas numa só.",
                  )}
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={enviar}
              disabled={ocupado || destinoDaJuncaoInexistente || (acao !== "definir_cor" && destino.trim().length === 0)}
            >
              {ocupado ? t("Aplicando...") : t("Confirmar")}
            </Button>
            <Button variant="ghost" onClick={() => setAlvo(null)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
