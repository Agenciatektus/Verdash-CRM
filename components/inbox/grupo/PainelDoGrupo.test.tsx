import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InfoDoGrupo } from "@/lib/grupos/acoes";

const estado = vi.hoisted(() => ({
  info: null as unknown,
  grupo: { is_announce: false, papel: "membro" as "dono" | "admin" | "membro" | null },
}));

vi.mock("@/hooks/inbox/useGrupo", () => ({
  useInfoDoGrupo: () => ({ data: estado.info, isLoading: false, isError: false }),
  useAcaoDoGrupo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEstadoDoGrupo: () => ({ data: estado.grupo }),
}));
vi.mock("@/components/inbox/Composer", () => ({
  Composer: (p: { blockedReason?: string | null }) => <div data-testid="composer">{p.blockedReason ?? "livre"}</div>,
}));

import { ComposerDeGrupo } from "./ComposerDeGrupo";
import { PainelDoGrupo } from "./PainelDoGrupo";

const info = (souAdmin: boolean | null): InfoDoGrupo => ({
  subject: "Promo", descricao: null, soAdminsEnviam: false, soAdminsEditam: false, criadoEm: "2024-03-05T10:00:00Z",
  mensagensTemporarias: "off", tipo: "grupo", total: 2, souAdmin,
  participantes: [
    { telefone: "5521977357727", nome: "Loja", admin: true, dono: true },
    { telefone: "5511888887777", nome: null, admin: false, dono: false },
  ],
});
const painel = (podeGerir = true) => render(
  <PainelDoGrupo aberto onFechar={() => {}} channelSessionId="s" groupChatId="1@g.us" meuTelefone="5521977357727" podeGerir={podeGerir} />,
);

beforeEach(() => {
  estado.grupo = { is_announce: false, papel: "membro" };
});

describe("PainelDoGrupo", () => {
  it("não-admin não vê as ações de administrador", () => {
    estado.info = info(false);
    painel();
    expect(screen.queryByText("Ações de administrador")).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar info" })).toBeNull();
    expect(screen.getByText("Sem descrição")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sair do grupo" })).toBeTruthy();
  });
  it("admin vê e pode usar as ações; participantes saem formatados com Você", () => {
    estado.info = info(true);
    painel();
    const b = screen.getByRole("button", { name: "Editar info" }) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(screen.getByText("+55 21 97735-7727")).toBeTruthy();
    expect(screen.getByText("Você")).toBeTruthy();
    expect(screen.getByText("Super Admin")).toBeTruthy();
  });
  it("souAdmin null: ações desabilitadas com o aviso", () => {
    estado.info = info(null);
    painel();
    expect((screen.getByRole("button", { name: "Foto" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Não foi possível confirmar se este número é admin")).toBeTruthy();
  });
  it("usuário sem papel de gerente no CRM não vê ações de administrador", () => {
    estado.info = info(true);
    painel(false);
    expect(screen.queryByText("Ações de administrador")).toBeNull();
  });
});

describe("ComposerDeGrupo", () => {
  const conversa = { channel_session_id: "s", group_chat_id: "1@g.us" } as never;
  it("grupo só-admins e número membro: composer travado com a faixa", () => {
    estado.grupo = { is_announce: true, papel: "membro" };
    render(<ComposerDeGrupo conversationId="c" conversa={conversa} />);
    expect(screen.getByTestId("composer").textContent).toBe("Só administradores podem enviar mensagens neste grupo.");
  });
  it("admin do grupo, ou grupo aberto: composer livre", () => {
    estado.grupo = { is_announce: true, papel: "admin" };
    const { unmount } = render(<ComposerDeGrupo conversationId="c" conversa={conversa} />);
    expect(screen.getByTestId("composer").textContent).toBe("livre");
    unmount();
    estado.grupo = { is_announce: false, papel: "membro" };
    render(<ComposerDeGrupo conversationId="c" conversa={conversa} />);
    expect(screen.getByTestId("composer").textContent).toBe("livre");
  });
});
