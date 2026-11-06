"use client";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { TETO_DO_TERMO_DE_BUSCA } from "@/lib/inbox/termo-de-busca";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import type { ModoDeEtiqueta } from "@/lib/inbox/marcador-da-conversa";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";

import { AbasDaInbox } from "./filtros/AbasDaInbox";
import { useListaCompacta } from "@/hooks/ui/useListaCompacta";
import { ChipsDeFiltro, type ChipDeFiltro } from "./filtros/ChipsDeFiltro";
import { PopoverDeFiltros } from "./filtros/PopoverDeFiltros";
import { SeletorDeEtiqueta } from "./filtros/SeletorDeEtiqueta";
import { useOpcoesDeEtiqueta } from "./filtros/useOpcoesDeEtiqueta";
import { chipsDosFiltros } from "./filtros/chipsDosFiltros";
import { ABAS_PRINCIPAIS, INBOX_TABS, visibleInboxTabs, type InboxTab } from "./filtros/abas-da-inbox";
import {
  ChipDaFolhaDeFiltros,
  FiltrosDaInboxNoCelular,
  tiposDeCanalDisponiveis,
} from "@/components/mobile/telas/Conversas";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import type { TipoDeCanal } from "@/lib/inbox/tipo-de-canal";
import type { EscolhaDoAtendimento } from "@/lib/inbox/filtros-do-atendimento";
import { FiltrosDoAtendimento, useNomesDoAtendimento } from "./filtros/FiltrosDoAtendimento";

export { visibleInboxTabs, type InboxTab } from "./filtros/abas-da-inbox";

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
  /** O TIPO de canal (folha de filtros do celular, migration 9049). */
  canal?: TipoDeCanal;
  /** De que ENTRADA do Instagram: `direct` | `comentario`. */
  entrada?: string;
  /**
   * A etiqueta escolhida, ou VÁRIAS (#1274). `string` continua aceito e
   * significando a MESMA coisa: é o que o `InboxLayout`, o deep-link e qualquer
   * chamada antiga produzem.
   */
  tag?: string | readonly string[];
  /** E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão. */
  tagMode?: ModoDeEtiqueta;
  /** O filtro "Só grupos" (Task 10): manda `is_group=true` na listagem. */
  onlyGroups?: boolean;
  /** "Sem próximo passo" (L4, migration 9047): manda `sem_passo=true`. */
  semPasso?: boolean;
  /** Funil, etapas, responsável e período da última mensagem (migration 9051). */
  atendimento?: EscolhaDoAtendimento;
}

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
}

