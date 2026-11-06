"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePedidoDeCriar } from "@/lib/mobile/usePedidoDeCriar";
import { usePodeCriar } from "@/lib/mobile/usePodeCriar";
import { useT } from "@/hooks/i18n/useT";
import { Plus, DownloadSimple, UploadSimple, UsersThree, ArrowsClockwise } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useBulkContacts, type AcaoEmLoteDeContatos } from "@/hooks/contacts/useBulkContacts";
import { useSelecaoEmLote } from "@/hooks/contacts/useSelecaoEmLote";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { BarraDeContatosEmLote } from "@/components/contacts/BarraDeContatosEmLote";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { ImportContactsDialog } from "@/components/contacts/ImportContactsDialog";
import { SyncPhoneContactsDialog } from "@/components/contacts/SyncPhoneContactsDialog";
import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";
import { queryDaExportacao, type FormatoDeExport } from "@/lib/contacts/exportar";
import { roleAtLeast } from "@/lib/auth/types";
import { ORIGEM_AGENDA_DO_CELULAR } from "@/lib/leads/origem-do-contato";
import { type ModoDeEtiqueta } from "@/lib/inbox/marcador-da-conversa";
import { useActiveOrg, usePermission } from "@/hooks/auth/AuthProvider";
import { MergeDialog } from "@/components/contacts/MergeDialog";
import { EmptyContacts } from "@/components/empty";
import {
  BarraDeFiltros,
  BotaoDaTela,
  CabecalhoDaPagina,
  EstadoDaLista,
  Pagina,
  TabelaOuCartoes,
} from "@/components/pagina";

import { CartaoDoContato } from "./_components/CartaoDoContato";
import { FiltroDeEtiquetas } from "./_components/FiltroDeEtiquetas";
import type { ContactOrderBy } from "@/lib/schemas/contacts";

