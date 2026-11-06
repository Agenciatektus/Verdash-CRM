"use client";
import { useCabeNoDesktop } from "@/hooks/ui/useCabeNoDesktop";
import { ehRotaDaInbox, menuRecolhido } from "@/lib/navigation/preferencia-do-menu";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, CaretDown, Gear } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { BarraEmDuasColunas } from "@/components/shell/BarraEmDuasColunas";
import { ContadorDeCasos } from "@/components/shell/ContadorDeCasos";
import { ContadorDaFila } from "@/components/shell/ContadorDaFila";
import { ContadorDeTarefas } from "@/components/shell/ContadorDeTarefas";
import { MarcaDaBarra } from "@/components/shell/MarcaDaBarra";
import { NoDeFunis } from "@/components/shell/NoDeFunis";
import { GRUPO_NO_RODAPE, sidebarGroups } from "@/lib/navigation/registry";
import type { FunilDoMenu } from "@/lib/navigation/funis-no-menu";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";

const CHAVE_GRUPOS_FECHADOS = "sidebar-grupos-fechados";
const ITEM_ATIVO = "bg-accent text-accent-foreground";
const ITEM_INATIVO = "text-muted-foreground hover:bg-accent/50 hover:text-foreground";

interface SidebarContentProps {
  onNavigate?: () => void;
  /**
   * Os funis da organizacao, para o no "Pipeline". Vem do layout (servidor):
   * a rota que os lista exige `manager` e esta barra e vista por todo papel.
   *
   * Opcional porque o `MobileSidebar` monta o mesmo conteudo — sem funis, o no
   * simplesmente nao aparece, e o caminho por "Funis" continua de pe.
   */
  funis?: readonly FunilDoMenu[];
}

/**
 * Navegação em UMA coluna, agrupada por objetivo: a gaveta do celular.
 *
 * O desktop passou a usar `BarraEmDuasColunas` (visual v2), e com isso esta
 * barra deixou de ter estado recolhido: a gaveta abre sempre inteira. Os ramos
 * de "recolhida" (rail de 64px, filete no lugar do título, contador em ponto)
 * saíram junto, porque nenhum caminho os alcançava mais.
 *
 * Não decide nada: `sidebarGroups()` (lib/navigation/registry.ts) resolve quais
 * grupos e destinos este papel vê, e este componente desenha.
 */
