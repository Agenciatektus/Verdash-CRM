"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const t = useT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-x-hidden overflow-y-auto border border-border bg-surface p-6 text-text shadow-pop data-[state=open]:animate-fade-in sm:rounded-xl",
          className
        )}
        {...props}
      >
        {children}
        {/*
          44px de alvo sem mover o ícone um pixel: `p-3.5` dá uma caixa de 44px
          em volta do ícone de 16px, e `-m-3.5` puxa a caixa de volta para que a
          borda do X continue a 16px do canto. Piso de toque do princípio 4 de
          `docs/design-system/screen-flow/07-responsive-strategy.md`, sem
          redesenhar os ~27 diálogos. `lg:m-0 lg:p-0` devolve o desktop idêntico.
        */}
        <DialogPrimitive.Close className="absolute top-4 right-4 -m-3.5 rounded-sm p-3.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground lg:m-0 lg:p-0">
          <X className="h-4 w-4" />
          <span className="sr-only">{t("Fechar")}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    // `overflow-wrap:anywhere` e não `break-words`: o título pode trazer um
    // identificador sem espaço (o nome técnico da sessão do canal, `org_0d20…_f0c0…`), e só
    // o `anywhere` reduz a largura mínima do item — com `break-word` o grid do
    // modal ainda alarga até caber a palavra inteira, e o texto sai cortado.
    // `leading-tight` porque, quebrando, `leading-none` encosta as linhas.
    className={cn(
      "text-lg leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
