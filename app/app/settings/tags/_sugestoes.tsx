"use client";

/**
 * AS SUGESTÕES NA TELA DE TAGS (migration 9038) — o que só a tela de Etiquetas
 * (9005) tinha, trazido para a única tela de etiquetas.
 *
 * Arquivo do FORK, separado de `_painel.tsx` (upstream) de propósito: o painel
 * ganha uma coluna e um bloco, e o comportamento mora aqui. Assim a próxima
 * subida do upstream conflita em poucas linhas do painel, não em tudo.
 *
 * ─── O QUE É "SUGESTÃO", E POR QUE SÃO DUAS COLUNAS DE ESTADO ───────────────
 *
 * As etiquetas de CONVERSA (o atendimento: dúvida, troca, urgente) e as de
 * CONTATO (a pessoa: vip, inadimplente) têm listas de sugestão separadas
 * (`settings.canonical_*_tags` e `settings.archived_*_tags`). Sugerida é o que
 * o seletor do Inbox oferece para quem atende; arquivada saiu da sugestão e o
 * dado fica (quem tinha continua tendo, o filtro continua achando). Por isso o
 * estado é por escopo, e a etiqueta pode ser sugerida em conversas e não em
 * contatos.
 *
 * ─── OS TRÊS ESTADOS, E O CLIQUE DE CADA UM ─────────────────────────────────
 *
 *   sugerida ... clique arquiva (reversível, não reescreve registro nenhum)
 *   arquivada .. clique volta a sugerir
 *   fora ....... clique promove a sugestão (a etiqueta já existe em uso, ou foi
 *                acrescentada só no outro escopo)
 *
 * Nenhum dos três reescreve conversa ou contato, então nenhum pede confirmação:
 * o custo de um clique errado é desfeito pelo clique seguinte.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { arquivarTag, criarTag } from "@/app/actions/settings/curarTags";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/traducao";
import type {
  EscopoDeTag,
  InventarioDeTags,
  LinhaDeVocabulario,
  RespostaDeCuradoria,
} from "@/lib/schemas/tags";
import { Archive, Check, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export type EstadoDeSugestao = "sugerida" | "arquivada" | "fora";

/** A régua do Inbox e de `fn_tags_normalizar`: trim e minúsculas. */
function chave(tag: string): string {
  return tag.trim().toLowerCase();
}

export function estadoNoEscopo(
  inventario: InventarioDeTags,
  escopo: EscopoDeTag,
  tag: string,
): EstadoDeSugestao {
  const k = chave(tag);
  if (inventario[escopo].canonicas.some((t) => chave(t) === k)) return "sugerida";
  if (inventario[escopo].arquivadas.some((t) => chave(t) === k)) return "arquivada";
  return "fora";
}

/**
 * As linhas da tabela: as do vocabulário do upstream MAIS as sugestões que
 * ninguém usa ainda.
 *
 * `fn_vocabulario_de_tags` lista o que está em uso, em `settings.tags` e em
 * `canonical_conversation_tags`. Uma etiqueta acabada de acrescentar como
 * sugestão de CONTATO (ou arquivada sem uso) não aparece lá — e sem esta união
 * o operador acrescentaria a palavra e não a veria na tela, que é o "salvei e
 * não aconteceu nada". A linha sintética entra com zero de uso e
 * `no_vocabulario: true`, porque ela ESTÁ numa lista curada (de sugestão).
 */
export function unirComSugestoes(
  linhas: LinhaDeVocabulario[],
  inventario: InventarioDeTags | null,
): LinhaDeVocabulario[] {
  if (!inventario) return linhas;
  const conhecidas = new Set(linhas.map((l) => chave(l.tag)));
  const extras: LinhaDeVocabulario[] = [];
  for (const escopo of ["conversa", "contato"] as const) {
    for (const tag of [...inventario[escopo].canonicas, ...inventario[escopo].arquivadas]) {
      const k = chave(tag);
      if (!k || conhecidas.has(k)) continue;
      conhecidas.add(k);
      extras.push({
        tag,
        uso_em_contatos: 0,
        uso_em_leads: 0,
        uso_em_conversas: 0,
        em_regras: 0,
        cor: null,
        descricao: null,
        no_vocabulario: true,
      });
    }
  }
  return [...linhas, ...extras].sort((a, b) => a.tag.localeCompare(b.tag, "pt-BR"));
}

/** Cada recusa das actions vira uma frase que diz o que fazer (mesmas da 9005). */
function mensagemDoErro(erro: string, t: (s: string) => string): string {
  switch (erro) {
    case "destino_ja_existe":
      return t("Já existe uma etiqueta com esse nome. Para unir as duas, use Juntar na linha dela.");
    case "etiqueta_do_sistema":
      return t(
        "A etiqueta cliente é posta pelo sistema enquanto a regra Clientes pela agenda estiver ligada. Desligue-a em Tipos de agendamento para editá-la aqui.",
      );
    case "sem_permissao":
      return t("Só um gerente ou administrador da organização pode mudar as etiquetas.");
    case "mfa":
      return t("Entre novamente com o código do aplicativo para continuar.");
    case "limite":
      return t("O vocabulário chegou ao limite de 50 etiquetas. Arquive alguma antes.");
    case "nome_invalido":
      return t("Esse nome não vale: use de 1 a 40 caracteres.");
    case "somente_leitura":
      return t("O acompanhamento de suporte é só de leitura.");
    case "tente_de_novo":
      return t("O banco estava ocupado. Tente de novo.");
    default:
      return t("Não consegui salvar essa mudança agora.");
  }
}

