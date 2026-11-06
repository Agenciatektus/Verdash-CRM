---
impacto: capacidade_nova
secao: adicionado
titulo: Histórico de pagamentos das empresas gravado a partir do provedor
---

A cobrança passa a guardar cada pagamento confirmado das empresas (valor, data,
recibo e o que foi estornado ou contestado), relido na Stripe a cada
sincronização. Estornar pelo painel de admin já marca o pagamento como
estornado, e os avisos de estorno e de contestação da Stripe disparam a
releitura. Ainda não aparece na tela: é a base do histórico de pagamentos e das
comissões de afiliados. No Asaas o histórico fica vazio por enquanto.
