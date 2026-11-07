"use client";

import { useState } from "react";

import { AbasDaInbox, type AbaComContagem } from "@/components/inbox/filtros/AbasDaInbox";
import type { InboxTab } from "@/components/inbox/InboxFilters";
import { MetaDaConversa } from "@/components/inbox/item/MetaDaConversa";
import { Badge } from "@/components/ui/badge";
import { BarraDeProgresso } from "@/components/ui/barra-de-progresso";
import { CartaoDeIndicador } from "@/components/ui/cartao-de-indicador";
import { Chip } from "@/components/ui/chip";
import { Pilula } from "@/components/ui/pilula";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import type { Comando } from "@/lib/inbox/comando-da-conversa";

import { Estados, Exemplo, Secao } from "../_componentes/Secao";
import type { Tema } from "../_componentes/tema";

const PRINCIPAIS: AbaComContagem[] = [
  { value: "unassigned", label: "Fila", count: 4 },
  { value: "mine", label: "Minhas", count: 12 },
  { value: "all", label: "Todas" },
];
const ESCONDIDAS: AbaComContagem[] = [
  { value: "ai", label: "Com a IA" },
  { value: "closed", label: "Fechadas" },
];

/**
 * Uma conversa de mentira só com o que `MetaDaConversa` lê. O componente é o
 * da lista da Inbox, sem cópia: as pílulas aqui são as de lá.
 */
function conversa(
  campos: Partial<Pick<ConversationWithContact, "passo_da_conversa" | "awaiting_since">>,
): ConversationWithContact {
  return {
    contacts: { tags: [], is_blocked: false, is_anonymized: false },
    instagram_entrada: null,
    passo_da_conversa: null,
    awaiting_since: null,
    ...campos,
  } as unknown as ConversationWithContact;
}

const ATENDENTE: Comando = { quem: "humano", userId: "eu", nome: "Ana" };