function useExecutar(idioma: Idioma) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [ocupado, startTransition] = useTransition();
  function executar(
    acoes: Array<() => Promise<RespostaDeCuradoria>>,
    sucesso: string,
    depois?: () => void,
  ) {
    startTransition(async () => {
      for (const acao of acoes) {
        const r = await acao();
        if (!r.ok) {
          toast.error(mensagemDoErro(r.erro, t));
          router.refresh();
          return;
        }
      }
      toast.success(sucesso);
      depois?.();
      router.refresh();
    });
  }
  return { t, ocupado, executar };
}

/** O bloco de cima: acrescentar uma etiqueta nova e dizer onde ela é sugerida. */
export function AcrescentarEtiqueta({ idioma, aoConcluir }: { idioma: Idioma; aoConcluir?: () => void }) {
  const { t, ocupado, executar } = useExecutar(idioma);
  const [nome, setNome] = useState("");
  const [emConversas, setEmConversas] = useState(true);
  const [emContatos, setEmContatos] = useState(false);
  const pronto = nome.trim().length > 0 && (emConversas || emContatos) && !ocupado;

  function acrescentar() {
    if (!pronto) return;
    const acoes: Array<() => Promise<RespostaDeCuradoria>> = [];
    if (emConversas) acoes.push(() => criarTag("conversa", nome));
    if (emContatos) acoes.push(() => criarTag("contato", nome));
    executar(acoes, t("Etiqueta acrescentada."), () => {
      setNome("");
      aoConcluir?.();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="nova-etiqueta">{t("Acrescentar etiqueta")}</Label>
          <Input
            id="nova-etiqueta"
            value={nome}
            maxLength={40}
            placeholder={t("orçamento")}
            onChange={(e) => setNome(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                acrescentar();
              }
            }}
          />
        </div>
        <Button type="button" disabled={!pronto} onClick={acrescentar}>
          <Plus size={14} aria-hidden className="mr-1" />
          {t("Acrescentar")}
        </Button>
      </div>
      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">{t("Escolha onde ela aparece como sugestão para quem atende.")}</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={emConversas}
            onChange={(e) => setEmConversas(e.target.checked)}
          />
          {t("Sugerir em conversas")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={emContatos}
            onChange={(e) => setEmContatos(e.target.checked)}
          />
          {t("Sugerir em contatos")}
        </label>
        <span className="text-xs text-muted-foreground">
          {t("Escolha onde ela aparece como sugestão para quem atende.")}
        </span>
      </fieldset>
    </div>
  );
}

/** "Nova etiqueta" no cabeçalho da página: o formulário de acrescentar, num diálogo. */
export function NovaEtiqueta({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const [aberto, setAberto] = useState(false);
  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus size={14} aria-hidden className="mr-1" />
          {t("Nova etiqueta")}
        </Button>
      </DialogTrigger>
      {/* Sem descrição: a frase de escopo já está no formulário. */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("Nova etiqueta")}</DialogTitle>
        </DialogHeader>
        <AcrescentarEtiqueta idioma={idioma} aoConcluir={() => setAberto(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** A célula "Sugestão" de uma linha: um botão por escopo, com o estado e o clique dele. */
export function BotoesDeSugestao({
  tag,
  inventario,
  idioma,
}: {
  tag: string;
  inventario: InventarioDeTags;
  idioma: Idioma;
}) {
  const { t, ocupado, executar } = useExecutar(idioma);

  return (
    <div className="flex flex-wrap gap-1.5">
      {(["conversa", "contato"] as const).map((escopo) => {
        const estado = estadoNoEscopo(inventario, escopo, tag);
        const rotulo = escopo === "conversa" ? t("Conversas") : t("Contatos");
        const dica =
          estado === "sugerida"
            ? t("Sugerida para quem atende. Clique para arquivar.")
            : estado === "arquivada"
              ? t("Arquivada: não é mais sugerida. Clique para voltar a sugerir.")
              : t("Fora das sugestões. Clique para sugerir.");
        return (
          <button
            key={escopo}
            type="button"
            disabled={ocupado}
            title={dica}
            aria-label={`${rotulo}. ${dica}`}
            aria-pressed={estado === "sugerida"}
            onClick={() =>
              estado === "sugerida"
                ? executar([() => arquivarTag(escopo, tag, true)], t("Arquivada. Quem já tinha continua tendo."))
                : estado === "arquivada"
                  ? executar([() => arquivarTag(escopo, tag, false)], t("Voltou a ser sugerida."))
                  : executar([() => criarTag(escopo, tag)], t("Promovida a sugestão."))
            }
            className={cn(
              "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-60",
              estado === "sugerida" && "border-primary bg-primary/10 text-primary hover:bg-primary/15",
              estado === "arquivada" && "border-border bg-muted text-muted-foreground hover:text-foreground",
              estado === "fora" && "border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground",
            )}
          >
            {estado === "sugerida" && <Check size={12} aria-hidden />}
            {estado === "arquivada" && <Archive size={12} aria-hidden />}
            {estado === "fora" && <Plus size={12} aria-hidden />}
            {rotulo}
          </button>
        );
      })}
    </div>
  );
}
