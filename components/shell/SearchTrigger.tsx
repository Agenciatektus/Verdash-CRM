"use client";
import { useState, useSyncExternalStore } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

/**
 * Mac mostra ⌘K; o resto, Ctrl K. Lido por `useSyncExternalStore` com um retrato
 * de servidor fixo ("Ctrl K"): ler `navigator` direto no render faria o HTML do
 * servidor e o da primeira pintura discordarem (erro de hidratação), e um
 * `setState` dentro de efeito pintaria a tecla errada por um quadro.
 */
const semAssinatura = () => () => {};
function ehMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * O gatilho da busca no topo, nas medidas do `.search-trigger` do protótipo:
 * campo largo (até 440px), 36px de altura, fundo `surface` com borda.
 *
 * O texto diz o que a paleta acha: contato, conversa e tela (ver
 * `CommandPalette`). O "lead" do protótipo fica de fora enquanto a rota de leads
 * não aceitar busca: prometer lead seria um campo que não acha o que diz achar.
 */
export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const mac = useSyncExternalStore(semAssinatura, ehMac, () => false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("Buscar contato, conversa ou lead")}
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        className="pele-foco flex h-9 w-9 mb:h-11 mb:w-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface text-sm text-text-subtle transition-colors hover:border-border-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring lg:w-full lg:max-w-[440px] lg:justify-start lg:pr-2 lg:pl-3"
      >
        <MagnifyingGlass size={15} className="shrink-0" aria-hidden />
        <span className="hidden min-w-0 flex-1 truncate text-left lg:inline">
          {t("Buscar contato, conversa ou lead")}
        </span>
        <kbd className="hidden shrink-0 rounded-md border border-border bg-surface-elevated px-1.5 py-0.5 font-sans text-[11px] text-text-muted lg:inline">
          {mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
