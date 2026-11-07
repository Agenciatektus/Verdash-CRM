import { cn } from "@/lib/utils";

/**
 * Barra de progresso do quadro DS (`.prog`): 8px, trilho `border`, preenchimento
 * no degradê da marca. `valor` de 0 a 100 (fora disso é cortado). O rótulo
 * acessível é obrigatório: a barra sozinha não diz o que mede.
 */
export function BarraDeProgresso({
  valor,
  rotulo,
  className,
}: {
  valor: number;
  rotulo: string;
  className?: string;
}) {
  const pct = Number.isFinite(valor) ? Math.max(0, Math.min(100, valor)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={rotulo}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-2 w-full overflow-hidden rounded-sm bg-border", className)}
    >
      <div
        className="h-full rounded-sm bg-(image:--gradient-primary) transition-[width] duration-ui ease-emphasized"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
