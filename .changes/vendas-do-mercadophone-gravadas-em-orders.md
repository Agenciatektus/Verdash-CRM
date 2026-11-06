---
impacto: capacidade_nova
secao: adicionado
titulo: Vendas do PDV MercadoPhone passam a ser gravadas no CRM
---

Cada venda salva no MercadoPhone chega ao CRM por webhook e é gravada como pedido,
ligada ao contato pelo telefone, com o card movido para "entregue" (ou "cancelado"
quando a venda é cancelada). A tela da integração agora mostra a URL completa do
webhook, já com a organização. Custo e lucro não são gravados.

Risco conhecido (shortcut): o nome do evento de cancelamento no webhook é suposto (qualquer tipo com "cancel"); ordens de serviço ainda são só arquivadas.
