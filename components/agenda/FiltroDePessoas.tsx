"use client";

import { useT } from "@/hooks/i18n/useT";

import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

import { AvatarDaPessoa } from "./AvatarDaPessoa";
import type { Pessoa } from "./tipos";

/**
 * Quem aparece na grade.
 *
 * Um chip por pessoa (avatar + nome), e clicar num ISOLA a agenda daquela
 * pessoa — pedido explícito do dono do produto. Não é multisseleção: numa equipe
 * de clínica a pergunta real é "o que a Ana tem hoje?". "Todos" desfaz.
 * No celular a fila rola na horizontal em vez de quebrar.
 */
export function FiltroDePessoas({
  pessoas,
  isolada,
  onIsolar,
  className,
}: {
  pessoas: Pessoa[];
  /** `null` = todos. */
  isolada: string | null;
  onIsolar: (id: string | null) => void;
  className?: string;
}) {
  const t = useT();
  // Primeiro nome; se dois colegas repetem, acrescenta a inicial do sobrenome.
  const primeiro = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const rotulo = (p: Pessoa) => {
    const repete = pessoas.some((o) => o.id !== p.id && primeiro(o.nome) === primeiro(p.nome));
    const sobrenome = p.nome.trim().split(/\s+/)[1];
    return repete && sobrenome ? `${primeiro(p.nome)} ${sobrenome[0]}.` : primeiro(p.nome);
  };
  // Um filtro com uma opção só não é um filtro — é um enfeite que ocupa espaço
  // e sugere uma escolha inexistente. O produto já faz isso no alternador do
  // inbox ("só aparece com 2+"), e a regra vale igual aqui.
  if (pessoas.length < 2) return null;

  return (
    <div
      data-testid="filtro-de-pessoas"
      data-isolada={isolada ?? "todos"}
      className={cn("flex flex-wrap items-center gap-2 mb:flex-nowrap mb:overflow-x-auto", className)}
    >
      {/* Profissional com avatar na MESMA cor do evento na grade (trilha da pessoa). */}
      <Chip data-testid="botao-todos" ligado={isolada === null} onClick={() => onIsolar(null)}>
        {t("Todos")}
      </Chip>
      {pessoas.map((p) => (
        <Chip
          key={p.id}
          data-testid={`botao-pessoa-${p.id}`}
          ligado={isolada === p.id}
          aria-label={
            isolada === p.id
              ? `${t("Mostrar todos (agora só")} ${p.nome})`
              : `${t("Ver só a agenda de")} ${p.nome}`
          }
          onClick={() => onIsolar(isolada === p.id ? null : p.id)}
          className="pl-1"
        >
          <AvatarDaPessoa pessoa={p} tamanho="sm" ativo={isolada === null || isolada === p.id} />
          {rotulo(p)}
        </Chip>
      ))}
    </div>
  );
}
