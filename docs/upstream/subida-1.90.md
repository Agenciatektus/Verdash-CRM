# Subida do upstream 1.90 (etapa 1 de 4 da rodada 1.85 → 1.102)

`git merge --no-ff -Xignore-space-change v1.90.0` sobre a `dev` (que tem a v1.85.0), na branch
`chore/subida-upstream-1.90`. Mesmo método de `subida-1.81.md` e `subida-1.85.md`: merge e não rebase, alvo na TAG,
e quando os dois lados mexem na mesma coisa a correção do upstream entra DENTRO da nossa versão.

- Entre v1.85.0 e v1.90.0: 1.864 commits, 47 migrations novas (0593..0766).
- Conflito em **210 arquivos / 483 trechos** (a 1.85 teve 43 arquivos). Próximas etapas: v1.95, v1.99, v1.102 + `main`.

## Regras que decidiram

As mesmas: o nosso prevalece quando colide (design system/molde de página, `components/ui`, checkbox nativo, app de
celular, Sidebar, Funil, provider verdash/FZAP, marca só do platform admin, `es`); do upstream entra tudo o que não
colide; mesma função alterada pelos dois = integra. **Trocar de funil MOVE o mesmo card, nunca clona.**

## Banco

### Colisão de carimbo (corrigida no upstream)

A `0657_rotulo_opaco_e_external_id_na_cascata` tinha o carimbo `20261013120000`, o mesmo da nossa 9051 (já aplicada em
produção). Renomeada para `20261013120001_0657_...`. Renomear a nossa faria o `db push` tratá-la como nova.
Depois disso nenhum carimbo nem NNNN se repete nesta etapa.

**Checador:** a partir desta subida o upstream também numera na faixa 9xxx. `scripts/checar-colisao-de-migration.sh`
passa a só AVISAR (`::warning`) NNNN repetido; carimbo repetido continua reprovando (o Supabase usa o timestamp como
identidade). Acompanham `tests/shell/colisao-de-migration.test.sh` e `tests/unit/manifest-x-migrations.test.ts` (aviso só
na faixa 9xxx). O passo de árvore do `ci.yml` ainda reprova NNNN repetido: ajustar junto com
`tests/unit/main-sem-migration-duplicada.test.ts` na etapa em que o upstream repetir um 9xxx nosso (v1.95).

### Objetos redefinidos pelos dois lados → migration `9099`

`20261105130000_9099_integracao_da_subida_1_90.sql` roda por último e deixa a versão INTEGRADA:

| objeto | upstream | fork | versão final |
|---|---|---|---|
| `agent_inbox_items_kind_check` | 0655 (`task_overdue`) | 9043/9055/9056/9058 | união |
| `passagens_de_atendimento_motivo_codigo_check` | 0693 (`verificacao_manual`) | 9019 (cadência) | união |
| `emit_event` | 0743 (`lead.date_field_due`) | 9054/9058 | 0743 + `ad_conversion.%` só do servidor e `lead.%` só agent+ |
| `fn_lgpd_cascade_redact_contact` | 0657 (rótulo opaco, `external_id`) | 9023/9058 | 0657 + Instagram + transcrição |
| `fn_attendant_metrics` | 0754 (mediana, etiqueta, 5 args) | 9053/9056 | 0754 + `crm_desfechos_de_negocio`; cai a de 4 args |
| `fn_enfileirar_midia_vencida` | 0731 (anexo do negócio) | 9033/9056 | 0731 + miniatura |
| `fn_google_appointment` | 0716 (agenda de serviço) | 9083 | 0716 + lock e `fn_agenda_lotada` no individual |
| `fn_service_inbound` | 0764 (grupo carimba o episódio) | 9094 | 0764 + o `elsif` sem regravação |
| `conversations_select` | 0726 (`fn_conversation_scope`) | 9027 (`fn_escopo_orgs`) | a nossa |
| agenda | 0716 recria o único do mesmo instante | 9083 (capacidade) | o índice cai de novo; `fn_agenda_respeita_capacidade` ignora turma e bloqueio |

`channel_sessions_tenant_*` (0752 × 9028/9055) não entram: definições idênticas.
Prova: `tests/invariants/integracao-da-subida-1-90-9099.test.ts` (precisa de banco).

### baseline.sql

