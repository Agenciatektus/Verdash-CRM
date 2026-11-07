"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Chip } from "@/components/ui/chip";
import { CampoDeData } from "@/components/ui/campo-de-data";
import { Label } from "@/components/ui/label";
import { BarraDeFiltros } from "@/components/pagina";
import { useT } from "@/hooks/i18n/useT";
import { PONTO_POR_ID } from "@/lib/ai/pontos/registro";

export interface UsageFiltersAgent {
  id: string;
  name: string;
}

interface Props {
  agents: UsageFiltersAgent[];
  /** Os `llm_calls.purpose` que aparecem no período — a lista vem do banco, nunca fixa. */
  kinds: string[];
  initial: {
    agent_id?: string;
    invocation_kind?: string;
    from?: string;
    to?: string;
  };
}

const ALL_AGENTS = "all";
const DEBOUNCE_MS = 300;
const PERIODOS = [
  { dias: 7, rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
] as const;
const PADRAO_DIAS = 30;

/** O `from` (dia UTC, como a rota lê) que faz do período os últimos N dias, hoje incluído. */
function desdeDe(dias: number): string {
  return new Date(Date.now() - (dias - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function UsageFilters({ agents, kinds, initial }: Props) {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [agentId, setAgentId] = useState<string>(initial.agent_id ?? ALL_AGENTS);
  const [kind, setKind] = useState<string>(initial.invocation_kind ?? "all");
  const [from, setFrom] = useState<string>(initial.from ?? "");
  const [to, setTo] = useState<string>(initial.to ?? "");
  // Link com intervalo que nenhum chip reproduz acende "Personalizado" e mostra De/Até.
  const [personalizado, setPersonalizado] = useState<boolean>(
    !!initial.to || (!!initial.from && !PERIODOS.some((p) => desdeDe(p.dias) === initial.from)),
  );
  const diasAtivos = personalizado
    ? undefined
    : !from
      ? PADRAO_DIAS
      : PERIODOS.find((p) => desdeDe(p.dias) === from)?.dias;
  const escolherPeriodo = (dias: number) => {
    setPersonalizado(false);
    setFrom(dias === PADRAO_DIAS ? "" : desdeDe(dias));
    setTo("");
  };

  // A lista era fixa e quase toda de nomes que `llm_calls.purpose` não tem
  // (`sentiment_check`, `embed_chunk`...): escolher um desses devolvia zero. O escolhido entra
  // mesmo fora do período, senão o gatilho fica em branco e esconde o filtro ativo.
  const kindOptions = [...new Set(kind === "all" ? kinds : [...kinds, kind])]
    .map((value) => {
      const ponto = PONTO_POR_ID.get(value);
      return { value, label: ponto ? t(ponto.rotulo) : value };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "pt"));

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRunRef = useRef(true);

  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const sp = new URLSearchParams(searchParams.toString());
      const setOrDelete = (k: string, v: string | null | undefined) => {
        if (v && v !== "all" && v !== "") sp.set(k, v);
        else sp.delete(k);
      };
      setOrDelete("agent_id", agentId);
      setOrDelete("invocation_kind", kind);
      setOrDelete("from", from);
      setOrDelete("to", to);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, kind, from, to]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Período")}>
        {PERIODOS.map((p) => (
          <Chip key={p.dias} ligado={diasAtivos === p.dias} onClick={() => escolherPeriodo(p.dias)}>
            {t(p.rotulo)}
          </Chip>
        ))}
        <Chip ligado={personalizado} onClick={() => setPersonalizado(true)}>
          {t("Personalizado")}
        </Chip>
      </div>
      {personalizado && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="usage-from" className="text-xs text-muted-foreground">
              {t("De")}
            </Label>
            <CampoDeData tipo="date" id="usage-from" value={from} onValorChange={setFrom} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="usage-to" className="text-xs text-muted-foreground">
              {t("Até")}
            </Label>
            <CampoDeData tipo="date" id="usage-to" value={to} onValorChange={setTo} />
          </div>
        </div>
      )}
      <BarraDeFiltros ativos={Number(agentId !== ALL_AGENTS) + Number(kind !== "all")}>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger aria-label={t("Agente")} className="sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS}>{t("Todos")}</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger aria-label={t("Tipo de uso")} className="sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todas")}</SelectItem>
            {kindOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </BarraDeFiltros>
    </div>
  );
}
