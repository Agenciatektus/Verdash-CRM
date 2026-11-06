"use client";

/**
 * A BARRA EM LOTE da tela de Tags: excluir, juntar e dar cor a várias etiquetas
 * de uma vez, a partir das caixas de seleção da tabela.
 *
 * ── O que é reaproveitado, e de onde ────────────────────────────────────────
 *
 * - A barra fixa no rodapé é a mesma régua visual da barra do Funil
 *   (`components/kanban/BulkActionBar.tsx`): `sticky bottom-4`, quebra em linhas
 *   em vez de vazar a largura do celular.
 * - Os blocos de 50 por pedido também são os do Funil (`LOTE_MAXIMO`), aqui
 *   `LOTE_MAXIMO_DE_ETIQUETAS`, vigiado pelo schema da rota.
 * - Excluir pede `AlertDialog` com os números na frente, como o excluir de uma
 *   etiqueta só. Juntar e cor abrem `Dialog`, porque são reversíveis.
 * - A rota (`POST /api/v1/tags/vocabulario/lote`) chama a MESMA função de banco
 *   da rota de uma etiqueta, com os mesmos portões.
 *
 * ── Por que os números do excluir em lote dizem "somadas" ───────────────────
 *
 * A tela só tem a contagem POR ETIQUETA. Um contato com `vip` e `obra` aparece
 * nas duas linhas; somar dá o total de marcações que saem, não o de registros
 * distintos. A frase diz isso em vez de prometer um número que ela não mediu.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Escolha } from "@/components/ui/escolha";
import { Label } from "@/components/ui/label";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { cn } from "@/lib/utils";
import { PALETA_DE_ETIQUETAS, NOME_DO_TOM } from "@/lib/tags/cor-da-etiqueta";
import { traduzir } from "@/lib/i18n/traducao";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  LOTE_MAXIMO_DE_ETIQUETAS,
  type AcaoEmLote,
  type LinhaDeVocabulario,
} from "@/lib/schemas/tags";

/** Cada recusa do servidor vira uma frase que diz O QUE FAZER. */
export const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira a etiqueta, o novo nome e a cor.",
  forbidden: "Só um gerente ou administrador da organização pode mudar as etiquetas.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  mfa_required: "Confirme o segundo fator para mudar as etiquetas.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  // 9038: a etiqueta `cliente` reservada pela regra da agenda.
  destino_inexistente:
    "Essa etiqueta não existe. Juntar só leva para uma etiqueta que já existe; para dar um nome novo, use Renomear.",
  etiqueta_do_sistema:
    "A etiqueta cliente é posta pelo sistema enquanto a regra Clientes pela agenda estiver ligada. Desligue-a em Tipos de agendamento para editá-la aqui.",
};

/**
 * A FILEIRA DOS OITO TONS, usada pela cor de uma etiqueta e pela cor em lote.
 *
 * O nome do tom é o rótulo acessível; a cor é reforço. Quem escolhe por "Âmbar"
 * e quem escolhe pelo círculo chegam ao mesmo lugar.
 */
export function FileiraDeTons({
  cor,
  aoEscolher,
  t,
}: {
  cor: string | null;
  aoEscolher: (cor: string | null) => void;
  t: (texto: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PALETA_DE_ETIQUETAS.map((tom) => (
        <button
          key={tom}
          type="button"
          onClick={() => aoEscolher(tom)}
          aria-pressed={cor === tom}
          aria-label={t(NOME_DO_TOM[tom] ?? tom)}
          title={tom}
          className={cn(
            "size-7 rounded-full border-2 transition-transform",
            cor === tom
              ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
              : "border-transparent hover:scale-110",
          )}
          style={{ backgroundColor: tom }}
        />
      ))}
      <Button
        type="button"
        size="sm"
        variant={cor === null ? "default" : "outline"}
        aria-pressed={cor === null}
        onClick={() => aoEscolher(null)}
      >
        {t("Sem cor")}
      </Button>
    </div>
  );
}

type Resultado = { concluidas: number; contatos: number; leads: number; conversas: number; regras: number };
type Recusa = { codigo: string; concluidas: number };

