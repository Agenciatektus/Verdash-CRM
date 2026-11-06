"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { NAV_GROUPS } from "@/lib/navigation/registry";
import { destinoDaRota } from "@/lib/navigation/rota-atual";

import { AguardandoResposta } from "./AguardandoResposta";
import { AlertsBell } from "./AlertsBell";
import { AvisoDePropostaEmDestaque } from "./AvisoDePropostaEmDestaque";
import { BotaoDeDisponibilidade } from "./BotaoDeDisponibilidade";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

/**
 * "Grupo › Página" da rota atual, pelo MESMO registro que monta a barra lateral
 * (`destinoDaRota`, destino de `href` mais longo que casa). Com a barra em duas
 * colunas, a coluna do grupo pode estar mostrando outro grupo (ou nem aparecer,
 * recolhida); a trilha é o lugar fixo que diz onde a pessoa está.
 *
 * Sem destino que case (quadro de um funil, onboarding) não há trilha: inventar
 * um rótulo ali seria dizer o nome de uma tela que o registro não conhece.
 * Escondida abaixo de `md`, onde o cabeçalho já disputa espaço com a busca.
 */
function TrilhaDaRota() {
  const t = useT();
  const pathname = usePathname();
  const destino = destinoDaRota(pathname);
  const grupo = destino ? NAV_GROUPS.find((g) => g.id === destino.group) : undefined;
  if (!destino || !grupo) return null;
  // O grupo leva ao hub dele ("Ver tudo em ..."); grupo sem hub (Conversas,
  // Canais) não tem página própria, e apontar a primeira tela do grupo seria
  // apontar uma tela que o papel da pessoa pode não ver. Fica texto.
  const hrefDoGrupo = grupo.hub?.href;
  // Dentro de uma tela (o detalhe de uma campanha, de um caso), a tela que a
  // contém deixa de ser a página atual e vira o caminho de volta.
  const naPropriaTela = pathname === destino.href;
  return (
    <nav aria-label={t("Onde você está")} className="hidden min-w-0 md:block">
      <div className="flex min-w-0 items-center gap-2">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          <li className="pele-rotulo truncate text-muted-foreground">
            {hrefDoGrupo && hrefDoGrupo !== pathname ? (
              <Link href={hrefDoGrupo} className={LINK_DA_TRILHA}>
                {t(grupo.label)}
              </Link>
            ) : (
              t(grupo.label)
            )}
          </li>
          <li aria-hidden className="text-muted-foreground">
            ›
          </li>
          {naPropriaTela ? (
            <li aria-current="page" className="truncate font-semibold text-foreground">
              {t(destino.label)}
            </li>
          ) : (
            <li className="truncate font-semibold text-foreground">
              {/* A tela que contém o detalhe é o nível mais fundo que a trilha
                conhece: `location` diz ao leitor de tela "você está aqui dentro",
                sem fingir que o link é a página atual (`page`). */}
              <Link href={destino.href} aria-current="location" className={LINK_DA_TRILHA}>
                {t(destino.label)}
              </Link>
            </li>
          )}
        </ol>
        {/* Fora da lista de propósito: a trilha é "Grupo › Página"; a nota é um
          dado da página, e o leitor de tela não deve ouvi-la como um nível. */}
        {destino.contador === "fila" && <AguardandoResposta />}
      </div>
    </nav>
  );
}

/** Link da trilha: herda a cor do nível, sublinha no hover e mostra o foco. */
const LINK_DA_TRILHA =
  "rounded-sm hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500";

export function TopBar() {
  return (
    // Sem `border-b`: o topo é a mesma moldura da barra lateral, não uma faixa
    // separada por um fio. `md:pl-12` põe a trilha na MESMA coluna do conteúdo:
    // o `p-6` do `<main>` somado ao `p-6` da `Pagina` (e do skeleton). Medir as
    // duas bordas juntas ao mudar uma.
    <header className="sticky top-[var(--faixas-de-cima,0px)] z-20 flex h-14 items-center justify-between gap-2 bg-background/95 pl-3 pr-3 backdrop-blur dark:bg-background/60 md:gap-3 md:pl-12">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        {/* No desktop a organização mora no topo do trilho (quadro DS); aqui
            fica só para o celular, que não tem trilho. */}
        <div className="md:hidden">
          <TenantSwitcher />
        </div>
        <TrilhaDaRota />
      </div>
      {/* A busca ocupa o meio e cresce até os 440px do protótipo (o limite mora
          no próprio gatilho); o `flex-1` aqui só reserva o espaço. */}
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <BotaoDeDisponibilidade />
        <AlertsBell />
        <AvisoDePropostaEmDestaque />
        <UserMenu />
      </div>
    </header>
  );
}