Remontado como na 1.85: o que vinha antes da 9005; apêndices novos do upstream (0689..0766) antes da VARREDURA; os
nossos 9005..9097; bloco "SUBIDA 1.90 (migration 9099)" só com funções; VARREDURA e pós-varredura; apêndices do upstream
no fim; apêndice Tektus no FIM. As CHECKs ficam com a união no bloco único de cada constraint. Cortados dos apêndices do
upstream a `conversations_select` da 0726 e o índice `calendar_appointments_sem_duplicata_idx` da 0716
(`baseline-nao-constroi-o-que-derruba`).

### Antes do deploy

- **Conferir duplicata na agenda** (senão a 0716 falha no `create unique index` e o `db push` para antes da 9099):
  `select organization_id, owner_user_id, starts_at, count(*) from calendar_appointments where status in ('pending','confirmed') and owner_user_id is not null and not service_block and coalesce(service_booking_mode,'individual')='individual' group by 1,2,3 having count(*)>1;`
- Índices sem `concurrently` em tabela grande: `idx_crm_leads_org_pipeline_position_id` (0739, o mais pesado),
  `idx_contacts_name_lookup_pendente` (0593), `idx_contacts_org_fornecedor` (0763). Criar `concurrently` antes.
- Backfills da 0764 (`UPDATE conversations` e `UPDATE messages` de grupo): fora do pico, com `lock_timeout`.
- Tudo num `db push` só: entre as 47 e a 9099 a produção fica com as versões do upstream.
- Depois: `select indexrelid::regclass from pg_index where not indisvalid;` vazio.

## Decisões por área

