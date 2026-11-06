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

Quem conectou a Stripe antes desta versão precisa reconectar a conta na tela de
cobrança: só assim o endpoint passa a receber os avisos de estorno e de
contestação. Sem reconectar, o histórico se atualiza na sincronização periódica.

Limites conhecidos: a leitura pega as 100 faturas mais recentes de cada empresa,
sem paginar; o pagamento avulso do ajuste proporcional (sem fatura) não entra; e
cada sincronização faz duas leituras a mais na Stripe (mais uma por cobrança
contestada).