export function SidebarContent({ onNavigate, funis = [] }: SidebarContentProps) {
  // A barra lateral aparece em TODA tela — traduzi-la aqui é o que faz a
  // escolha de idioma virar algo visível no primeiro clique.
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  /**
   * O menu não prefetcha sozinho (#3170): um render RSC por link do menu (19
   * destinos × as duas instâncias, lateral e móvel), e eles disputam o servidor
   * com o render que o clique pediu. O prefetch passa a ser
   * por intenção (ponteiro/foco) — ver `hooks/navigation/prefetchPorIntencao.ts`.
   */
  const intencao = usePrefetchPorIntencao();
  const todos = sidebarGroups(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.modulos_ligados ?? [],
    activeOrg?.capacidades_ligadas ?? [],
  );
  // Configurações sai da área que rola e vai para o rodapé fixo: medido em
  // 1280x768, ele caía fora da dobra mesmo em telas de 1080px.
  const grupos = todos.filter((g) => g.group.id !== GRUPO_NO_RODAPE);
  const rodape = todos.find((g) => g.group.id === GRUPO_NO_RODAPE)?.group.hub;

  /**
   * Grupo fechado é preferência POR NAVEGADOR, não por conta: começa vazio (tudo
   * aberto) em toda renderização — servidor, primeira pintura do cliente e nos
   * testes, que nunca clicam em nada — e só muda depois do mount, se o
   * `localStorage` tiver algo salvo. Guardar o CONJUNTO DOS FECHADOS, e não dos
   * abertos, é o que faz "sem preferência salva" já significar "tudo aberto".
   */
  const [gruposFechados, setGruposFechados] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const salvo = window.localStorage.getItem(CHAVE_GRUPOS_FECHADOS);
      if (salvo) setGruposFechados(new Set(JSON.parse(salvo) as string[]));
    } catch {
      // Storage bloqueado (aba privada) — fica tudo aberto, que é o padrão.
    }
  }, []);
  function toggleGrupo(id: string) {
    setGruposFechados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(CHAVE_GRUPOS_FECHADOS, JSON.stringify([...next]));
      } catch {
        // Clique continua funcionando nesta sessão; só não sobrevive a um F5.
      }
      return next;
    });
  }

  return (
    <>
      <div className="flex h-14 items-center justify-start border-b px-4">
        <MarcaDaBarra compacta={false} />
      </div>
      {/*
        A DENSIDADE É MEDIDA, NÃO ESTÉTICA (histórico completo no git deste
        arquivo, antes do visual v2). Em resumo: um grupo abaixo da dobra é
        indistinguível de um grupo que não existe, então tela nova de grupo cheio
        vai para o HUB do grupo, nunca para densidade raspada. Cada linha custa
        32px (28px + 4px de `space-y-1`); trocar N destinos por um link de hub
        devolve (N-1)×32px. CRM, IA, Análise e Organização já têm hub.
      */}
      <nav className="flex-1 space-y-2 overflow-y-auto p-2" aria-label={t("Navegação principal")}>
        {grupos.map(({ group, items }) => {
          const tituloId = `nav-grupo-${group.id}`;
          const aberto = !gruposFechados.has(group.id);
          return (
            <div key={group.id} className="space-y-1">
              <h2 id={tituloId}>
                <button
                  type="button"
                  onClick={() => toggleGrupo(group.id)}
                  aria-expanded={aberto}
                  className="flex w-full items-center justify-between rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  {t(group.label)}
                  <CaretDown
                    size={12}
                    weight="bold"
                    className={cn("shrink-0 text-text-subtle transition-transform", !aberto && "-rotate-90")}
                    aria-hidden
                  />
                </button>
              </h2>
              {aberto && (
                <ul aria-labelledby={tituloId} className="space-y-1">
                  {items.map((item) => {
                    const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          {...intencao(item.href)}
                          aria-current={isActive ? "page" : undefined}
                          onClick={onNavigate}
                          className={cn(
                            "relative flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
                            isActive ? ITEM_ATIVO : ITEM_INATIVO,
                          )}
                        >
                          <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
                          <span className="truncate">{t(item.label)}</span>
                          {item.healthDot && <ConnectionHealthDot className="ml-auto" />}
                          {item.contador === "casos" && <ContadorDeCasos compacto={false} />}
                          {item.contador === "fila" && <ContadorDaFila compacto={false} />}
                          {item.contador === "tarefas" && <ContadorDeTarefas />}
                        </Link>
                      </li>
                    );
                  })}

                  {/* O nó "Pipeline" (ver `NoDeFunis.tsx`): só no grupo do CRM. */}
                  {group.id === "crm" && (
                    <NoDeFunis
                      funis={funis}
                      pathname={pathname}
                      onNavigate={onNavigate}
                      classeAtiva={ITEM_ATIVO}
                      classeInativa={ITEM_INATIVO}
                    />
                  )}

                  {group.hub && (
                    <li>
                      <Link
                        href={group.hub.href}
                        {...intencao(group.hub.href)}
                        aria-current={pathname === group.hub.href ? "page" : undefined}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
                          pathname === group.hub.href ? ITEM_ATIVO : ITEM_INATIVO,
                        )}
                      >
                        <ArrowRight size={18} aria-hidden />
                        <span className="truncate">{t(group.hub.label)}</span>
                      </Link>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t p-2">
        {rodape && (
          <Link
            href={rodape.href}
            {...intencao(rodape.href)}
            aria-current={pathname.startsWith(rodape.href) ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "mb-1 flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
              pathname.startsWith(rodape.href) ? ITEM_ATIVO : ITEM_INATIVO,
            )}
          >
            <Gear size={18} aria-hidden />
            <span className="truncate">{t(rodape.label)}</span>
          </Link>
        )}
      </div>
    </>
  );
}

export function Sidebar({
  collapsed: recolhidoGeral,
  fixoNaInbox = false,
  funis,
}: {
  collapsed: boolean;
  fixoNaInbox?: boolean;
  funis?: readonly FunilDoMenu[];
}) {
  const pathname = usePathname();
  const cabe = useCabeNoDesktop();
  const naInbox = ehRotaDaInbox(pathname);
  // Na Inbox o menu começa recolhido; abaixo de 1024px nunca fixa (quadro DS).
  const collapsed = !cabe || menuRecolhido({ pathname, recolhidoGeral, fixoNaInbox });
  return (
    <aside
      className={cn(
        // ⚠️ `sticky`, e NUNCA `fixed`.
        //
        // Com `fixed` a barra sai do fluxo: ela não ocupa lugar nenhum na linha,
        // e quem afastava o conteúdo era um `md:ml-16`/`md:ml-60` do lado de lá.
        // Duas medidas para a mesma coisa, em componentes diferentes — e no dia
        // em que discordassem (largura de 60 com margem de 16), a barra passava
        // POR CIMA da lista de conversas, escondendo o começo de cada linha.
        //
        // Foi assim que apareceu numa instalação real: a barra expandida, com as
        // etiquetas legíveis, e a lista atrás dela cortada. Um F5 "consertava",
        // que é a assinatura de servidor e navegador terem pintado estados
        // diferentes — e `AppShell` e `Sidebar` são ambos `"use client"`.
        //
        // `sticky top-0 h-dvh` dá o mesmo efeito visual (a barra não rola com
        // a página) e ela VOLTA a ocupar lugar: sobra para o conteúdo exatamente
        // o que ela não usou, e não há segunda medida para discordar.
        //
        // `h-dvh` e não `h-screen`: `100vh` é a janela com a barra de endereço
        // RECOLHIDA, e o navegador nunca corrige esse valor. No tablet entre 768
        // e 1023px — onde esta barra JÁ aparece, porque a casca a mostra a partir
        // de `md` — a barra media mais que a janela e o fim dela ficava fora do
        // alcance. `dvh` acompanha a barra do navegador aparecendo e sumindo.
        // Princípio 2 de `docs/design-system/screen-flow/07-responsive-strategy.md`.
        //
        // `shrink-0` porque item de flex encolhe por padrão, e uma barra de 60
        // espremida para caber é o mesmo defeito por outro caminho.
        //
        // Duas colunas (`BarraEmDuasColunas`): 72px de trilho, mais 232px da
        // coluna do grupo quando expandida. Recolhida, a coluna abre POR CIMA do
        // conteúdo ("peek"), presa dentro desta `<aside>`, e a largura que a
        // casca enxerga continua sendo uma só: a desta caixa.
        "sticky top-[var(--faixas-de-cima,0px)] z-30 flex h-[calc(100dvh-var(--faixas-de-cima,0px))] shrink-0 flex-col bg-transparent transition-[width] duration-base",
        collapsed ? "w-[72px]" : "w-[304px] max-lg:w-[72px]",
      )}
    >
      <BarraEmDuasColunas
        collapsed={collapsed}
        escopo={naInbox ? "inbox" : "geral"}
        podeFixar={cabe}
        funis={funis}
        marca={<MarcaDaBarra compacta={false} />}
      />
    </aside>
  );
}
