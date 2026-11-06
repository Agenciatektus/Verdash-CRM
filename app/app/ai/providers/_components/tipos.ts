export interface Ponto {
  id: string;
  rotulo: string;
  oQueFaz: string;
  papel: string;
  exige: { tools?: boolean; imagem?: boolean; audio?: boolean; embeddingDims?: number };
  sintomaDeFalha: string;
  fixo: { razao: string } | null;
  mandadoPeloAgente: boolean;
  efetivo: {
    provider: string;
    modelId: string | null;
    credentialId: string | null;
    baseUrl: string | null;
    origem: string;
    porQue: string;
  };
  avisos: string[];
}

export interface Modelo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price_per_million_cents: number | null;
}

export interface Credencial {
  id: string;
  provider: string;
  label: string;
  api_key_last4: string | null;
}

export interface Provedor {
  id: string;
  rotulo: string;
  quandoUsar: string;
  ondePegarAChave: string;
  /** Aceita apontar para outro endpoint (é compatível com a API da OpenAI). */
  aceitaEndpointProprio: boolean;
}

export interface Dados {
  papeis: Record<string, { rotulo: string; explicacao: string }>;
  pontos: Ponto[];
  provedores: Provedor[];
  credenciais: Credencial[];
  /** Há chave de IA no `.env` da instalação (`lerAmbiente`). */
  instalacaoTemChave: boolean;
  modelos: Modelo[];
  padrao: { provider: string; defaultModel: string | null };
  podeEditar: boolean;
}