const SOURCE_OPTIONS = [
  { value: undefined, label: "Todas as origens" },
  { value: "manual", label: "Manual" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "site", label: "Site (landing page)" },
  { value: "nuvemshop", label: "Nuvemshop" },
  { value: "import_csv", label: "Importado (CSV)" },
  { value: ORIGEM_AGENDA_DO_CELULAR, label: "Agenda do celular" },
  // Os dois valores que a atribuição de anúncio grava em `contacts.source`
  // (`PlataformaDeAnuncio` em lib/leads/atribuicao-de-anuncio.ts). Sem eles, o
  // contato que veio de um clique em anúncio existe no banco e não é
  // alcançável por nenhum filtro desta tela. O handler aceita qualquer valor
  // (`_handler.ts:167` faz `eq("source", q.source)`), então a lista é a única
  // porta — e ela estava incompleta desde que a atribuição passou a existir.
  { value: "meta_ads", label: "Anúncio da Meta" },
  { value: "google_ads", label: "Anúncio do Google" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function ContactsListClient() {
  const t = useT();
  const orgAtiva = useActiveOrg();
  const clientesLigado = orgAtiva?.cliente_pela_agenda === true;
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // VÁRIAS etiquetas com E/OU (#1274). O estado é a LISTA, e uma etiqueta só é
  // a lista de um — o que faz "nenhuma escolha" e "vip escolhida" passarem pelo
  // mesmo caminho, e impede a segunda forma de nascer daqui.
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<ModoDeEtiqueta | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  // Só pessoais (spec 21, etapa 15 — filtro "Pessoais"): ligado lista SÓ
  // pessoais (`?pessoais=true`, etapa 13); desligado é o padrão que exclui.
  const [soPessoais, setSoPessoais] = useState(false);
  const [orderBy, setOrderBy] = useState<ContactOrderBy>("last_activity_at");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState<number>(25);
  const [createOpen, setCreateOpen] = useState(false);
  // O "+" do celular (aba Conversas) chega com `?criar=1`.
  const podeCriar = usePodeCriar();
  usePedidoDeCriar(() => setCreateOpen(true), podeCriar);
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [duplicadosOpen, setDuplicadosOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo(
    () => ({
      search,
      tag: tags.length > 0 ? tags : undefined,
      tagMode,
      source,
      pessoais: soPessoais || undefined,
      order_by: orderBy,
      order_dir: orderDir,
      limit,
    }),
    [search, tags, tagMode, source, soPessoais, orderBy, orderDir, limit],
  );
  const q = useContactList(filters);

  // LOTE (#2484, fatia F3): a seleção múltipla e a barra de ações dos contatos.
  // O portão de tela é o MESMO piso da edição individual (`contact.update` —
  // agent+); quem só lê nem vê a barra. (A rota ainda valida por conta própria:
  // este portão é de tela, a fonte da regra é a API.)
  const podeAgirEmLote = usePermission("contact.update");
  const podeMudarResponsavel = usePermission("contact.carteira");
  const selecao = useSelecaoEmLote();
  const lote = useBulkContacts();

  const rodarLote = useCallback(
    (args: AcaoEmLoteDeContatos) => {
      const ids = Array.from(selecao.selecionados);
      if (ids.length === 0) return;
      lote.mutate(
        { ids, ...args },
        {
          // A seleção é limpa depois do lote, aconteça o que acontecer: manter
          // marcados os contatos recusados (de outra organização, inexistentes)
          // deixaria a barra no lugar mensageando um lote que não existe mais.
          onSuccess: () => selecao.limpar(),
        },
      );
    },
    [lote, selecao],
  );

  const allContacts = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allContacts) for (const tag of c.tags) set.add(tag);
    // `cliente` na lista mesmo que nenhum contato da página carregada a tenha —
    // COM A REGRA LIGADA. As demais opções saem do que já foi paginado — o que
    // basta para etiqueta que a equipe criou e usa em bloco, e falha justamente
    // para esta, que o sistema escreve sozinho e cujo primeiro uso é "filtrar
    // quem já é cliente" numa base grande, onde a primeira página pode não ter
    // nenhum. Desligada, a opção fixa ofereceria um filtro de uma regra que não
    // roda; quem já tem a etiqueta continua aparecendo pela linha de cima.
    if (clientesLigado) set.add(TAG_DE_CLIENTE);
    return Array.from(set).sort();
  }, [allContacts, clientesLigado]);

  const handleSort = useCallback(
    (column: ContactOrderBy) => {
      if (column === orderBy) {
        setOrderDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setOrderBy(column);
        setOrderDir(column === "display_name" ? "asc" : "desc");
      }
    },
    [orderBy],
  );

  // O MESMO gate da rota (`requireRole("manager")`): um botão que só devolve
  // 403 é armadilha — quem tem papel de leitura nem vê a porta.
  const podeExportar = roleAtLeast(orgAtiva?.role, "manager");

  /**
   * Exportar é exportar o QUE A TELA ESTÁ MOSTRANDO: os mesmos filtros da lista
   * viajam na query (busca, etiquetas em E/OU, origem, pessoais), sem `cursor`
   * nem `limit` — o arquivo é o conjunto filtrado inteiro, não a página que a
   * pessoa rolou até aqui.
   */
  const exportar = useCallback(
    (formato: FormatoDeExport) => {
      const qs = queryDaExportacao(formato, {
        search,
        tags,
        tagMode,
        source,
        pessoais: soPessoais,
        order_by: orderBy,
        order_dir: orderDir,
      });
      // `Content-Disposition: attachment` na resposta faz o navegador baixar,
      // não navegar — o mesmo gesto do "Exportar CSV" da tela de auditoria.
      window.location.href = `/api/v1/contacts/export?${qs}`;
    },
    [search, tags, tagMode, source, soPessoais, orderBy, orderDir],
  );

  return (
    <Pagina>
      <CabecalhoDaPagina
        titulo={t("Contatos")}
        descricao={t("Customer 360 — busque, filtre e gerencie contatos.")}
        acoes={
          <>
            {/* Duplicados mora AQUI, na lista: quem descobre contato repetido descobre
                olhando a lista. `shrink-0` (PR #267): numa tela estreita os rótulos
                não se comprimem. */}
            <Button variant="outline" className="shrink-0" onClick={() => setDuplicadosOpen(true)}>
              <UsersThree size={16} weight="bold" aria-hidden />
              <span>{t("Duplicados")}</span>
            </Button>
            <Button variant="outline" className="shrink-0" onClick={() => setImportOpen(true)}>
              <UploadSimple size={16} weight="bold" aria-hidden />
              <span>{t("Importar CSV")}</span>
            </Button>
            {/* O lado de cá do mesmo gesto (#2736): a base que a equipe já tem mora na
                agenda do celular pareado, e ela não passa por CSV nenhum. */}
            <Button variant="outline" className="shrink-0" onClick={() => setSyncOpen(true)}>
              <ArrowsClockwise size={16} weight="bold" aria-hidden />
              <span>{t("Sincronizar agenda")}</span>
            </Button>
            {/* A porta de VOLTA do mesmo dado (#2759): CSV e vCard num menu, para o
                cabeçalho não dobrar de largura no celular. */}
            {podeExportar && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="shrink-0">
                    <DownloadSimple size={16} weight="bold" aria-hidden />
                    <span>{t("Exportar")}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => exportar("csv")}>{t("Exportar CSV")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportar("vcf")}>{t("Exportar vCard")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button className="mb:hidden" onClick={() => setCreateOpen(true)}>
              <Plus size={16} weight="bold" aria-hidden />
              <span>{t("Novo contato")}</span>
            </Button>
          </>
        }
      />

      <BarraDeFiltros
        busca={{ valor: searchInput, aoMudar: setSearchInput, placeholder: t("Buscar por nome, email ou telefone…") }}
        ativos={(tags.length > 0 ? 1 : 0) + (source ? 1 : 0) + (soPessoais ? 1 : 0)}
        aoLimpar={() => {
          setSearchInput("");
          setSearch("");
          setTags([]);
          setTagMode(undefined);
          setSource(undefined);
          setSoPessoais(false);
        }}
      >
        <FiltroDeEtiquetas
          tags={tags}
          setTags={setTags}
          tagMode={tagMode}
          setTagMode={setTagMode}
          tagOptions={tagOptions}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t(SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? "Origem")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SOURCE_OPTIONS.map((s) => (
              <DropdownMenuItem key={s.label} onClick={() => setSource(s.value)}>
                {t(s.label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Só pessoais: o filtro que acha quem saiu da operação — e a porta do
            desmarcar em lote mental (abre a ficha e desmarca um a um). O
            `data-testid` é contrato do e2e da spec. */}
        <Button
          variant={soPessoais ? "default" : "outline"}
          size="sm"
          data-testid="filtro-pessoais"
          aria-pressed={soPessoais}
          onClick={() => setSoPessoais((v) => !v)}
        >
          {t("Pessoais")}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {limit} {t("por página")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Itens por página")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PAGE_SIZE_OPTIONS.map((n) => (
              <DropdownMenuItem key={n} onClick={() => setLimit(n)}>
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

      </BarraDeFiltros>

      {podeAgirEmLote && (
        <BarraDeContatosEmLote
          quantidade={selecao.quantidade}
          pendente={lote.isPending}
          onAdicionarEtiqueta={(tag) => rodarLote({ action: "tag", op: "add", tag })}
          onRemoverEtiqueta={(tag) => rodarLote({ action: "tag", op: "remove", tag })}
          onMudarResponsavel={
            podeMudarResponsavel
              ? (donoUserId) =>
                  rodarLote({ action: "carteira", dono_user_id: donoUserId, origem: "manual" })
              : undefined
          }
          onPreencherCampo={(chave, valor) => rodarLote({ action: "custom-field", chave, valor })}
          onLimpar={selecao.limpar}
        />
      )}

      <EstadoDaLista
        carregando={q.isLoading}
        erro={q.isError ? t("Erro ao carregar contatos.") : null}
        aoTentarDeNovo={() => q.refetch()}
        quantidade={allContacts.length}
        vazio={<EmptyContacts />}
      >
        <TabelaOuCartoes
          itens={allContacts}
          chave={(c) => c.id}
          rotulo={t("Contatos")}
          tabela={
            <ContactsTable
              contacts={allContacts}
              orderBy={orderBy}
              orderDir={orderDir}
              onSort={handleSort}
              // Sem `contact.update` não há barra, então as caixas seriam um
              // controle que marca e não leva a nada: a tabela só as desenha
              // quando recebe `onAlternarSelecao`.
              selecionados={podeAgirEmLote ? selecao.selecionados : undefined}
              onAlternarSelecao={podeAgirEmLote ? selecao.alternar : undefined}
              onSelecionarTodosVisiveis={
                podeAgirEmLote
                  ? () => selecao.selecionarTodos(allContacts.map((c) => c.id))
                  : undefined
              }
            />
          }
          cartao={(c) => <CartaoDoContato contato={c} />}
        />
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between mb:px-4">
          <p className="text-sm text-muted-foreground">
            {allContacts.length} {allContacts.length === 1 ? t("contato") : t("contatos")}
            {q.hasNextPage ? ` ${t("carregados — há mais resultados")}` : ""}
          </p>
          {q.hasNextPage && (
            <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          )}
        </div>
      </EstadoDaLista>

      {podeCriar && <BotaoDaTela rotulo={t("Novo contato")} aoTocar={() => setCreateOpen(true)} />}

      <NewContactDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />
      <SyncPhoneContactsDialog open={syncOpen} onOpenChange={setSyncOpen} />
      <MergeDialog open={duplicadosOpen} onOpenChange={setDuplicadosOpen} />
    </Pagina>
  );
}