| área | decisão |
|---|---|
| Inbox | Composer, InboxLayout, AudioPlayer, useSendMessage integrados; entram encaminhar mensagem, reações no balão, legenda só em anexo que aceita, AAC no Safari, chave de idempotência. Fora: tela cheia no celular, divisórias, recolher painel, `max-md`/`h-11` de toque, #3027 (nosso `useSugestaoDeResposta`). Não portados para a nossa bolha: motivo da falha + AckIndicator, reenvio com confirmação (`reenviar` existe em `useAlterarMensagem`, sem ligação), régua da apagada |
| Painel do contato | painel em abas nosso; carteira, anúncio, follow-up, últimas compras e selo de fornecedor portados para `painel/*` |
| Agente de IA | `inbound-turn.ts` com a nossa versão; mudanças do upstream portadas para `turno/*`; módulo novo `turno/entrada-do-agente.ts` (filtro de palavra-chave, janela, contagem da cadência) |
| Assumir/transferir | roda `sincronizarNegocioAbertoDoContato` (#3216) e depois o nosso `adotarLeadsDoContato` (o nosso prevalece) |
| Funil | quadro, seletor de vista e `ListaDoFunil` nossos; entram cards compactos e esconder encerrados antigos (#2995). Fora: aba Lista paginada do upstream (pendência: paginação na nossa) |
| Tabelas e páginas | molde e `TABELA_EMPILHADA` nossos; conteúdo novo do upstream dentro (tags com paginação e busca + nossas sugestões, título da agenda, MySQL em Dados externos) |
| Celular/PWA | ícones maskable, manifest e app de celular nossos; `notify-sw.js` do upstream inteiro (página offline dele) |
| CI | `ci.yml` com a divisão do upstream (7 partes) |
| Dependências | `zod` 4.6.7 com o nosso patch (sem os idiomas) reapontado |

## Requer atenção (CHANGELOG 1.86–1.90)

1. **Campos do contato**: em Configurações › Funis, marcar como "Contato" os campos que a equipe preenche na ficha,
   em cada organização. Até lá a ficha do contato não mostra campo personalizado.
2. **"Negócio criado" roda na Prospecção**: revisar regras com esse gatilho que enviam mensagem.
3. **Filtro de palavras do agente passa a valer**: conferir o campo em cada agente.
4. **`neq` em campo ausente deixa de disparar**: trocar por "está vazio" onde a intenção era "não preencheu".
5. **Custo do provedor personalizado** pelo preço do catálogo: conferir tetos em modo de bloqueio.
6. **Cobrança com planos**: definir o Plano do cadastro.
7. **Agenda e tarefas respeitam a visibilidade** com "Atendentes podem mexer na agenda dos colegas".

Ambiente: `PROSPECTING_LOCAL_HTTP_URL` (opcional). Crons novos no scheduler: `rodizio-devolucao`, `task-reminder`,
`contact-names`, `historico-import`, `agenda-resumo-do-dia`, `media-derive-retry` (o nosso `task-due-reminder` continua).
Compose: healthcheck do app a cada 10 s com 15 tentativas.

## Pontos para o @Cassio_SecRev

- 9099 inteira (tabela acima), em especial `emit_event` e a `_write`/policies que mexem em permissão.
- Contagem de turnos da cadência mudou de lugar (`roteamento.ts` → `entrada-do-agente.ts`, depois da janela): o turno
  que estoura o teto grava a decisão do roteador e o destino do card antes de parar.
- Assumir/transferir rodando as duas lógicas: a auditoria pode registrar `ja_tinha_responsavel` e o nosso passo trocar o dono.
- `lib/waha/ingest.ts` usa `lib/channels/eco-de-envio-nosso.ts` (agora com `ids` e status sent/delivered/read).
- `lib/agenda/consulta.ts`: agenda de serviço responde capacidade 1 e tolerância 0.
- `ai/cases/alerta` com `as never` em `p_resposta_whatsapp_habilitada` (`database.types` a regerar).
- Scheduler com `task-due-reminder` (nosso, 1 min) e `task-reminder` (upstream, 5 min): conferir lembrete duplicado.

## Testes da subida (CI vermelho depois do merge)

280 casos em 94 arquivos falharam por causa do merge; a dev estava verde. O que mudou:

- **Código que voltou às regras do fork:** barra lateral `sticky top-[var(--faixas-de-cima,0px)]` com altura descontando as faixas;
  grade do Inbox descontando as faixas; `Select` preserva o texto sob a tradução do navegador (correção do upstream, que a nossa
  `components/ui/select` não tinha); controles nativos do upstream (10 arquivos) trocados por `Escolha`/`CampoDeData`; dois
  client components voltam a importar `@/lib/i18n/traducao`; vitrine do DS não deixa a lista de fluxos de follow-up sair para a rede.
- **Código novo por defeito real:** `GET .../assinatura/estorno` engolia `mfa_required` como `forbidden`; as ações de funil dos pedidos
  da Nuvemshop não cobravam `mfaEmDivida`; reordenar dentro da coluna de ganho/perda não adia mais com o "Desfazer" de 5 s;
  `AudioPlayer` não converte áudio de nota interna; selo "Exemplo para a IA" na lista (também para quem só lê).
- **Testes adaptados (o código mudou de forma legítima):** fonte do turno remontada com a nova desestruturação de `corrigirAposOModelo`;
  snapshot do rastro do turno (entram `agent_turn_traces` e `prospecting_candidates`); dublês que ganharam dependência
  (`moduloDaEmpresa`, `instalacaoPodeServirIa`, `getAdapterOpcional`, `requireRole`, `usePermission`, `usePaisDaOrgAtiva`, `matchMedia`,
  QueryClient, `createSignedUrls`, `.not()` no dublê de banco); contagem de drenos da poda 17 para 18; convite de equipe com o molde nosso.
- **Casos do upstream removidos (feature fora ou substituída no fork):** `chat-thread-follow-latest` (nosso ChatThread é virtualizado),
  `Composer.sugestao` (#3027), cercas de toque/`max-md`/`h-11` (`toque-nos-primitivos`, `SearchTrigger`, `InterfaceEditor`, `tags-acoes`,
  tabelas empilhadas, nome da campanha, Aviso de proposta, `RequestsTable`, Segurança, Equipe, Desempenho), "Voltar aos casos",
  "Selecionar todos os visíveis" do celular, tela cheia do Inbox no celular, `EtapaNoDossie` ligado pelo quadro (o dossiê usa o nosso
  `SeletorDeEtapa`), filtro de responsável da tela de Tarefas, `message` do service worker (ninguém enviava `show-os-notify`).
- **Lista de herdados (`arquivos-grandes-herdados.json`):** +58 arquivos acima de 300 linhas. 25 vieram do upstream (novos); 33 já existiam
  e o upstream os fez crescer. Cinco ficaram acima de 300 também por acréscimo nosso: `lib/lgpd/redact-cascade.ts`,
  `lib/schemas/routing.ts`, `hooks/campanhas/useCampanhas.ts`, `contacts/[id]/crm-summary/route.ts`, `lib/campanhas/preparacao.ts`.

## Validação

Ver a descrição do PR.
