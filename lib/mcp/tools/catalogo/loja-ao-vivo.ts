/**
 * Capacidade de LOJA ONLINE AO VIVO: saldo e preço direto da Nuvemshop, não do acervo copiado.
 */
import { declararTools } from "./tipos";

export const TOOLS_LOJA_AO_VIVO = declararTools([
  {
    name: "crm_check_store_stock",
    category: "read",
    rotulo: "Ver estoque e preço na loja online",
    explicacao:
      "Consulta a loja online na hora e informa preço, promoção, link e quantas peças restam de cada tamanho e cor, para o assistente não prometer o que a loja não tem.",
    oQueToca: "Loja online conectada",
    risco: "seguro",
    pacotes: ["reter"],
  },
]);

export const TOOLS_PDV_AO_VIVO = declararTools([
  {
    name: "crm_check_pdv_stock",
    category: "read",
    rotulo: "Ver estoque e preço no PDV",
    explicacao:
      "Consulta o PDV da loja na hora e informa quais aparelhos e acessórios estão disponíveis para venda, com quantidade e preço, sem mostrar custo.",
    oQueToca: "PDV MercadoPhone conectado",
    risco: "seguro",
    pacotes: ["reter"],
  },
]);