/**
 * Manda as etiquetas em blocos de `LOTE_MAXIMO_DE_ETIQUETAS`, em SEQUÊNCIA, e
 * para no primeiro bloco recusado. Exportada para o teste medir o corte.
 */
export async function aplicarEmBlocos(
  acao: AcaoEmLote,
  tags: string[],
  extra: { destino?: string; cor?: string | null },
): Promise<{ ok: true; total: Resultado } | { ok: false; total: Resultado; recusa: Recusa }> {
  const total: Resultado = { concluidas: 0, contatos: 0, leads: 0, conversas: 0, regras: 0 };
  for (let i = 0; i < tags.length; i += LOTE_MAXIMO_DE_ETIQUETAS) {
    const bloco = tags.slice(i, i + LOTE_MAXIMO_DE_ETIQUETAS);
    const resposta = await fetch("/api/v1/tags/vocabulario/lote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `destino` e `cor` só viajam na ação que fala deles: o schema recusa o
      // campo nas outras, como na rota de uma etiqueta.
      body: JSON.stringify({
        acao,
        tags: bloco,
        ...(acao === "juntar" ? { destino: extra.destino } : {}),
        ...(acao === "definir_cor" ? { cor: extra.cor ?? null } : {}),
      }),
    });
    const corpo = (await resposta.json().catch(() => null)) as
      | { data?: Partial<Resultado>; error?: { code?: string; details?: { concluidas?: number } } }
      | null;
    if (!resposta.ok) {
      const feitas = Number(corpo?.error?.details?.concluidas ?? 0);
      total.concluidas += feitas;
      return {
        ok: false,
        total,
        recusa: { codigo: corpo?.error?.code ?? "internal_error", concluidas: total.concluidas },
      };
    }
    const dados = corpo?.data ?? {};
    total.concluidas += Number(dados.concluidas ?? bloco.length);
    total.contatos += Number(dados.contatos ?? 0);
    total.leads += Number(dados.leads ?? 0);
    total.conversas += Number(dados.conversas ?? 0);
    total.regras += Number(dados.regras ?? 0);
  }
  return { ok: true, total };
}

