# Subida do upstream 1.95 (etapa 2 de 4 da rodada 1.85 → 1.102)

`git merge --no-ff v1.95.0` sobre a `dev`, que já tinha a v1.90.0 em produção (05/11/2026). 795 commits do upstream,
100 arquivos em conflito. Regras de sempre: o nosso prevalece no que colide (DS, molde de página, Sidebar, Funil,
celular, provider verdash/FZAP); a feature do upstream entra dentro; trocar de funil MOVE o mesmo card (9053).

## Banco

### Carimbos repetidos
| upstream | colidia com | decisão |
|---|---|---|
| `20261027180000_0808_grupos_de_resposta_rapida` | nossa 9077 | upstream vira `20261027180001` |
| `20261029120000_9041_contato_pessoa_fisica_endereco` | nossa 9084 | upstream vira `20261029120001` |

As nossas já rodaram em produção; renomear a nossa faria o banco tratá-la como nova. Os números 9016–9049 do upstream
repetem os nossos (só aviso no checador; a identidade é o carimbo).

### Objetos redefinidos pelos dois lados → migration `9100`
| objeto | upstream | fork | versão integrada |
|---|---|---|---|
| `conversations_select` | 0661/9016 | 9027/9099 | a nossa (escopo por `fn_escopo_orgs`) + o ramo de participante do atendimento conjunto |
| `fn_lgpd_cascade_redact_contact` | 0772/0797/9043 | 9023/9058/9099 | a 9043 deles (telefones extras, propostas de campos) + identidade do Instagram e transcrição |
| `fn_solicitar_reenvio_conversao` | 0803 | 9054/9055 | `LeadSubmitted` deles + régua da compra nossa |
| `fn_vocabulario_de_tags_operar` | 9023 | 9038/9058/9059 | a nossa 9059 + marcador minúsculo deles (#3507) |

### baseline.sql
Nos quatro blocos grandes os dois lados tinham acrescentado seções no mesmo ponto: entrou o bloco do upstream e
depois o nosso, o que mantém o apêndice Tektus no fim. Bloco "SUBIDA 1.95 (migration 9100)" logo antes da
VARREDURA anon, depois de todas as redefinições do upstream.

## Decisões por área
| área | decisão |
|---|---|
| Assumir conversa | entra `assumirConversaComEfeitos` do upstream; a rota passa `depoisDeAssumir` com o nosso `adotarLeadsDoContato(substituir)` e o audit segue com `leads_adotados` |
| Contagem da caixa | fica a nossa RPC (`fn_contagens_da_caixa`); o "Minhas" não conta conversa em que a pessoa só participa (#2848) |
| Transcrição | fica a nossa ordem (decisão de 26/10: organização primeiro, chave da instalação por último); entra o degrau OpenRouter (#3382) antes do A, só com credencial própria da organização |
| Turno do agente | #3333 (a fala só afirma registro depois que ele existe), vetos irrevogáveis, `semConteudoVisivel` e `PASSOS_DA_CORRECAO` portados para `turno/*`; as métricas `duracao_do_turno_ms`/`classificadores_ms` não |
| Inbox | Composer ganha arrastar arquivo (#3708) e grupos de respostas rápidas (#3245); balão mostra o nome do agente de IA (#3649); documento baixa com o nome original (#2613); convidado do atendimento conjunto escreve sem assumir. Fora: recolher painel (#3004), divisórias (#2579), lateral sob medida (#3008), "+N" das etiquetas, menções de grupo no balão (#3566) |
| Funil | dossiê e card ganham atalhos (#3487), arquivos no card e valor recorrente (9028); mover para outro funil escolhe a etapa de entrada (#3643). A lista paginada do upstream não entra (fica a nossa `ListaDoFunil`) |
| Respostas rápidas e modelos | telas do upstream (`ListaDeRespostas` com grupos; criar/editar/apagar modelo do canal oficial) |
| E-mails | fica o nosso layout com a marca |
| Login | cache do `getUser` (#3696) com o nosso retry de falha de infra |

## Requer atenção (CHANGELOG 1.91–1.95)
1. **Trava de número novo** (1.91): número com menos de 31 dias de envio segura os retornos automáticos até alguém
   liberar na Central ("Número novo aguardando liberação"). A 0793 libera sozinha os já formados na atualização.
   Depois do deploy: conferir na Central quais números ficaram presos.
2. Setores de atendimento (0801) e atendimento conjunto chegam desligados até configurar.

## Pendências
- Telas do upstream que entraram inteiras (respostas rápidas, modelos do canal oficial): conferir no padrão do DS.
- O typecheck a frio estoura 6 GB no Windows; no CI (Linux) vale o resultado do job.
- Sem teste do degrau A0 (OpenRouter) da escada de transcrição.