export function InboxFilters({ value, onChange }: Props) {
  const t = useT();
  const [searchInput, setSearchInput] = useState(value.search);
  const celular = useEhCelular();
  /**
   * O campo escuta o valor de FORA, e só ele.
   *
   * O estado do campo é próprio porque o debounce mora nele. O preço era não
   * saber quando o filtro morria por outro caminho: "Limpar filtros" zerava a
   * busca aplicada e deixava o termo escrito na tela.
   *
   * A ref guarda o que ESTE campo propagou. Valor de fora diferente dela = a
   * mudança veio de outro lugar, e o campo adota. Igual = foi o próprio campo, e
   * adotar atropelaria quem continuou digitando.
   *
   * ⚠️ Tirar este efeito reprova o primeiro caso de
   * `tests/unit/limpar-filtros-limpa-o-campo.test.tsx` (medido). A marca no
   * timer, lá embaixo, defende uma corrida que nenhum teste determinístico
   * alcança: sabotá-la deixa os dois casos verdes. Fica escrito em vez de fingir
   * cobertura.
   */
  const propagado = useRef(value.search);
  useEffect(() => {
    if (value.search !== propagado.current) {
      propagado.current = value.search;
      setSearchInput(value.search);
    }
  }, [value.search]);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  const { activeOrg, user } = useAuth();
  const [listaCompacta, setListaCompacta] = useListaCompacta(user?.id);
  const orgId = activeOrg?.orgId ?? null;
  const { etiquetas, opcoesDoSeletor, mostrarSeletorDeTag } = useOpcoesDeEtiqueta(orgId, value.tag);
  // Os MESMOS filtros que a lista aplicou. Badge que conta o que a aba não mostra
  // manda o atendente procurar trabalho que não existe.
  const { data: counts } = useConversationCounts(orgId, {
    unread: value.onlyUnread,
    semPasso: value.semPasso,
    tag: etiquetas,
    tagMode: value.tagMode,
    channel_session_id: value.channel_session_id,
    // Sem isto o atendente filtra "só comentários" e lê nas abas o número de
    // TODAS as conversas: badge maior que a lista, e nada dizendo por quê.
    entrada: value.entrada,
    // A folha do celular (9049): o mesmo tipo de canal e o "só grupos" da lista.
    canal: value.canal,
    soGrupos: value.onlyGroups,
    atendimento: value.atendimento,
  });

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((t) => t.value);
  const countFor: Partial<Record<InboxTab, number>> = {
    // `fila` é o nome novo; `unassigned` é o alias que a rota versionada mantém.
    // O `??` cobre a janela em que a página ainda lê um cache gravado antes do
    // deploy: sem ele o badge sumiria por alguns segundos.
    unassigned: counts?.fila ?? counts?.unassigned,
    // A aba do automático mostra o que o robô conduz. Um número que existe na
    // API e não aparece na tela é trabalho feito que ninguém vê.
    ai: counts?.automatico,
    mine: counts?.mine,
    all: counts?.all,
    closed: counts?.closed,
    archived: counts?.archived,
  };
  const abas = tabs.map((value) => ({
    value,
    label: INBOX_TABS.find((x) => x.value === value)!.label,
    count: countFor[value],
  }));

  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox num subconjunto sem nada dizendo que há filtro. O
  // número some do seletor junto com o canal, e o seletor inteiro sumiria com
  // ele se sobrasse menos de dois.
  const filtroForaDaLista =
    value.channel_session_id != null &&
    channels != null &&
    !channels.some((c) => c.id === value.channel_session_id);
  // O seletor de número só aparece com 2+ números: com um só não há o que alternar.
  const showChannelSwitch = (channels?.length ?? 0) >= 2 || filtroForaDaLista;
  // O de ENTRADA só com Instagram conectado. O `|| value.entrada != null` é a
  // mesma válvula da etiqueta: desconectar a conta não pode sumir com o
  // controle e deixar o filtro AINDA APLICADO.
  const mostrarSeletorDeEntrada =
    (channels?.some((c) => c.provider === "instagram") ?? false) || value.entrada != null;

  const alternaEtiqueta = (tag: string) => {
    const escolhida = etiquetas.includes(tag);
    const proximas = escolhida ? etiquetas.filter((t) => t !== tag) : [...etiquetas, tag];
    onChange({
      ...value,
      tag: proximas.length === 0 ? undefined : proximas,
      // O `modo` só faz sentido com DUAS: ao voltar para uma etiqueta só, ele
      // sai, porque `?tag=vip&modo=ou` não significa nada e polui a chave de cache.
      tagMode: proximas.length > 1 ? value.tagMode : undefined,
    });
  };

  // Os chips nomeiam o que o popover ligou, cada um com o seu "x".
  const nomeDoCanal = filtroForaDaLista
    ? t("Número removido")
    : (() => {
        const canal = channels?.find((c) => c.id === value.channel_session_id);
        return canal ? channelLabel(canal) : t("Número de WhatsApp");
      })();
  const nomes = useNomesDoAtendimento(value.atendimento);
  const chips: ChipDeFiltro[] = chipsDosFiltros({ value, onChange, t, nomeDoCanal, etiquetas, alternaEtiqueta, nomes });
  const tiposDeCanal = tiposDeCanalDisponiveis((channels ?? []).map((c) => c.provider));
  const limparDoPopover = () =>
    onChange({
      ...value,
      onlyUnread: false,
      onlyGroups: false,
      semPasso: false,
      channel_session_id: undefined,
      tag: undefined,
      tagMode: undefined,
      entrada: undefined,
      canal: undefined,
      atendimento: undefined,
    });

  // O timer lê o valor MAIS RECENTE, não o do render em que foi agendado. Antes a
  // closure capturava `value` inteiro (`tab` incluso): digitar e trocar de aba em
  // menos de 250 ms devolvia o operador à aba anterior. As refs mantêm
  // `[searchInput]` como única dependência sem pagar o preço da closure velha.
  const valorRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // Num efeito, e não no corpo do render: escrever em ref durante a renderização
  // é proibido pela regra `react-hooks/refs`.
  useEffect(() => {
    valorRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      const atual = valorRef.current;
      if (searchInput !== atual.search) {
        // Marca ANTES de propagar: ver o aviso no efeito de sincronização acima.
        propagado.current = searchInput;
        onChangeRef.current({ ...atual, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // O filtro do desktop; no celular ele fica dentro da folha (`FolhaDeFiltros`), para
  // número de WhatsApp, etiquetas e entrada do Instagram.
  const filtros = () => (
    <PopoverDeFiltros
      value={value}
      onChange={onChange}
      ativos={chips.length}
      channels={channels}
      showChannelSwitch={showChannelSwitch}
      filtroForaDaLista={filtroForaDaLista}
      mostrarSeletorDeEntrada={mostrarSeletorDeEntrada}
      seletorDeEtiqueta={
        mostrarSeletorDeTag ? (
          <SeletorDeEtiqueta
            etiquetas={etiquetas}
            opcoes={opcoesDoSeletor}
            tagMode={value.tagMode}
            onAlternar={alternaEtiqueta}
            onLimpar={() => onChange({ ...value, tag: undefined, tagMode: undefined })}
            onModo={(modo) => onChange({ ...value, tagMode: modo })}
          />
        ) : null
      }
      atendimento={<FiltrosDoAtendimento value={value} onChange={onChange} tiposDeCanal={tiposDeCanal} mostrarTipoDeCanal={!celular} />}
    />
  );

  return (
    <>
    <div className="hidden flex-col gap-2.5 border-b border-border bg-surface px-3.5 pb-2.5 pt-3.5 largo:flex">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-elevated pl-3 pr-1 transition-colors focus-within:border-accent focus-within:bg-background focus-within:ring-2 focus-within:ring-accent-soft">
        <MagnifyingGlass size={15} weight="regular" className="shrink-0 text-text-subtle" aria-hidden />
        {/* "última mensagem", e não só "mensagem": a busca alcança apenas
            `conversations.last_message_preview` (a ÚLTIMA mensagem, truncada em
            200 caracteres na ingestão). Medido numa conversa real de 32
            mensagens: buscar o que o cliente pediu na 3ª devolve ZERO. Até o
            histórico entrar na busca, a tela não promete o que o backend não faz. */}
        <input
          type="search"
          // O teto das rotas de busca: sem ele, cada tecla além de 100 virava um
          // toast de erro (P2 do Cassio na #154).
          maxLength={TETO_DO_TERMO_DE_BUSCA}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("Nome, telefone ou última mensagem")}
          className="h-full min-w-0 flex-1 bg-transparent text-sm mb:text-[16px] text-text outline-hidden placeholder:text-text-subtle"
          aria-label={t("Buscar conversas")}
        />
        {filtros()}
      </div>

      <AbasDaInbox
        tab={value.tab}
        principais={abas.filter((a) => ABAS_PRINCIPAIS.includes(a.value))}
        escondidas={abas.filter((a) => !ABAS_PRINCIPAIS.includes(a.value))}
        onChange={(tab) => onChange({ ...value, tab })}
        compacta={{ ligada: listaCompacta, onChange: setListaCompacta }}
      />

      <ChipsDeFiltro chips={chips} onLimpar={limparDoPopover} />
    </div>
    {/* Abaixo de 760px, o topo da lista do protótipo mobile. Só monta no celular: uma
        segunda cópia dos controles no desktop seria outro "Filtros" no leitor de tela. */}
    {celular && (
      <FiltrosDaInboxNoCelular
        tab={value.tab}
        semPasso={!!value.semPasso}
        abas={abas}
        onTab={(tab) => onChange({ ...value, tab })}
        onSemPasso={(semPasso) => onChange({ ...value, semPasso })}
        filtro={
          <ChipDaFolhaDeFiltros
            ativos={chips.length}
            folha={{
              value,
              onChange,
              abas,
              tiposDeCanal,
              maisFiltros: filtros(),
              aoLimpar: limparDoPopover,
            }}
          />
        }
        chipsAtivos={<ChipsDeFiltro chips={chips} onLimpar={limparDoPopover} />}
        busca={value.search}
        onLimparBusca={() => onChange({ ...value, search: "" })}
      />
    )}
    </>
  );
}