export function SecaoMarcadores({ tema }: { tema: Tema }) {
  const t = useT();
  const [agora] = useState(() => Date.now());
  const [ligados, setLigados] = useState<string[]>(["hoje"]);
  const minutosAtras = (m: number) => new Date(agora - m * 60_000).toISOString();
  const alterna = (k: string) =>
    setLigados((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));

  return (
    <Secao id={`indicadores-${tema}`} sub titulo={t("Indicadores e pílulas")} mapa="ds:indicadores" tema={tema} apoio={t("Pílula quadrada é estado. Tag arredondada é classificação. Chip é escolha (preenchido quando marcado).")}>
      <Exemplo nome={t("Chip (componente novo)")} mapa="comp:chip" tema={tema}>
        <Estados
          itens={[
            { rotulo: t("Desligado"), no: <Chip ligado={ligados.includes("amanha")} onClick={() => alterna("amanha")}>{t("Amanhã")}</Chip> },
            { rotulo: t("Ligado"), no: <Chip ligado={ligados.includes("hoje")} onClick={() => alterna("hoje")}>{t("Hoje")}</Chip> },
            { rotulo: t("Desativado"), no: <Chip disabled>14:30</Chip> },
          ]}
        />
      </Exemplo>
      <Exemplo nome={t("Pílulas da lista (MetaDaConversa)")} mapa="comp:pilula" tema={tema}>
        <Estados
          itens={[
            { rotulo: t("Espera curta"), no: <MetaDaConversa conversation={conversa({ awaiting_since: minutosAtras(4) })} comando={{ quem: "automatico" }} rotuloCanal={null} /> },
            { rotulo: t("Espera 10+ min"), no: <MetaDaConversa conversation={conversa({ awaiting_since: minutosAtras(14) })} comando={ATENDENTE} rotuloCanal={null} /> },
            { rotulo: t("Espera 30+ min"), no: <MetaDaConversa conversation={conversa({ awaiting_since: minutosAtras(42) })} comando={ATENDENTE} rotuloCanal={null} /> },
            { rotulo: t("IA"), no: <MetaDaConversa conversation={conversa({})} comando={{ quem: "automatico" }} mostrarAtendente rotuloCanal={null} /> },
            { rotulo: t("Fechada"), no: <MetaDaConversa conversation={conversa({})} comando={{ quem: "encerrada" }} mostrarAtendente rotuloCanal={null} /> },
            { rotulo: t("Sem dono"), no: <MetaDaConversa conversation={conversa({})} comando={{ quem: "aguardando" }} mostrarAtendente rotuloCanal={null} /> },
            { rotulo: t("Tarefa atrasada"), no: <MetaDaConversa conversation={conversa({ passo_da_conversa: "atrasada" })} comando={ATENDENTE} meuUserId="eu" rotuloCanal={null} /> },
          ]}
        />
      </Exemplo>
      <Exemplo nome="Pilula" mapa="comp:pilula" tema={tema}>
        <Estados
          itens={[
            { rotulo: t("Neutro"), no: <Pilula>{t("Rascunho")}</Pilula> },
            { rotulo: "Info", no: <Pilula tom="info">{t("Em teste")}</Pilula> },
            { rotulo: "Ok", no: <Pilula tom="ok">{t("Ativo")}</Pilula> },
            { rotulo: "Warn", no: <Pilula tom="warn">{t("Perto do limite")}</Pilula> },
            { rotulo: "Crit", no: <Pilula tom="crit">{t("Parado")}</Pilula> },
          ]}
        />
      </Exemplo>
      <Exemplo nome="CartaoDeIndicador" mapa="comp:card" tema={tema}>
        <div className="grid grid-cols-2 gap-3">
          <CartaoDeIndicador rotulo={t("Custo no período")} valor="US$ 38,20" explicacao={t("últimos 30 dias")} />
          <CartaoDeIndicador rotulo={t("Orçamento mensal de IA")} valor="38%">
            <BarraDeProgresso valor={38} rotulo={t("Orçamento mensal de IA")} />
          </CartaoDeIndicador>
        </div>
      </Exemplo>
      <Exemplo nome="Badge" mapa="comp:badge" tema={tema}>
        <div className="flex flex-wrap gap-2">
          <Badge>{t("Aberta")}</Badge>
          <Badge variant="neutral">{t("Fechada")}</Badge>
          <Badge variant="success">{t("Ganho")}</Badge>
          <Badge variant="warning">{t("Hoje")}</Badge>
          <Badge variant="error">{t("Atrasada")}</Badge>
          <Badge variant="info">{t("Lida")}</Badge>
          <Badge variant="outline">{t("Etiqueta")}</Badge>
        </div>
      </Exemplo>
    </Secao>
  );
}

/** O controle segmentado e as abas: a primeira metade de "Navegação e campos". */
export function SegmentadoEAbas({ tema }: { tema: Tema }) {
  const t = useT();
  const [aba, setAba] = useState<InboxTab>("unassigned");
  return (
    <>
      <Exemplo nome={t("Controle segmentado (AbasDaInbox)")} mapa="comp:segmentado" tema={tema}>
        <div className="w-80">
          <AbasDaInbox tab={aba} principais={PRINCIPAIS} escondidas={ESCONDIDAS} onChange={setAba} />
        </div>
      </Exemplo>
      <Exemplo nome="Tabs" mapa="comp:abas" tema={tema}>
        <Tabs defaultValue="resumo">
          <TabsList>
            <TabsTrigger value="resumo">{t("Resumo")}</TabsTrigger>
            <TabsTrigger value="negocios">{t("Negócios")}</TabsTrigger>
            <TabsTrigger value="atividade">{t("Atividade")}</TabsTrigger>
            <TabsTrigger value="off" disabled>
              {t("Desativado")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="resumo" className="text-ui text-text-muted">
            {t("Aba com sublinhado de 2px na marca, como o .tabs do quadro.")}
          </TabsContent>
        </Tabs>
      </Exemplo>
    </>
  );
}
