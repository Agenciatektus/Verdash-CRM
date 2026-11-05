"use client";
import { useEffect, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/shell/Sidebar";
import type { FunilDoMenu } from "@/lib/navigation/funis-no-menu";
import { TopBar } from "@/components/shell/TopBar";
import { ConviteDeInstalacao } from "@/components/pwa/ConviteDeInstalacao";
import { CascaDoCelular } from "@/components/mobile/CascaDoCelular";
import { FunisDoMenuProvider } from "@/components/mobile/FunisDoMenu";
import { BarraDeProgressoNavegacao } from "@/components/shell/BarraDeProgressoNavegacao";
import { useSinalDePresenca } from "@/hooks/atendimento/useSinalDePresenca";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useInboundCallAlerts } from "@/hooks/calls/useInboundCallAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";
import { ensureNotifyServiceWorker } from "@/lib/notifications/service_worker";
import { estiloDaReserva, useOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";
import { cn } from "@/lib/utils";

/**
 * A INBOX ENCOSTA NA MOLDURA (o `.work` do protótipo: `margin: 0 8px 8px 0`).
 * Ela é uma área de trabalho de tela inteira, e o `p-6` das outras telas comia
 * 24px em cima e à esquerda da conversa sem servir a nada: a Inbox já desenha o
 * próprio cartão. As outras telas continuam com o `p-6` de sempre. A altura do
 * cartão desconta exatamente este respiro (ver `InboxLayout`).
 */
/**
 * O estilo do `<main>`: a reserva do rodapé (quando há peça fixa) e, junto, a
 * MESMA medida publicada em `--respiro-do-main`, que o cartão da Inbox desconta
 * da própria altura. Uma fonte só: com o painel de chamada o `<main>` reserva
 * `max(24px, ocupação)`, e o cartão descontando outra conta (o piso de 8px)
 * passaria da tela. Sem peça não há estilo nenhum (o `pb-2`/`p-6` de sempre),
 * e o cartão cai no `var(--space-2)` de reserva.
 */
function estiloDoMain(ocupacao: number): CSSProperties | undefined {
  const reserva = estiloDaReserva(ocupacao);
  if (!reserva) return undefined;
  return { ...reserva, ["--respiro-do-main" as string]: reserva.paddingBottom };
}

function ehAInbox(pathname: string | null): boolean {
  return pathname === "/app/inbox" || !!pathname?.startsWith("/app/inbox/");
}

interface AppShellProps {
  sidebarCollapsed: boolean;
  /** Na Inbox o menu começa recolhido; fica ao lado só se o atendente fixou. */
  menuFixoNaInbox?: boolean;
  /**
   * A pessoa pode atender (agent+)? Vem do papel resolvido no layout, e não de
   * uma consulta desta casca.
   *
   * Só quem atende emite o sinal de presença: o roster que a tela Equipe mostra
   * é agent+, e a rota do sinal exige o mesmo papel. `viewer` batendo colheria
   * 403 a cada minuto em nome de ninguém.
   */
  podeAtender: boolean;
  /**
   * Os funis da organizacao, para o no "Pipeline" do menu. Vem do layout, que e
   * servidor: a rota que os lista exige `manager`, e o menu e visto por todo papel.
   */
  funis: readonly FunilDoMenu[];
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, menuFixoNaInbox = false, podeAtender, funis, children }: AppShellProps) {
  useInboundMessageAlerts();
  useInboundCallAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  // O SW em todo /app, e não só depois da permissão de avisos: é ele que
  // responde a página neutra quando a navegação cai sem rede (ADR-0006, D4),
  // e é aqui que a versão nova dele substitui a antiga depois de um deploy.
  // Sem contexto seguro (http://IP) a função devolve null e nada acontece.
  useEffect(() => {
    void ensureNotifyServiceWorker();
  }, []);
  // O SINAL DE PRESENÇA (issue #996) sai daqui porque presença é "esta aba
  // está aberta" — não "a pessoa está na tela Equipe". Quem atende passa o dia
  // no Inbox e na Agenda; um emissor amarrado à tela de gestão diria que só o
  // gerente está presente.
  useSinalDePresenca(podeAtender);
  // O que as peças fixas do rodapé declararam ocupar agora (issue #1305). Sem
  // chamada nenhuma é ZERO, e aí o `<main>` fica exatamente como sempre foi —
  // o `p-6` inteiro é rodapé. Com o painel de chamada na tela, é ele que
  // decide a faixa que o conteúdo perde, e ninguém mais mede isso por fora.
  const ocupacaoDoRodape = useOcupacaoDoRodape();
  const naInbox = ehAInbox(usePathname());
  return (
    // A área segura dos lados mora no `body` (globals.css), para valer em toda página.
    // `min-h-dvh` menos `--faixas-de-cima` (publicada por `FaixasDeCima`): as faixas do topo
    // ficam ACIMA da casca, e sem o desconto o documento ficaria rolável com o WhatsApp desconectado.
    <div className="pele-moldura flex min-h-[calc(100dvh-var(--faixas-de-cima,0px))] w-full bg-background">
      <BarraDeProgressoNavegacao />
      {/* Só no celular (abaixo de 760px) e uma vez por aparelho. */}
      <ConviteDeInstalacao />
      <div className="hidden md:block">
        <Sidebar collapsed={sidebarCollapsed} fixoNaInbox={menuFixoNaInbox} funis={funis} />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      <div className="flex min-h-[calc(100dvh-var(--faixas-de-cima,0px))] min-w-0 flex-1 flex-col">
        {/* Abaixo de 760px o topo e a gaveta saem: entra a casca do app de celular
            (cabeçalho, barra inferior com as 5 abas, FAB e o menu "Mais"). */}
        <div className="hidden largo:contents">
          <TopBar />
        </div>
        <CascaDoCelular />
        {/*
          O RODAPÉ DESCONTA O QUE AS PEÇAS FIXAS OCUPAM (issue #1305).

          `estiloDaReserva` devolve `undefined` quando não há peça registrada —
          nenhum estilo, e aí quem responde pela faixa de baixo é a classe
          `pb-area-segura` —, e um `padding-bottom` que consome
          `--rodape-ocupado` quando há. O que ele descontou está também no
          atributo `data-rodape-ocupado`: é por ali que o gate mede esta faixa
          sem depender de o jsdom computar `var()` (ele não computa), e é o que
          aparece no inspetor quando alguém pergunta quanto o rodapé perdeu.

          `p-4 sm:p-6`: 24px de margem em cada lado de uma tela de 360px come
          13% da largura útil. O `AdminShell` já usava este par — aqui a casca
          do tenant passa a usar o mesmo.

          `pb-area-segura` é o piso da faixa de baixo quando NÃO há peça fixa:
          `max(var(--space-6), env(safe-area-inset-bottom))`. Sem ela, no iOS em
          tela cheia o fim do conteúdo ficava atrás do indicador de home — e com
          peça fixa quem cobre isso é o terceiro termo do `max()` do contrato.
        */}
        <main
          className={cn(
            "flex-1 overflow-auto",
            // No celular o fim da página fica acima da barra inferior.
            naInbox
              ? "pr-2 pb-2 mb:pb-[calc(var(--mb-casca-baixo)+var(--space-2))]"
              : "p-6 mb:pb-[calc(var(--mb-casca-baixo)+1.5rem)]",
          )}
          style={estiloDoMain(ocupacaoDoRodape)}
          data-rodape-ocupado={ocupacaoDoRodape}
        >
          <FunisDoMenuProvider funis={funis}>{children}</FunisDoMenuProvider>
        </main>
      </div>
    </div>
  );
}
