import { ScriptDoSite } from "@/app/app/settings/conversoes/_scriptDoSite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escolherValor } from "@/tests/unit/helpers/controles-do-ds";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormularioDeCapturaDeUtm } from "@/app/app/settings/conversoes/_formCapturaDeUtm";
import { FormularioDeConversoesGoogle } from "@/app/app/settings/conversoes/_formGoogle";
import { RegrasDeConversaoGoogle } from "@/app/app/settings/conversoes/_regrasGoogle";
const mock = vi.hoisted(() => ({
  salvarCaptura: vi.fn(),
  salvarGoogle: vi.fn(),
  salvarRegras: vi.fn(),
  criarAcao: vi.fn(),
}));
vi.mock("@/app/actions/settings/salvarRegrasDeConversaoGoogle", () => ({
  salvarRegrasDeConversaoGoogle: mock.salvarRegras,
}));
vi.mock("@/app/actions/settings/acoesDeConversaoGoogle", () => ({
  criarAcaoDeConversaoGoogle: mock.criarAcao,
}));
vi.mock("@/app/actions/settings/updateCapturaDeUtm", () => ({
  updateCapturaDeUtm: mock.salvarCaptura,
}));
vi.mock("@/app/actions/settings/updateGoogleAdsConnection", () => ({
  updateGoogleAdsConnection: mock.salvarGoogle,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.salvarCaptura.mockResolvedValue({ ok: true });
  mock.salvarGoogle.mockResolvedValue({ ok: true });
  mock.salvarRegras.mockResolvedValue({ ok: true });
  mock.criarAcao.mockResolvedValue({ ok: true, dados: { id: "555", nome: "Novo lead #abcde" } });
});
describe("formulários de conversão", () => {
  it("a captura Google salva destino e referência na plataforma certa", async () => {
    render(
      <FormularioDeCapturaDeUtm
        plataforma="google"
        estado={null}
        idioma="pt-BR"
        slug="loja"
        numerosConectados={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Para qual WhatsApp mandar"), {
      target: { value: "+5511999999999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar endereço de captura" }));
    await waitFor(() =>
      expect(mock.salvarCaptura).toHaveBeenCalledWith(
        expect.objectContaining({
          plataforma: "google_ads",
          whatsapp_e164: "+5511999999999",
          message_template: expect.stringContaining("[ref:{token}]"),
        }),
      ),
    );
    expect(screen.getByText(/O botão do site precisa repassar/)).toBeTruthy();
  });
  it("a conexão salva venda sem valor, categoria e telefone criptografado", async () => {
    render(
      <FormularioDeConversoesGoogle
        estado={{
          temRefreshToken: true,
          habilitada: true,
          customerId: "1234567890",
          loginCustomerId: null,
          conversionActionId: "11",
          modoDeValorDaVenda: "obrigatorio",
          categoriaDaVenda: "PURCHASE",
          enviarTelefone: false,
        }}
        idioma="pt-BR"
        configurado
        falta={[]}
      />,
    );
    escolherValor(screen.getByLabelText("Valor do negócio"), "quando_houver");
    fireEvent.click(screen.getByLabelText("Enviar o telefone do contato criptografado"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(mock.salvarGoogle).toHaveBeenCalledWith(
        expect.objectContaining({
          conversion_action_id: "11",
          purchase_value_mode: "quando_houver",
          purchase_category: "PURCHASE",
          send_hashed_phone: true,
        }),
      ),
    );
    // Sem developer token, "Criar no Google" aparece mas desligado — o ID segue colável.
    expect(
      (screen.getByRole("button", { name: "Criar no Google" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("as regras por etapa ligam o recomendado, criam a ação no Google e salvam a lista inteira", async () => {
    render(
      <RegrasDeConversaoGoogle
        etapas={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            nome: "Novo",
            funil: "Vendas",
            primeira: true,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            nome: "Qualificado",
            funil: "Vendas",
            primeira: false,
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            nome: "Negociação",
            funil: "Vendas",
            primeira: false,
          },
        ]}
        regras={[]}
        idioma="pt-BR"
        podeCriarAcao
      />,
    );
    expect(screen.getByTestId("etapas-enviando").textContent).toContain("0 de 3");
    fireEvent.click(screen.getByRole("button", { name: "Usar o recomendado" }));
    expect(screen.getByTestId("etapas-enviando").textContent).toContain("2 de 3");
    const criar = screen.getAllByRole("button", { name: "Criar no Google" });
    fireEvent.click(criar[0]!);
    await waitFor(() =>
      expect(mock.criarAcao).toHaveBeenCalledWith({
        nome: "Novo lead",
        categoria: "CONTACT",
        incluir_em_conversoes: true,
      }),
    );
    fireEvent.change(
      screen.getByLabelText("Ação de conversão (ID)", {
        selector: "#acao-22222222-2222-4222-8222-222222222222",
      }),
      {
        target: { value: "42" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar regras" }));
    await waitFor(() => expect(mock.salvarRegras).toHaveBeenCalledOnce());
    const enviadas = mock.salvarRegras.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(enviadas).toHaveLength(3);
    expect(enviadas[0]).toMatchObject({
      enabled: true,
      google_action_id: "555",
      category: "CONTACT",
    });
    expect(enviadas[1]).toMatchObject({
      enabled: true,
      google_action_id: "42",
      category: "QUALIFIED_LEAD",
      label: "Lead qualificado",
    });
    expect(enviadas[2]).toMatchObject({ enabled: false });
  });
  it("com grupos recolhidos, o recomendado abre quem ganhou etapa e salvar envia as etapas de TODOS os grupos", async () => {
    const id = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
    const { container } = render(
      <RegrasDeConversaoGoogle
        etapas={[
          { id: id(1), nome: "Novo", funil: "Tráfego", primeira: true },
          { id: id(2), nome: "Qualificado", funil: "Tráfego", primeira: false },
          { id: id(3), nome: "Novo", funil: "Disparo", primeira: true },
        ]}
        regras={[]}
        idioma="pt-BR"
        podeCriarAcao={false}
      />,
    );
    const grupos = () => [...container.querySelectorAll("details")];
    expect(grupos().map((g) => g.open)).toEqual([false, false]);
    fireEvent.click(screen.getByRole("button", { name: "Usar o recomendado" }));
    expect(grupos().map((g) => g.open)).toEqual([true, true]);
    // Recolhe um grupo (com etapa ligada dentro) e salva: nada some do envio.
    grupos()[0]!.open = false;
    fireEvent.click(screen.getByRole("button", { name: "Salvar regras" }));
    await waitFor(() => expect(mock.salvarRegras).toHaveBeenCalledOnce());
    const enviadas = mock.salvarRegras.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(enviadas.map((e) => e.stage_id)).toEqual([id(1), id(2), id(3)]);
    expect(enviadas.filter((e) => e.enabled)).toHaveLength(3);
  });
});

it("só gera o script com captura ativa salva, sem credenciais", () => {
  const { rerender } = render(
    <ScriptDoSite slug="loja" google={null} meta={null} idioma="pt-BR" />,
  );
  expect(screen.queryByRole("button", { name: "Copiar script do site" })).toBeNull();
  rerender(
    <ScriptDoSite
      slug="loja"
      google={{
        whatsappE164: "+5511999999999",
        messageTemplate: "Olá [ref:{token}]",
        habilitada: true,
      }}
      meta={null}
      idioma="pt-BR"
    />,
  );
  const code = screen.getByTestId("script-do-site").querySelector("code")!.textContent!;
  expect(code).toContain(window.location.origin + "/rastreio/v1.js");
  expect(code).toContain('data-google-whatsapp="5511999999999"');
  expect(code).not.toContain("data-meta-whatsapp");
  expect(screen.getByRole("button", { name: "Copiar script do site" })).toBeTruthy();
});
