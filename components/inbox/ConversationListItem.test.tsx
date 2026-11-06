/**
 * A etiqueta "Grupo" na lista de conversas.
 *
 * `conversations.is_group` já chega no `SELECT_COLS` do handler (schema
 * original) — este teste prende só a LEITURA na tela: quem abre o inbox
 * precisa distinguir uma conversa de grupo de uma individual sem abrir cada
 * uma. Props mínimas copiadas de `ConversationList.tsx`, via
 * `__fixtures__/conversa.ts`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem — etiqueta de grupo", () => {
  it("conversa de grupo tem a etiqueta Grupo", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: true }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByText("Grupo")).toBeInTheDocument();
  });

  it("conversa individual não tem", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: false }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByText("Grupo")).toBeNull();
  });
});

/**
 * Visual v2, fase 3.1: a linha diz de relance o que pede atenção. Não lida é
 * nome em negrito, hora no accent e contador; o par de CONTROLE (lida) prende
 * que o destaque não vira o padrão de toda linha, que é como ele deixaria de
 * dizer alguma coisa.
 */
describe("ConversationListItem — não lida", () => {
  it("não lida: contador com o número, nome em negrito e hora no accent", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, unread_count_for_assignee: 3 }}
        {...conversaDeExemplo.props}
      />,
    );
    const linha = screen.getByRole("button");
    expect(linha).toHaveAttribute("data-nao-lida", "true");
    expect(screen.getByLabelText("3 mensagens não lidas")).toHaveTextContent("3");
    expect(screen.getByText("Maria")).toHaveClass("font-bold");
    expect(linha.querySelector(".tabular-nums.text-accent")).not.toBeNull();
  });

  it("CONTROLE: lida não tem contador nem destaque", () => {
    render(<ConversationListItem conversation={conversaDeExemplo.conversation} {...conversaDeExemplo.props} />);
    const linha = screen.getByRole("button");
    expect(linha).not.toHaveAttribute("data-nao-lida");
    expect(screen.queryByLabelText(/mensagens não lidas/)).toBeNull();
    expect(screen.getByText("Maria")).not.toHaveClass("font-bold");
  });
});

describe("ConversationListItem — seleção e dono", () => {
  it("selecionada: fundo accent-soft, marcador à esquerda e aria-current", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        isSelected
      />,
    );
    const linha = screen.getByRole("button");
    expect(linha).toHaveAttribute("aria-current", "true");
    expect(linha).toHaveClass("bg-accent-soft");
    expect(linha.querySelector("span.bg-accent[aria-hidden]")).not.toBeNull();
  });

  it("o dono que é a própria pessoa aparece como Você; outro, pelo nome", () => {
    const comDono = {
      ...conversaDeExemplo.conversation,
      assigned_to_user_id: "u-1",
      assigned_to_user_name: "Ana Souza",
    };
    const { unmount } = render(
      <ConversationListItem conversation={comDono} {...conversaDeExemplo.props} mostrarAtendente meuUserId="u-1" />,
    );
    expect(screen.getByText("Você")).toBeInTheDocument();
    unmount();
    render(
      <ConversationListItem conversation={comDono} {...conversaDeExemplo.props} mostrarAtendente meuUserId="u-2" />,
    );
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByText("Você")).toBeNull();
  });

  it("sem dono e sem automático no ar: Sem dono", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        mostrarAtendente
        automaticoDaOrg={false}
      />,
    );
    expect(screen.getByText("Sem dono")).toBeInTheDocument();
  });

  it("CONTROLE: quando o dono não discrimina, a pílula não aparece", () => {
    render(<ConversationListItem conversation={conversaDeExemplo.conversation} {...conversaDeExemplo.props} />);
    expect(screen.queryByText("Sem dono")).toBeNull();
  });
});

describe("ConversationListItem — espera fora da Fila", () => {
  const haMinutos = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  it("cliente esperando há 40 min: pílula curta no tom crítico", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, awaiting_since: haMinutos(40) }}
        {...conversaDeExemplo.props}
      />,
    );
    const pilula = screen.getByTestId("item-espera");
    expect(pilula).toHaveAttribute("data-tom", "crit");
    expect(pilula.textContent).toBe("40m");
  });

  it("14 min é atenção; 4 min é informativo", () => {
    const { unmount } = render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, awaiting_since: haMinutos(14) }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByTestId("item-espera")).toHaveAttribute("data-tom", "warn");
    unmount();
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, awaiting_since: haMinutos(4) }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByTestId("item-espera")).toHaveAttribute("data-tom", "info");
  });

  it("CONTROLE: sem `awaiting_since` a linha não afirma espera", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, awaiting_since: null }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByTestId("item-espera")).toBeNull();
  });
});

/**
 * A caixa de seleção do lote (#2484, fatia F1).
 *
 * Duas regras medidas aqui: a caixa SÓ existe quando a seleção está ligada —
 * sem a prop de seleção a lista é exatamente a que era —, e marcar NÃO abre a
 * conversa. O dia que os dois gestos virarem um só, ninguém mais consegue
 * marcar três conversas sem abrir as três.
 */
describe("ConversationListItem — seleção em lote", () => {
  it("sem seleção ligada, não existe caixa nenhuma", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("com seleção ligada, a caixa alterna o id e NÃO abre a conversa", () => {
    const onSelect = vi.fn();
    const alternar = vi.fn();
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        onSelect={onSelect}
        onAlternarSelecao={alternar}
      />,
    );
    const caixa = screen.getByRole("checkbox");
    expect(caixa).not.toBeChecked();
    fireEvent.click(caixa);
    expect(alternar).toHaveBeenCalledWith(conversaDeExemplo.conversation.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("linha marcada: a caixa aparece checada", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("linha marcada usa o fundo que acompanha o tema, não o degrau fixo da marca", () => {
    // `bg-accent-50` tem o mesmo hex quase branco nos dois temas: no escuro o nome
    // (texto claro) sumia (prova pela tela do #2909). `bg-accent-soft` muda com o tema.
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    // O contêiner da linha (o `div` em volta da caixa) é quem recebe o fundo.
    const linha = screen.getByRole("checkbox").closest("div")!;
    expect(linha.className).toContain("bg-accent-soft");
    expect(linha.className).not.toContain("bg-accent-50");
  });
});
