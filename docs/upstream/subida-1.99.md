# Subida do upstream 1.99 (etapa 3 de 4 da rodada 1.85 → 1.102)

`git merge --no-ff v1.99.0` sobre a `dev` (que já tem a v1.95.0), na branch `chore/subida-upstream-1.99`. Mesmo método
de `subida-1.90.md` e `subida-1.95.md`: o nosso prevalece no que colide (DS, molde de página, Sidebar, Funil, Inbox,
painel de provedores dividido em arquivos, turno do agente em `turno/*`); a correção do upstream entra dentro; trocar de
funil MOVE o mesmo card (9053). 73 arquivos em conflito.

## Banco

### Carimbo repetido
| upstream | colidia com | decisão |
|---|---|---|
| `20261027120000_0790_aprendizado_com_prazo` | nossa `9076_cobranca_planos_inclui_ia` | upstream vira `20261027120001` |

Os NNNN 9027, 9033, 9046, 9050–9063, 9078, 9080 e 9083 do upstream repetem os nossos (só aviso no checador; a
identidade é o carimbo).

### A 9111 (FKs compostas em `crm_leads`) NÃO veio nesta etapa
A v1.99.0 não tem migration 9111 nem FK nova em `crm_leads` (as 21 migrations novas vão até `9083`). O risco fica para a
etapa 4 (v1.102). Quando vier, confira que `moverNegocioDeFunil` troca `pipeline_id` e `stage_id` no MESMO `UPDATE` e
rode antes, em produção, a contagem de dado legado inválido (precisa dar 0):

```sql
select count(*) from crm_leads l
 where not exists (select 1 from crm_pipelines p where p.id = l.pipeline_id and p.organization_id = l.organization_id)
    or not exists (select 1 from crm_stages s where s.id = l.stage_id and s.pipeline_id = l.pipeline_id
                    and s.organization_id = l.organization_id);
```

### Objetos redefinidos pelos dois lados → migration `9238`
`20261106220000_9238_integracao_da_subida_1_99.sql` roda depois de toda migration que mexe nesses objetos.

