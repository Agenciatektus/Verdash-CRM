"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in",
      className
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

/**
 * Pele do DS (fork) com o movimento do upstream (1.76). A gaveta da DIREITA é a
 * do protótipo (`.app.drawer-on .panel { animation: slideIn }`, cobrada pela
 * paridade): fica com `animate-slide-in`. As outras três usam a `ds-gaveta` do
 * upstream (entrada E saída, lado por `data-lado`, régua em `app/globals.css`)
 * no lugar das `slide-in-from-*` do `tailwindcss-animate`, que nunca foi
 * instalado aqui e não geravam CSS.
 */
const sheetVariants = cva("fixed z-50 gap-4 bg-surface p-6 text-text shadow-pop", {
  variants: {
    side: {
      top: "ds-gaveta inset-x-0 top-0 border-b",
      bottom: "ds-gaveta inset-x-0 bottom-0 border-t",
      left: "ds-gaveta inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
      right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=open]:animate-slide-in sm:max-w-sm",
    },
  },
  defaultVariants: {
    side: "right",
  },
});

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => {
  const t = useT();
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        /*
          `data-lado` é o que diz ao CSS de onde a gaveta vem. Atributo, e não
          quatro pares de keyframes: o lado só troca um token
          (`--ds-gaveta-de`), então a animação é escrita uma vez.

          Não dá para reusar o `data-side` do Radix aqui — o `Dialog.Content`,
          que é a primitiva por baixo do Sheet, não emite nenhum: `data-side` é
          coisa de popper (menu, dica, seletor), e o Sheet não é popper.
        */
        data-lado={side}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {/*
          44px DE ALVO SEM MOVER O ÍCONE UM PIXEL.

          Este é o botão de fechar de TODA gaveta do produto, e no celular ele
          era um alvo de 16px encostado na borda da tela — onde o dedo tem menos
          precisão. O piso é 44px (Apple HIG), adotado pelo princípio 4 de
          `docs/design-system/screen-flow/07-responsive-strategy.md`.

          O truque é `p-3.5` com `-m-3.5` por cima: 14px de preenchimento em
          volta de um ícone de 16px dá uma caixa de 44px, e os -14px de margem
          puxam a caixa de volta, então a borda do ÍCONE continua a 16px do
          canto, exatamente onde estava. Crescer a caixa sem compensar moveria o
          X uns 14px para dentro em todas as gavetas — conserto de alvo de toque
          não precisa mexer no desenho.

          `lg:m-0 lg:p-0` devolve o desktop idêntico ao que era.

          `z-20`: o X vem ANTES do conteúdo no DOM, então qualquer faixa
          `sticky z-10` do conteúdo (a da lateral do Inbox, #3585) pintava por
          cima dele e engolia o toque. Acima das faixas, abaixo do próprio
          Sheet (z-50).
        */}
        <SheetPrimitive.Close className="absolute top-4 right-4 z-20 -m-3.5 rounded-sm p-3.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary lg:m-0 lg:p-0">
          <X className="h-4 w-4" />
          <span className="sr-only">{t("Fechar")}</span>
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
