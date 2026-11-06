import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Chip de escolha — o `.chip` do protótipo da Inbox v2 (Main.dc.html:541).
 *
 * Botão de alternar, em pílula de 30px: desligado é contorno na linha forte;
 * ligado (`aria-pressed`) é o accent cheio e, no escuro, o degradê da logo
 * (`pele-grad-ativo`, que lê o mesmo `aria-pressed`). Desativado segue o
 * `.chip.off` do quadro DS: tracejado e a 40%. Chip é ESCOLHA; estado é a
 * pílula (`Badge`) e classificação é a tag (`Badge variant="tag"`).
 */
const chipVariants = cva(
  [
    "pele-grad-ativo inline-flex h-7.5 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-2.75",
    "text-label font-semibold",
    "transition-[background-color,border-color,color] duration-ui ease-emphasized",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-40",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      tom: {
        padrao:
          "border-border-strong bg-surface text-text-muted hover:border-text-subtle hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-selected:border-accent aria-selected:bg-accent aria-selected:text-accent-foreground",
      },
    },
    defaultVariants: { tom: "padrao" },
  },
);

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">,
    VariantProps<typeof chipVariants> {
  /** Ligado. Vira `aria-pressed`, que é o que a cor e a pele leem. `null` = não emite (aba usa `aria-selected`; navegação não é toggle). */
  ligado?: boolean | null;
}

const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  ({ className, tom, ligado = false, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={ligado === null ? undefined : ligado}
      className={cn(chipVariants({ tom }), className)}
      {...props}
    />
  ),
);
Chip.displayName = "Chip";

export { Chip, chipVariants };
