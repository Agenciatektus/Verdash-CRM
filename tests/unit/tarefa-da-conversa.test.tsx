/**
 * @vitest-environment jsdom
 *
 * "Adicionar tarefa" da conversa: a tarefa nasce presa ao contato e ao negócio ABERTO
 * (não ao primeiro do resumo, que pode ser ganho). Resumo em erro não abre o formulário.
 */
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resumo: { isPending: false, isError: false, data: [] as Array<{ id: string; status: string }> },
  form: vi.fn(),
  toast: vi.fn(),
  busca: new URLSearchParams(),
}));
vi.mock("@/hooks/inbox/useFunilDoContato", () => ({ useFunilDoContato: () => ({ resumo: m.resumo }) }));
vi.mock("@/hooks/tasks/useTasks", () => ({ useTasks: () => ({ criarTarefa: vi.fn() }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-1" }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/mobile/usePodeCriar", () => ({ usePodeCriar: () => true }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => m.toast(...a) } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox", useSearchParams: () => m.busca }));
vi.mock("@/app/app/tasks/_components/FormularioDeTarefa", () => ({
  FormularioDeTarefa: (p: Record<string, unknown>) => {
    m.form(p);
    return null;
  },
}));

import { TarefaDaConversa } from "@/components/inbox/menu/TarefaDaConversa";
import { usePedidoDeCriar } from "@/lib/mobile/usePedidoDeCriar";

beforeEach(() => {
  m.form.mockClear();
  m.toast.mockClear();
  m.resumo = { isPending: false, isError: false, data: [] };
  m.busca = new URLSearchParams();
});

describe("TarefaDaConversa", () => {
  it("liga ao negócio ABERTO mesmo com um ganho na frente do resumo", () => {
    m.resumo.data = [{ id: "ganho-1", status: "won" }, { id: "aberto-1", status: "open" }];
    render(<TarefaDaConversa contactId="c-1" onFechar={vi.fn()} />);
    expect(m.form.mock.calls.at(-1)?.[0]).toMatchObject({ contactId: "c-1", leadId: "aberto-1", aberto: true });
  });

  it("sem negócio aberto, a tarefa fica só no contato", () => {
    m.resumo.data = [{ id: "ganho-1", status: "won" }];
    render(<TarefaDaConversa contactId="c-1" onFechar={vi.fn()} />);
    expect(m.form.mock.calls.at(-1)?.[0]).toMatchObject({ contactId: "c-1", leadId: null });
  });

  it("resumo carregando: formulário não abre", () => {
    m.resumo.isPending = true;
    render(<TarefaDaConversa contactId="c-1" onFechar={vi.fn()} />);
    expect(m.form).not.toHaveBeenCalled();
  });

  it("resumo em erro: avisa, fecha e NÃO abre o formulário (gravaria sem o negócio)", () => {
    m.resumo.isError = true;
    const onFechar = vi.fn();
    render(<TarefaDaConversa contactId="c-1" onFechar={onFechar} />);
    expect(m.form).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenCalledTimes(1);
    expect(onFechar).toHaveBeenCalledTimes(1);
  });
});

describe("usePedidoDeCriar com parâmetro próprio", () => {
  it("?tarefa=1 abre e sai da URL; ?criar=1 não dispara o pedido da tarefa", () => {
    window.history.replaceState(null, "", "/app/inbox?id=c-1&tarefa=1");
    m.busca = new URLSearchParams("id=c-1&tarefa=1");
    const abrir = vi.fn();
    renderHook(() => usePedidoDeCriar(abrir, true, "tarefa"));
    expect(abrir).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?id=c-1");

    const outro = vi.fn();
    m.busca = new URLSearchParams("criar=1");
    renderHook(() => usePedidoDeCriar(outro, true, "tarefa"));
    expect(outro).not.toHaveBeenCalled();
  });

  it("sem permissão só limpa o parâmetro", () => {
    window.history.replaceState(null, "", "/app/inbox?id=c-1&tarefa=1");
    m.busca = new URLSearchParams("id=c-1&tarefa=1");
    const abrir = vi.fn();
    renderHook(() => usePedidoDeCriar(abrir, false, "tarefa"));
    expect(abrir).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?id=c-1");
  });
});
