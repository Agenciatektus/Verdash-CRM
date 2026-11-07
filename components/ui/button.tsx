import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { CircleNotch } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Button — quadro DS v2 (DesignSystem.dc.html, "Botões"; `.btn` do Main.dc.html).
 *
 * Base: 36px, raio 9, peso 600, 14px, padding 14, nunca quebra o texto. Foco é
 * o anel de 2px na cor de destaque, afastado 2 (o `.btn-primary.focus` do
 * quadro). Desabilitado é CINZA (fundo `line-2`, texto `ink-3`), não 50% de
 * opacidade: o botão apagado parecia ativo e fraco.
 *
 * Variantes:
 *   - primary/default: accent cheio; hover é a marca a 86% com preto
 *     (`--color-accent-hover`). No escuro, o degradê VIBRANTE da logo com texto
 *     branco (quadro escuro, Cor); o hover escurece só o fundo.
 *   - secondary/outline: borda `line-2`, fundo surface, hover `--hover` (`.btn-ghost`).
 *   - ghost: sem borda nem fundo, hover `--hover`.
 *   - icon: o `.icon-btn` (36, raio 9, `ink-2`, hover `--hover`, ligado em
 *     accent-soft). Ícone sozinho exige `aria-label`.
 *   - destructive: o estado crit cheio (`.btn-danger`); no escuro o vermelho
 *     claro do crit com texto escuro.
 *   - link: só texto.
 */
const DESABILITADO_CHEIO =
  "disabled:bg-none disabled:bg-border-strong disabled:text-text-subtle disabled:shadow-none disabled:border-transparent";
// No escuro o degradê vem por `dark:`, que pode vencer o `disabled:` na ordem da
// folha; o desabilitado repete o cinza com os dois prefixos.
const DESABILITADO_ESCURO =
  "dark:disabled:bg-none dark:disabled:bg-border-strong dark:disabled:text-text-subtle dark:disabled:shadow-none";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.75 whitespace-nowrap",
    "rounded-control font-semibold",
    "transition-[background-color,border-color,color,box-shadow,transform]",
    "duration-ui ease-emphasized",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: `bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs dark:bg-(image:--gradient-primary) dark:text-(--pele-grad-fg) dark:hover:bg-(image:--pele-grad-acao-hover) ${DESABILITADO_CHEIO} ${DESABILITADO_ESCURO}`,
        default: `bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs dark:bg-(image:--gradient-primary) dark:text-(--pele-grad-fg) dark:hover:bg-(image:--pele-grad-acao-hover) ${DESABILITADO_CHEIO} ${DESABILITADO_ESCURO}`,
        secondary:
          "bg-surface text-text border border-border-strong hover:bg-hover disabled:text-text-subtle",
        outline:
          "bg-transparent text-text border border-border-strong hover:bg-hover disabled:text-text-subtle",
        ghost: "bg-transparent text-text hover:bg-hover disabled:text-text-subtle",
        icon:
          "bg-transparent text-text-muted hover:bg-hover hover:text-text aria-pressed:bg-accent-soft aria-pressed:text-accent-text data-[state=on]:bg-accent-soft data-[state=on]:text-accent-text disabled:text-text-subtle",
        destructive: `bg-error text-destructive-foreground hover:bg-[color-mix(in_oklch,var(--color-error)_86%,black)] shadow-xs ${DESABILITADO_CHEIO}`,
        link: "bg-transparent text-accent-text underline underline-offset-4 decoration-1 hover:decoration-2 h-auto p-0 disabled:text-text-subtle",
      },
      // Alturas de toque: abaixo de `lg` (mesmo corte que o resto da casca
      // usa pra decidir "é celular/tablet, é mouse") toda variante bate os
      // 44px recomendados pra alvo de toque; de `lg:` pra cima, onde quem
      // aciona é cursor, volta para as medidas do quadro (36 e, no `sm`, 30).
      size: {
        sm: "h-11 px-2.5 text-label rounded-md lg:h-7.5",
        // 13/600 em todos os tamanhos: a tabela de tipografia do quadro diz
        // "Rótulo, botão 13/600" (decisão do Peterson no fechamento da etapa 2).
        default: "h-11 px-3.5 text-label lg:h-9",
        md: "h-11 px-3.5 text-label lg:h-9",
        lg: "h-11 px-6 text-label",
        icon: "h-11 w-11 lg:h-9 lg:w-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Em andamento: desabilita, marca `aria-busy` e põe o spinner antes do texto. Ignorado com `asChild`. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const ocupado = loading && !asChild;
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || ocupado}
        aria-busy={ocupado || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {ocupado ? <CircleNotch className="animate-spin" aria-hidden /> : null}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