export function BarraDeEtiquetasEmLote({
  selecionadas,
  destinos,
  idioma,
  onClear,
  aoConcluir,
}: {
  selecionadas: LinhaDeVocabulario[];
  /** Quem pode receber uma junção (a tela já tirou as reservadas). */
  destinos: LinhaDeVocabulario[];
  idioma: Idioma;
  onClear: () => void;
  /** Releitura da tela depois de qualquer mudança (cache das cores, nomes, lista). */
  aoConcluir: () => void;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const [aberto, setAberto] = useState<AcaoEmLote | null>(null);
  const [destino, setDestino] = useState("");
  const [cor, setCor] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (selecionadas.length === 0) return null;

  const n = selecionadas.length;
  const soma = (campo: "uso_em_contatos" | "uso_em_leads" | "uso_em_conversas" | "em_regras") =>
    selecionadas.reduce((acc, linha) => acc + Number(linha[campo] ?? 0), 0);
  const contatos = soma("uso_em_contatos");
  const leads = soma("uso_em_leads");
  const conversas = soma("uso_em_conversas");
  const regras = soma("em_regras");
  const tags = selecionadas.map((linha) => linha.tag);
  // Juntar precisa de pelo menos UMA origem que não seja o destino.
  const origensDaJuncao = tags.filter((tag) => tag.toLowerCase() !== destino.toLowerCase());

  function abrir(qual: AcaoEmLote) {
    setDestino("");
    setCor(null);
    setAberto(qual);
  }

  async function confirmar(qual: AcaoEmLote) {
    setOcupado(true);
    try {
      const alvo = qual === "juntar" ? origensDaJuncao : tags;
      const resultado = await aplicarEmBlocos(qual, alvo, { destino, cor });
      if (!resultado.ok) {
        // Parte pode ter sido aplicada: a tela RELÊ a lista em vez de ficar com
        // as linhas que já não existem, e o aviso diz quantas foram.
        toast.error(
          `${t(ERRO_EM_PORTUGUES[resultado.recusa.codigo] ?? "Não foi possível concluir agora. Tente de novo.")} ${t("Aplicadas antes da recusa:")} ${resultado.recusa.concluidas}.`,
        );
        if (resultado.recusa.concluidas > 0) aoConcluir();
        return;
      }
      const { total } = resultado;
      const registros = total.contatos + total.leads + total.conversas;
      // ⚠️ O DADO ENTRA FORA DO `t()` — `traduzir()` casa a string exata.
      if (qual === "excluir") {
        toast.success(
          `${t("Etiquetas excluídas:")} ${total.concluidas}. ${t("Removidas de")} ${registros} ${t("registro(s).")}`,
        );
      } else if (qual === "juntar") {
        toast.success(`${total.concluidas} ${t("etiqueta(s) juntada(s) em")} ${destino}.`);
      } else {
        toast.success(`${t("Cor atualizada em")} ${total.concluidas} ${t("etiqueta(s).")}`);
      }
      setAberto(null);
      onClear();
      aoConcluir();
    } catch {
      toast.error(
        t("Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo."),
      );
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <div
        data-lote-de-etiquetas={n}
        className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-md"
      >
        <span className="text-sm font-medium">
          {n} {t("etiqueta(s) selecionada(s)")}
        </span>
        <Button size="sm" variant="outline" onClick={() => abrir("definir_cor")} disabled={ocupado}>
          {t("Cor")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => abrir("juntar")} disabled={ocupado}>
          {t("Juntar")}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => abrir("excluir")} disabled={ocupado}>
          {t("Excluir")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={ocupado}>
          {t("Limpar seleção")}
        </Button>
      </div>

      <AlertDialog open={aberto === "excluir"} onOpenChange={(abrirDialogo) => !abrirDialogo && !ocupado && setAberto(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir")} {n} {t("etiqueta(s)?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("Somadas, elas estão em")} {contatos} {t("contato(s),")} {leads} {t("lead(s) e")}{" "}
              {conversas} {t("conversa(s).")}{" "}
              {t("Um registro com mais de uma delas conta uma vez para cada. Não dá para desfazer.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {regras > 0 && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {t("Atenção:")} {regras}{" "}
              {t(
                "regra(s) de agente continuam escrevendo estas etiquetas. Excluir aqui não apaga as regras: o agente vai recriar a etiqueta no próximo atendimento.",
              )}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ocupado}>{t("Cancelar")}</AlertDialogCancel>
            {/* Botão comum, e não `AlertDialogAction`: o Action fecha o diálogo
                no clique, antes de a resposta chegar — e um erro sairia com o
                diálogo já fechado, sem o "Aplicando..." no meio. */}
            <Button variant="destructive" onClick={() => void confirmar("excluir")} disabled={ocupado}>
              {ocupado ? t("Aplicando...") : `${t("Excluir")} ${n}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={aberto === "juntar"} onOpenChange={(abrirDialogo) => !abrirDialogo && !ocupado && setAberto(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Juntar")} {n} {t("etiqueta(s) em uma")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "As selecionadas passam a ser a etiqueta escolhida em contatos, leads, conversas e regras de agente.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="destino-da-juncao-em-lote">{t("Etiqueta de destino")}</Label>
            <Escolha
              id="destino-da-juncao-em-lote"
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
            </Escolha>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(null)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={() => void confirmar("juntar")}
              disabled={ocupado || destino.trim().length === 0 || origensDaJuncao.length === 0}
            >
              {ocupado ? t("Aplicando...") : t("Confirmar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aberto === "definir_cor"} onOpenChange={(abrirDialogo) => !abrirDialogo && !ocupado && setAberto(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Cor de")} {n} {t("etiqueta(s)")}
            </DialogTitle>
            <DialogDescription>{t("A mesma cor vale para todas as selecionadas.")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Label>{t("Cor da etiqueta")}</Label>
            <FileiraDeTons cor={cor} aoEscolher={setCor} t={t} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("Prévia:")}</span>
              <ChipDeEtiqueta tag={selecionadas[0]!.tag} cor={cor} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(null)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void confirmar("definir_cor")} disabled={ocupado}>
              {ocupado ? t("Aplicando...") : t("Confirmar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