| objeto | upstream | fork | versão integrada |
|---|---|---|---|
| `fn_enfileirar_midia_vencida` | 9050 (#3756: a nota que perdeu o anexo grava `media_expired_at`/`media_retention_days` no passo 2c) | 9222 (prazo de mídia de grupo) | a 9222 letra a letra + o passo 2c da 9050; repete as duas colunas (`add column if not exists`) |
| grant por coluna de `importacoes_de_historico` | 9033 (colunas da queda: escopo, origem, desde, ate) | 9102 da dev (grant por coluna, sem `credencial_cifrada`) | o bloco da 9102 de novo, depois das duas: onde a 9102 rodou antes da 9033, as colunas novas ficariam sem leitura para `authenticated` |
| `fn_mesclar_contatos` | 9049 (1.95, #3721) recria a função inteira | 9010 (remendo por âncora: a fusão herda o IGSID e o @ do Instagram) | o bloco da 9010 de novo (pula quando já herda). **Na produção o remendo se perdeu quando a 9049 rodou (subida 1.95)**: a fusão de contatos não herda a identidade do Instagram até a 9238 rodar |
| `fn_definir_aviso_de_caso` / `fn_definir_aviso_de_agendamento` | 9078 (destino_modo + responsáveis, 9 args) / 9060 (grupo, 7 args) | 9231 da dev (exceção da conexão da própria org, nas assinaturas antigas de 7 e 6 args) | as do upstream com a exceção da 9231 no destino fixo; as assinaturas antigas caem |
| `channel_sessions_provider_ref_check` | — | 9023 (mesma regra, outra escrita) | recriada com a escrita do baseline |
| `agent_inbox_items_kind_check` | 9027/9033 | 9099 | sem integração: a lista da 9033 já contém todos os kinds da 9099 (+ `assinatura_desconectada`, `recuperacao_da_queda`, `cliente_sem_resposta_na_queda`) |

### baseline.sql
A cerca nova do upstream `baseline-e-cadeia-chegam-ao-mesmo-schema` compara o catálogo da instalação com o da cadeia;
por ela a 9238 passou a cobrir também `fn_mesclar_contatos`, a constraint de canal e os avisos. A 9033 (miniatura) entrou em
`MIGRATIONS_QUE_NAO_RODAM` daquela cerca: cria a trigger sem guarda e o baseline já a tem.
Montado com `git merge-file --diff3`. Grant de `fn_validate_lost_reason_required`: o nosso (`revoke ... from public, anon`).
Os dois blocos com base vazia: o do upstream primeiro e o nosso depois (apêndice Tektus segue no fim). Bloco
"SUBIDA 1.99 (migration 9238)" logo antes da VARREDURA anon.

### Antes do deploy
- Índice sem `concurrently` em tabela grande: `conversations_org_sector_awaiting` (9062, parcial `sector_id is not null`,
  mas o build lê a tabela inteira). Criar antes, fora do pico:
  `create index concurrently if not exists conversations_org_sector_awaiting on public.conversations (organization_id, sector_id, awaiting_since) where sector_id is not null;`
  Os demais (avisos, honorários, entregas de aviso, `agent_inbox_items`) são de tabela pequena.
- A 9050 só acrescenta colunas nullable em `conversation_notes` (sem backfill).
- Tudo num `db push` só: entre a 9050 e a 9238 a produção fica com a função do upstream sem o prazo de grupo.

## Decisões por área
| área | decisão |
|---|---|
| Turno do agente | portado para `turno/*`: espera da mídia que chega no meio do turno (#3836/#3845), adiamento por janela com rastro no payload (#3383), bloco da prévia por tipo (#3757), público do agente (#3722), voz ElevenLabs (Fase 6b), gate `horario_da_agenda` (#3596), pedido humano na prévia assistida (#3281) |
| Transcrição | fica a nossa escada (organização primeiro, instalação por último); entra o degrau 0 do ElevenLabs Scribe escolhido no painel |
| Painel de provedores | fica o nosso (arquivos separados); entram o menu fechado do ponto de transcrição (`fixo.opcoes`) no `CartaoDoPonto` e o `CartaoDeVoz` |
| Composer | fica o nosso; entram menção apagada sai da lista (#2463) e a faixa "a conversa continua em outro número" (#3732) |
| Funil | quadro, card e cabeçalho nossos (`compacto`); entram desempate por id (#3461) e funil arquivado em leitura (#1298: sem arraste, seleção, ações, lote, criar ou renomear). Fora: `denso` do upstream (é o nosso `compacto`) |
| Vocabulário | "Novo Lead" vira "Novo negócio" e o card se anuncia "Negócio" (#3811) |
| Automação | `assign_owner` do upstream (destino dinâmico, passagem SDR → Closer #3514) + o nosso `acompanharDonoNaConversa` depois de gravar o dono |
| Follow-up | gatilho por etapa usa `etapaQueOPointerArma` com o nosso corte de superfícies (cadência e campanha fora) |
| Event log | laço com sinal de trabalho e varredura espaçada de presos (upstream) + o nosso batimento; deps de teste entram por `opts.deps` |
| Assinatura do ChatGPT | renovação do upstream (#3371: marco da rotação, motivo da recusa) + a nossa espera pelo vencedor da trava e o `exp` do JWT |
| Inbox | cabeçalho, filtros, balão, painel lateral e tarefas nossos. Fora: escolha "devolver ao automático" ao fechar (#3313), canal no cabeçalho (#2383), badge sem hidratação (#3736), selo do pulo da agenda no balão (#3848), lateral sob medida (#3008) |
| Histórico do WhatsApp | estrutura modular e fonte Izzy da dev (#535) com a recuperação da queda do upstream dentro (escopo `so_crm`, `tocadas`, efeitos e avisos da queda). Sem escopo explícito: número = `so_crm`, Izzy = `todos` (migrar de outro CRM cria as fichas) |
| Sidebar | a nossa, com o link Ajuda (#3567) no rodapé |
| Dependências | versões do upstream, nosso `sharp` e os scripts de typecheck; lock regerado |

## Requer atenção (CHANGELOG 1.96–1.99)
1. **1.97: campos de seleção recusam valor fora da lista** (`custom_field_value_not_in_list`) pela API e pelo agente.
   Antes do deploy: conferir integrações e agentes que gravam texto livre em campo de lista.
2. **1.98: moeda da conta do financeiro** passa a ser sempre a da organização (`currency` do corpo é ignorado).
3. **1.97: aviso de transferência humana** vem LIGADO para quem já tem o Aviso no WhatsApp: o número interno passa a
   receber as transferências. Avisar os clientes ou desligar em Central de alertas.
4. 1.98: `quando_ha_compromisso` em regra e follow-up (padrão `adiar`, igual a antes).

## Pendências
- Inbox: portar #3313, #2383, #3736 e #3848 (ver tabela).
- O teste do upstream `lib/messaging/reenvio.test.ts` (#3848, `compromisso_na_agenda` → `nenhum`) ficou de fora: o arquivo
  é o nosso.
- Testes do upstream retirados porque testam tela que não é a nossa: `MessageBubble.pulo-da-agenda.test.tsx` (#3848),
  `KanbanCard.densidade.test.tsx` (`denso`, que no fork é `compacto`), `funil-arquivado-abre-em-leitura-quadro.test.tsx`
  (prop `funilInicial`; o arquivado em leitura do fork lê `is_archived` do quadro) e os casos #3313 que o merge acrescentou
  em `ConversationHeader.test.tsx`; também `hidratacao-do-badge-das-abas` (#3736), `composer-dicas-dos-icones` (linha de
  ações do compositor do upstream) e `inbox-atualizacao-na-lista` (#2366: a nossa lista usa `cacheDasConversas`). Voltam
  quando as features forem portadas.
- Assinatura do ChatGPT: fica a NOSSA janela de 5 minutos (medida em produção) com o marco da rotação do upstream. Os
  testes do upstream (`assinatura-uma-rotacao-por-janela`, `assinatura-recusa-diz-o-motivo`) foram ajustados para um par
  vencendo dentro da janela.
- 32 arquivos acima de 300 linhas entraram em `arquivos-grandes-herdados.json` (quase todos do upstream; do fork, os que
  cresceram com o porte: `CartaoDoPonto`, `turno/correcao-pos-modelo`, `Sidebar`, `ChannelHistorico`). Dividir depois.
- `app/app/ai/memory/_client.tsx` (validade do aprendizado) ficou como exceção da cerca de controle nativo: trocar por
  `CampoDeData` junto com o teste `memoria-validade-grava-ao-sair`. `HorarioDoSetor` já usa `Escolha`/`CampoDeData`.
- Typecheck a frio estoura memória no Windows; vale o job do CI.
