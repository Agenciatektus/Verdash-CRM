# ADR-0006: Fatiar o turno da IA (`executarTurnoDoAgente`) em fases, uma PR por fase

- **Status:** aceito (OK do Peterson em 30/10/2026)
- **Data:** 2026-10-30
- **Contexto medido em:** `3ba2fe36d` (topo de `origin/dev` em 30/10/2026), por mapa da função (comandos de nível 1 e 2, `return`, chamadas de alto nível), não por leitura linha a linha
- **Arquivo:** `lib/agent-engine/agent/inbound-turn.ts` (6.090 linhas; a função ocupa 1944 a 5694, cerca de 3.750)

---

## Contexto

`executarTurnoDoAgente` é o turno da IA: os três kinds de turno de lead (`inbound_turn`, `followup_turn`,
`case_reply_turn`) e o preview (`runAgentPreview`, linha 5696) passam por ela. É o caminho mais quente e o
mais caro do CRM, porque concentra todas as chamadas de modelo do turno. Ela não é exportada de propósito: o
único chamador vivo é `runAgentTurn` (1852), que a envolve na escolta de orçamento
(`comHandoffSeOrcamentoAcabar`), e `tests/unit/handoff-por-orcamento.test.ts` conta exatamente um call site
pela AST.

O arquivo já perdeu peso antes por extrações pontuais (`classificadores-do-turno.ts`, `roteiro-no-turno.ts`,
`turno-mudo.ts`, `atraso-humano.ts` e dezenas de módulos irmãos em
`lib/agent-engine/agent/`). O que sobrou é o encadeamento: estado mutável compartilhado por closures, 11
saídas antecipadas (`return` nas linhas 2007, 2166, 2198, 2217, 2220, 2312, 2322, 2661, 2701, 5281, 5348) e
96 menções a `preview` espalhadas pelos ramos.

### Mapa das fases reais (hoje)

| # | Fase | Linhas | O que faz | Efeitos colaterais | Estado que passa adiante |
|---|---|---|---|---|---|
| F1 | Identidade do turno | 1944-1994 | `tenantId`, `leadId`, `clock`, `runLog`, `contextKnobs` | nenhum | ids, relógio, log |
| F2 | Portões de entrada | 1995-2150 | camadas da org, fuso, lead em handoff (sai), elegibilidade por allowlist (sai), janela anti-ban (reagenda e sai) | `rescheduleJob` | `camadas`, `fusoDaOrg` |
| F3 | Roteamento e configuração do agente | 2151-2418 | `resolveConversationTurn` (pode chamar modelo), condução vs assistido (sai), pausado/assistido (sai), janela de atendimento com aviso fora do horário, contagem da condução (sai), log da decisão do roteador, destino do card pela intenção | envio do aviso, `pool.query` do log, move card, reagenda | `routed`, `agentConfig`, `agentOperation`, destino |
| F4 | Contexto e system prompt | 2419-2553 | `maxSteps`, `argsAux`, `Promise.all` de playbook, skills, memória da org, checkpoint anterior e estado do lead; `composeSystemPrompt`; `get_lead_context` de abertura (lança se falhar) | só leitura | `system`, `openingContext`, `skills`, `leadState`, `previous`, `currentInboundText` |
| F5 | Desvios determinísticos | 2554-2708 | instancia o canal e o "digitando", LGPD, aviso de escalação, inbounds pendentes; pedido de humano (avisa, passa e sai); suspeita de opt-out (confirma e sai) | **envio ao lead**, handoff | `channel`, `optedOutThisTurn`, `inboundsPendentes`, `mensagemDoJob` |
| F6 | Roteiro, compactação e blocos auxiliares | 2709-2856 | `prepararRoteiroDoTurno`, `maybeCompact` (chamada de modelo), notas, compromissos e origem em paralelo, cancelamento de crons no opt-out | compactação grava; cancela crons | `roteiro`, `effectivePrevious`, `effectiveContext`, blocos |
| F7 | Estado mutável e armação dos guardrails | 2857-3137 | `seq`, `corposEnviados`, `dupTrava`, contadores de veto, tabela de promessas, evidências comerciais, classificador semântico, conferidor de afirmações, pacing, `outcomes`, `runError`, matching de skills, telemetria | telemetria de skill | **o estado do turno** (ver abaixo) |
| F8 | Ferramentas do modelo (closures) | 3138-4442 | `rawTools`: `get_lead_context` 3141, `send_template` 3189, `search_knowledge` 3313, **`send_message` 3354-4018** (formatação, corpo vazio, trava de duplicata, falso vazio, teto de envios, fotos, cadeia `runBeforeSend` com vetos e re-tentativas, citações), `update_lead_state` 4019, `save_lead_note` 4091, `get_lead_note` 4124, `request_human_handoff` 4156; depois follow-up, `read_skill_reference`, desligamento do handoff e ferramentas de caso | todos os envios e gravações do turno acontecem aqui, durante a chamada de modelo | `rawTools` e mutação do estado do turno |
| F9 | Montagem da chamada | 4443-4939 | "digitando", ferramentas MCP, capacidades entregues ao Operador, ferramentas da condução e do preview, `wrapToolsWithBreaker`, classificadores auxiliares em paralelo (etapa, jailbreak, Jev), abertura (`buildOpening`, bolhas, caso aguardando, agora, condução), atraso humano | gravação do Jev | `tools`, `openingMessages`, `stageSuggestion`, `jailbreakLevel` |
| F10 | Chamada do modelo | 4940-5030 | `runModelCall`, saída truncada, escalação por jailbreak com promessa fora da tabela, relança `runError`, falha de envio | handoff na escalação | `turn`, `saidaTruncada` |
| F11 | Pós-modelo e correções | 5031-5305 | correção do turno mudo (2ª chamada de modelo), silêncio sem razão legítima, pergunta garantida do roteiro, `toolPartsAsText`, saída do assistido (sai), agenda atual | envio da correção, rascunho | `responseMessages`, `agendaAtual` |
| F12 | Fechamento e checkpoint | 5306-5371 | `fecharOTurno` (chamada de modelo), saída do preview (sai), `insertCheckpoint` | grava checkpoint | `content`, `checkpointAnterior` |
| F13 | Efeitos pós-turno | 5372-5688 | enfileira o Operador, `diffCheckpoint` e emissão, lead ativo e etapa, candidato a golden, outcome bloqueado, reagendamento pelo teto de envio, log de conclusão | `enqueueJob`, emissões, `rescheduleJob` | nenhum |
| F14 | `finally` | 5689-5693 | para o "digitando", `mcpCleanup` | limpeza | nenhum |

**O estado do turno.** O acoplamento real está em F7 a F13: as closures de F8 escrevem e as fases depois do
modelo leem. As variáveis são `seq`, `corposEnviados`, `dupTrava`, `turnoDescartado`, `tentativasDeEnvio`,
`passouParaAEquipe`, `confirmedStage`, `outOfTablePromiseAttempted`, `openedCaseThisTurn`, os quatro
contadores de veto, `jaEsperouComoHumano`, `pacingCapVeto`, `agendaToolCalledThisTurn`,
`followupAgendadoNesteTurno`, `outcomes`, `pendingCitations` e `runError`. Enquanto isso for `let` solto no
escopo da função, nenhuma ferramenta sai do arquivo.

---

## Decisões

### D1: Mover, não reescrever

Cada fatia é movimento de código: o corpo da fase vai para um módulo novo como está, e a função passa a
chamá-lo. Nenhuma fatia muda regra, ordem, texto de log, nome de evento ou número de chamadas de modelo. Correção
de bug encontrada no caminho vira PR separada, depois.

### D2: Fase com efeito não finge ser pura

"Módulo puro por fase" vale para as decisões (F2, F4, F7 e o cálculo de F13). As fases que falam com o lead
(F3, F5, F8, F10, F11) recebem as portas que já existem (`pool`, `ChannelAdapter`, `deps`) por parâmetro; o
ganho é a fronteira tipada, não a pureza.

### D3: Saída antecipada vira valor

Toda fase que hoje dá `return` devolve uma união discriminada, e só o orquestrador sai:

```ts
type Passo<T> = { seguir: true; valor: T } | { seguir: false; motivo: string };
```

O `motivo` é o texto do log que já existe, para o log não mudar.

### D4: `EstadoDoTurno` nasce uma vez, no orquestrador

```ts
interface EstadoDoTurno {
  seq: number; corposEnviados: string[]; dupTrava: TravaDeDuplicata;
  turnoDescartado: boolean; tentativasDeEnvio: number; passouParaAEquipe: boolean;
  confirmedStage: LeadStage | null; outOfTablePromiseAttempted: boolean; openedCaseThisTurn: boolean;
  vetos: { casePromise: number; internalVocabulary: number; clinicalClaim: number; falseEmptyInbound: number };
  jaEsperouComoHumano: boolean; pacingCapVeto: { code: string; nextAllowedAt: Date } | null;
  agendaToolCalledThisTurn: boolean; followupAgendadoNesteTurno: boolean;
  outcomes: ChannelSendResult[]; pendingCitations: Citation[]; runError: Error | null;
}
```

Os nomes de tipo `TravaDeDuplicata` e `Citation` são ilustrativos (hoje são inferidos de `criarTravaDeDuplicata` e `citationsFromHits`). Criado por `criarEstadoDoTurno()` uma única vez e passado por referência. Nenhum módulo de fase cria o seu.

### D5: Interfaces das fases

`ContextoDoTurno` é o que F1 produz: `{ deps, pool, job, ctx, input, preview, tenantId, leadId, clock, runLog }`.

| Módulo novo | Função | Entrada | Saída |
|---|---|---|---|
| `turno/portoes-de-entrada.ts` | `avaliarPortoesDeEntrada` | `ContextoDoTurno` | `Passo<{ camadas; fusoDaOrg }>` |
| `turno/roteamento-do-turno.ts` | `rotearOTurno` | `ContextoDoTurno`, `{ camadas; fusoDaOrg }` | `Passo<{ routed; agentConfig; agentOperation; destino }>` |
| `turno/contexto-do-turno.ts` | `carregarContextoDoTurno` | `ContextoDoTurno`, `agentConfig` | `{ system; openingContext; skills; currentInboundText; leadState; previous; playbook; orgMemory; maxSteps; argsAux }` (lança como hoje se a abertura falhar) |
| `turno/desvios-deterministicos.ts` | `desviarSeDeterministico` | `ContextoDoTurno`, `agentConfig`, `openingContext`, `channel` | `Passo<{ inboundsPendentes; optedOutThisTurn; mensagemDoJob }>` |
| `turno/preparo-do-contexto.ts` | `prepararRoteiroECompactar` | `ContextoDoTurno`, saída de F4 e F5 | `{ roteiro; effectivePrevious; effectiveContext; blocos }` |
| `turno/estado-do-turno.ts` | `criarEstadoDoTurno`, `armarGuardrails` | `ContextoDoTurno`, `agentConfig`, `effectiveContext` | `EstadoDoTurno`, `Guardrails` (classificador, conferidor, evidências, pacing, skillMatch) |
| `turno/ferramentas/*.ts` | `criar<Ferramenta>` | `ContextoDoTurno`, `EstadoDoTurno`, `Guardrails`, `channel` | `Tool` |
| `turno/montagem-da-chamada.ts` | `montarAChamada` | `ContextoDoTurno`, `rawTools`, `EstadoDoTurno` | `{ tools; openingMessages; stageSuggestion; jailbreakLevel; mcpCleanup }` |
| `turno/chamada-e-correcao.ts` | `chamarOModelo`, `corrigirAposOModelo` | montagem, `EstadoDoTurno` | `{ turn; responseMessages; agendaAtual }` ou `Passo` no assistido |
| `turno/efeitos-pos-turno.ts` | `aplicarEfeitosPosTurno` | `ContextoDoTurno`, `EstadoDoTurno`, `{ content; checkpointAnterior; stageSuggestion; turn }` | `void` |

`executarTurnoDoAgente` fica no mesmo arquivo, com o mesmo nome e o mesmo call site, como orquestrador de
algumas centenas de linhas. `runAgentTurn`, a escolta e `runAgentPreview` não mudam.

---

## Rede de segurança

### O que já cobre o turno

| Tipo | Quantidade | Como roda | O que prova |
|---|---|---|---|
| Invariantes com Postgres real (`tests/invariants/`) que chamam `runAgentTurn`, `createInboundTurnHandler` ou `runAgentPreview` | 20 arquivos (ex.: `turno-nao-responde-duas-vezes`, `limite-de-envios-por-turno`, `turno-mudo-pede-uma-correcao`, `case-guardrail`, `janela-de-resposta-no-turno`) | `pnpm test:db`, no CI em `.github/workflows/ci.yml:674` | comportamento de ponta a ponta, com modelo falso |
| Unitários comportamentais pelos mesmos pontos de entrada | 18 em `tests/unit/` + `lib/agent-engine/agent/followup-turn.test.ts` | `pnpm test:unit` | ramos específicos (assistido, MCP, quarentena, follow-up, duplicata próxima) |
| Cercas por texto-fonte que leem `inbound-turn.ts` | 39 arquivos em `tests/unit/` (ex.: `send-message-duplicata-proxima`, `correcao-do-turno-mudo-so-escala-com-falha`, `saida-truncada-nao-vai-parcial`, `assistido-roda-as-deteccoes`) | `pnpm test:unit` | que um trecho existe, em certa ordem, dentro da função |
| Cerca de AST do call site único | `handoff-por-orcamento.test.ts` | `pnpm test:unit` | a função só roda escoltada |

`grep -rln executarTurnoDoAgente tests` acha só 4 arquivos; os outros chegam ao turno pelos pontos de entrada.

### O que falta ANTES do primeiro corte

1. **Inventário das 39 cercas por texto.** Uma cerca que procura `toContain` dentro de
   `trecho('async function executarTurnoDoAgente(')` fica vermelha quando o código sai do arquivo (barulhenta,
   aceitável). Uma cerca negativa (`not.toContain`, "isto não aparece antes daquilo") fica **verde sem medir
   nada** depois do movimento. Cada cerca é classificada (positiva, negativa, de ordem) e ganha o arquivo-alvo
   da fatia que a afeta. Cerca negativa é reapontada na mesma PR do movimento, com controle negativo: colar o
   trecho proibido no módulo novo e ver a cerca ficar vermelha.
2. **Teste de caracterização do turno (rastro de efeitos).** Um único teste (entregue em `tests/unit/`, com dublês e sem Postgres; ver abaixo)
   (`turno-rastro-de-efeitos.test.ts`), com Postgres real, modelo roteirizado e canal falso, que grava a
   **sequência ordenada** de efeitos de cada cenário e compara com um snapshot versionado:
   - SQL normalizado (verbo + tabela, sem valores), na ordem em que chegou ao pool;
   - envios do canal (tipo, corpo, `seq`);
   - chamadas de modelo por propósito (roteador, compactação, classificadores, principal, correção, fechamento);
   - `rescheduleJob` e `enqueueJob` (motivo, kind);
   - o `motivo` de cada saída antecipada.

   Cenários mínimos: inbound feliz com dois `send_message`; lead em handoff; fora da janela anti-ban; pedido
   de humano determinístico; suspeita de opt-out; mesmo corpo enviado duas vezes; teto de envios por turno;
   turno mudo com correção; saída truncada; veto de vocabulário interno até o teto; escalação por jailbreak;
   assistido; preview (zero escrita); `followup_turn`; `case_reply_turn`. O snapshot é gerado **na base atual,
   antes de qualquer movimento**, e só pode mudar numa PR que não seja de movimento.

O teste nasce com controle negativo: trocar a ordem de dois efeitos à mão no código precisa deixá-lo vermelho
(contagem igual não pega ordem invertida).

---

### Inventário das cercas por texto (S0, medido em 30/10/2026)

42 arquivos de teste leem `inbound-turn.ts` como texto. **Positiva**: só exige que um trecho exista ou venha
em certa ordem (fica vermelha quando o código sai do arquivo, barulhenta). **Negativa**: tem pelo menos uma
asserção de ausência (`not.toContain`, `not.toMatch`, `toBe(-1)`) e pode ficar verde sem medir nada depois do
movimento. A contagem é de asserções negativas no arquivo; a fatia e o destino vêm da âncora que a cerca
procura. "Verificar" marca cerca sem âncora legível pelo grep, a ler na fatia indicada antes do corte.

| Cerca (`tests/unit/` salvo indicação) | Tipo | Neg. | Fatia | Reapontar para |
|---|---|---|---|---|
| `lib/.../formato-whatsapp.test.ts` | positiva | 0 | S7 | (barulhenta) `turno/ferramentas/send-message.ts` |
| `lib/.../roteiro-no-turno.test.ts` | negativa | 3 | S9 | `turno/chamada-e-correcao.ts` |
| `lib/.../presets.test.ts` | negativa | 3 | verificar | provável fora da função; confirmar antes de S1 |
| `agent-split-message` | negativa | 4 | S8 | `turno/montagem-da-chamada.ts` (bolhas) |
| `agent-split-send` | positiva | 0 | S7 | (barulhenta) |
| `assistido-roda-as-deteccoes` | positiva | 0 | S4 | (barulhenta) |
| `atraso-humano-nao-afrouxa-o-anti-ban` | negativa | 2 | S8 | `turno/montagem-da-chamada.ts` |
| `camada-lida-no-motor` | positiva | 0 | S1 | (barulhenta) |
| `cerca-prometer-de-ponta-a-ponta` | negativa | 5 | S6 | `turno/ferramentas/` (`schedule_followup`) |
| `chave-juridico-so-troca-a-descricao` | negativa | 4 | S6 | `turno/ferramentas/` (desligamento do handoff) |
| `classificadores-auxiliares-em-paralelo` | positiva | 0 | S8 | (barulhenta) |
| `classificadores-so-na-mensagem-nova` | negativa | 6 | S8 | `turno/montagem-da-chamada.ts` |
| `correcao-do-turno-mudo-so-escala-com-falha` | negativa | 8 | S9 | `turno/chamada-e-correcao.ts` |
| `dry-run-prepara-midia-como-o-envio-real` | positiva | 0 | S8 | (barulhenta) |
| `etapa-de-perda-avisa-o-humano` | negativa | 7 | S6 | `turno/ferramentas/update-lead-state.ts` |
| `fechamento-do-turno-corrige-antes-de-repetir` | negativa | 2 | S9 | `turno/chamada-e-correcao.ts` |
| `fotos-respeitam-teto-e-tamanho` | negativa | 1 | S7 | `turno/ferramentas/send-message.ts` |
| `gate-afirmacao-clinica` | negativa | 4 | S7 | `turno/ferramentas/send-message.ts` |
| `gate-agenda-stall` | negativa | 4 | S7 | `turno/ferramentas/send-message.ts` |
| `gate-vazamento-interno` | negativa | 3 | S7 | `turno/ferramentas/send-message.ts` |
| `handoff-avisa-o-lead` | positiva | 0 | S5 | (barulhenta) |
| `handoff-fantasma-fiacao` | positiva | 0 | S6/S7 | (barulhenta) |
| `handoff-por-orcamento` | negativa | 4 | nenhuma | conta o call site único, que fica em `inbound-turn.ts`; não reapontar |
| `janela-do-matcher-fica-no-matcher` | positiva | 0 | S8 | (barulhenta) |
| `knobs-da-versao-publicada-sao-aplicados` | negativa | 1 | nenhuma | âncora fora da função (`PublishedAgentConfig`) |
| `mensagem-atual-prioritaria` | negativa | 1 | S8 | `turno/montagem-da-chamada.ts` (abertura) |
| `mensagem-que-tem-texto-nao-chega-vazia` | negativa | 4 | verificar (S2) | `turno/contexto-do-turno.ts` se a âncora estiver em F4 |
| `operador-enfileiramento` | positiva | 0 | S3 | (barulhenta) |
| `ponte-do-agente-passa-o-escopo` | positiva | 0 | verificar | |
| `pr-mexe-no-piso-do-postgres` | positiva | 0 | verificar | |
| `rajada-nao-cala-o-pedido-de-humano` | negativa | 2 | S5 e S7 | `turno/desvios-deterministicos.ts` e `send-message.ts` |
| `recorte-1-build-opening` | negativa | 5 | S8 | `turno/montagem-da-chamada.ts` |
| `retencao-das-tabelas-da-ia` | negativa | 1 | verificar | provável fora da função |
| `saida-truncada-nao-vai-parcial` | negativa | 4 | S9 | `turno/chamada-e-correcao.ts` |
| `seguranca-supressao-duplicata-e-desfecho-terminal` | negativa | 8 | S1 e S2 | `turno/portoes-de-entrada.ts` e `turno/contexto-do-turno.ts` |
| `send-message-corpo-vazio` | positiva | 0 | S7 | (barulhenta) |
| `send-message-duplicata-proxima` | negativa | 6 | S6 e S7 | `turno/estado-do-turno.ts` (semeadura) e `send-message.ts` |
| `send-message-manda-foto-do-produto` | positiva | 0 | S7 | (barulhenta) |
| `send-template-wiring` | negativa | 1 | S7 | `turno/ferramentas/send-template.ts` |
| `silencio-da-janela-deixa-rastro` | negativa | 2 | S1 e S4 | `turno/portoes-de-entrada.ts` e `turno/roteamento-do-turno.ts` |
| `sinal-de-urgencia-represado` | negativa | 5 | S3 | `turno/efeitos-pos-turno.ts` |
| `turno-responde-a-mensagem-do-job` | positiva | 0 | verificar | |

Resumo: 27 negativas, 15 positivas. Regra para cada fatia: antes do movimento, a PR lista as cercas da sua
linha, reaponta as negativas para o módulo novo e prova cada uma com controle negativo (colar o trecho
proibido no módulo novo e ver a cerca ficar vermelha).

### Teste de caracterização entregue (S0)

`tests/unit/turno-rastro-de-efeitos.test.ts`, com o snapshot em
`tests/unit/__snapshots__/turno-rastro-de-efeitos.test.ts.snap`. Roda na suíte unitária, sem Postgres: pool
fingido (o de `turno-le-em-paralelo`), `runModelCall` roteirizado por cenário e canal falso por
`deps.channel`. Grava em ordem:

- `db:` cada escrita (verbo e tabela), inclusive todas as de um CTE na ordem textual; `db:call fn_x` para
  função do banco chamada como `select * from fn_x(...)`; o `status` gravado no SET de `agent_inbox_items`,
  `contacts` e `conversations`; e as transações;
- `send:`, `llm:<purpose>`, `tool:<nome> ok|recusou <code>`, `job:` e os avisos de log.

São 14 cenários, mais um de determinismo e o controle negativo de ordem. O controle lê o `.snap` do disco e
prova que o bloco do cenário contém a ordem original de dois efeitos vizinhos e não contém a trocada.

O cenário "assistido: vira rascunho, nada sai" percorre o desvio real (`inbound-turn.ts:2172-2216`): o pool
responde ao claim do turno autônomo, à fronteira de atendimento e ao `fn_reply_begin`, e o rastro mostra
`llm:agent_preview` sem nenhum `llm:agent_turn`, a gravação em `ai_reply_drafts` e `fim:ok`.

#### Lacunas da S0 (revisão do `cassio-secrev` na PR #468)

| Lacuna | Por que ficou | Fatia que precisa dela |
|---|---|---|
| Horário de atendimento: o pool não devolve linhas de horário | `inbound-turn.ts` lê `new Date()` direto nas linhas 2819, 2824, 4361 e 5826 (em `3ba2fe36d`); devolver horário sem injetar o relógio deixaria o rastro dependente da hora | injeção do relógio antes de S5 (2819, 2824), S6 (4361) e S9 (5826); a injeção é mudança de comportamento e vai em PR própria, fora das fatias de movimento |
| P2-2: o dublê do modelo devolve `responseMessages: []` e `steps: []`; a fita do turno chega vazia em `pruneToolResults`/`toolPartsAsText` e no checkpoint, então uma fatia que perca a fita passa verde | devolver as partes de tool-call/tool-result roteirizadas e gravar `llm:checkpoint msgs=N` | S8 |
| P2-6: os classificadores do `Promise.all` (estágio, jailbreak, manipulação) não rodam, porque os knobs do agente do teste estão desligados | cenários com os knobs ligados e ordem determinística do `Promise.all` | S9 |
| Classificadores auxiliares (`stage_classifier`, `jailbreak_detect`) fora do rastro: os knobs estão desligados no dublê | cenários com eles ligados pedem roteiro de saída de cada classificador | S8 |
| Preview puro, `followup_turn`, `case_reply_turn`, saída truncada, veto até o teto, escalação por jailbreak, reagendamento pela janela anti-ban | fora da primeira leva de cenários | o cenário entra na PR anterior à fatia que move o trecho (S1, S5, S7, S9) |
| `status` gravado por expressão aparece como `status=case`, sem o valor | o rastro lê o texto do SQL, não o resultado | nenhuma; basta para detectar mudança de ordem ou de alvo |

---

## Fatias (uma PR por fatia, em ordem de risco crescente)

Critério comum a todas: snapshot do rastro idêntico; `pnpm typecheck` (com `.tsbuildinfo` apagado),
`pnpm test:unit` e `pnpm test:db` verdes; `git diff --color-moved=dimmed-zebra` mostra o corpo movido sem
alteração além de parâmetros; nenhum `as never` ou `as any` novo nas interfaces; cercas afetadas reapontadas;
revisão do `cassio-secrev` com P0 e P1 resolvidos. Reverter: cada fatia é um commit squash sem migração e
sem flag, então `git revert <sha>` na `dev` volta ao estado anterior; fatia posterior que dependa dela é
revertida antes.

| # | Fatia | Fases | Por que nesta posição | Aceite específico | Esforço |
|---|---|---|---|---|---|
| S0 | Rede: inventário das cercas + teste de rastro | nenhuma (só testes) | sem ela nenhuma outra prova nada | snapshot gerado na base; controle negativo de ordem vermelho; tabela das 39 cercas no PR | M |
| S1 | Portões de entrada | F2 | sem modelo, sem envio, saídas simples | cenários "handoff", "fora da janela" e "não elegível" com rastro igual | P |
| S2 | Contexto e system prompt | F4 | só leitura | `turno-le-em-paralelo` verde (o `Promise.all` segue único); `system` byte a byte igual no rastro | P |
| S3 | Efeitos pós-turno | F13 | lê o estado no fim, não fala com o lead pelo modelo | ordem enfileirar Operador, emissão, etapa, golden, bloqueio, reagendamento igual no rastro | M |
| S4 | Roteamento e configuração | F3 | envia o aviso fora do horário e move card | cenários assistido, pausado, condução encerrada e fora do horário iguais; contagem de chamadas do roteador igual | M |
| S5 | Desvios determinísticos + preparo | F5 e F6 | fala com o lead antes do modelo; compactação chama modelo | um único aviso por cenário de pedido de humano e de opt-out; chamadas de compactação iguais | M |
| S6 | `EstadoDoTurno` + ferramentas simples | F7 e F8 menos `send_message`/`send_template` | introduz o objeto de estado sem tocar no envio | `criarEstadoDoTurno` chamado uma vez (cerca de AST, como a do call site); rastro igual | M |
| S7 | `send_message` e `send_template` | F8 (3189-4018) | o envio e a cadeia de guardrails, o ponto mais caro de errar | cenários de duplicata, teto, vetos e fotos iguais; `turno-nao-responde-duas-vezes` e `limite-de-envios-por-turno` verdes | G |
| S8 | Montagem da chamada | F9 | classificadores e abertura; muda o prompt se errar | `openingMessages` e conjunto de ferramentas iguais no rastro; classificadores seguem em paralelo | M |
| S9 | Modelo, correção e fechamento | F10 a F12 | três chamadas de modelo e o checkpoint | contagem e ordem das chamadas por propósito iguais; checkpoint igual | G |

Esforço: P cabe numa sessão; M, uma a duas; G, duas ou mais, com revisão dedicada.

---

## Riscos e como cada fatia prova que nada mudou

| Risco | Onde morde | Prova |
|---|---|---|
| **Ordem dos efeitos colaterais.** Transformar `const` em argumento pode adiantar ou atrasar um `await` (ex.: abrir o `Promise.all` de F4 antes do aviso de F3) | S2 a S5, S9 | rastro ordenado por cenário; controle negativo de ordem em S0 |
| **Envio duplicado.** `dupTrava`, `seq` e `corposEnviados` valem por turno; se um módulo criar o próprio estado, a trava zera e o lead recebe duas vezes | S6, S7 | `criarEstadoDoTurno` com cerca de chamada única; cenário "mesmo corpo duas vezes" com um envio; invariante `turno-nao-responde-duas-vezes` |
| **Custo de LLM.** Uma fase mal movida pode chamar o roteador, a compactação ou o fechamento duas vezes, ou pular a escolta | S4, S5, S9 | contagem de chamadas por propósito no rastro; a escolta continua envolvendo o turno inteiro (cerca do call site único intacta) |
| **Guardrails.** Contadores de veto (`MAX_VETOS_*`), cadeia `runBeforeSend`, escalação por jailbreak e desligamento da ferramenta de handoff dependem do estado compartilhado | S6, S7, S9 | cenários de veto até o teto e de escalação no rastro; cercas negativas reapontadas com controle negativo |
| **Preview.** O mesmo corpo serve o preview em memória (96 ramos `preview`); um ramo perdido grava no banco de verdade | todas | cenário preview com zero SQL de escrita no rastro |
| **Cerca que mede o arquivo errado.** Cercas por texto continuam verdes lendo `inbound-turn.ts` depois que o código saiu | todas | inventário de S0; cada PR lista as cercas que reapontou |
| **Estreitamento de tipo.** `pacingCapVeto` já precisa de cópia em `const` por causa das closures (5581); em campo de objeto o TS estreita diferente | S3, S6 | `pnpm typecheck` frio; sem `!` novo sem comentário |
| **Conflito com outras sessões.** É o arquivo mais editado do motor | todas | fatia curta, rebase na `dev` no dia, PR mergeada antes da próxima começar |

---

## Alternativas recusadas

- **Não fatiar:** cada mudança no turno continua exigindo ler 3.750 linhas, e as cercas por texto crescem para compensar.
- **Reescrever como pipeline de middlewares genérico:** muda a ordem e o tratamento de erro de uma vez, sem prova possível.
- **Uma PR só:** revisão impossível e reversão tudo ou nada no caminho mais caro.
- **Flag com caminho velho e novo lado a lado:** dobra o código quente e os testes durante semanas; movimento verbatim com `git revert` dá a mesma volta sem o custo.
- **Fatiar por kind de turno (inbound, follow-up, caso):** os três compartilham quase todas as fases; duplicaria o turno.

## O que esta ADR não decide

- Mudança de comportamento, regra de guardrail ou prompt. Achado de bug durante o movimento vira PR à parte.
- O resto do arquivo (linhas 1 a 1943: `AGENT_TOOL_DEFS`, blocos de agenda, checkpoint, `deteccoesDeterministicasDoAssistido`) e os turnos irmãos (`followup-turn.ts`, `operator-turn.ts`).
- Nomes finais dos módulos; a pasta `turno/` é sugestão.

## Consequências

- O orquestrador lê em uma tela a ordem do turno, que hoje só se vê pelo mapa acima.
- Cada guardrail passa a ter um arquivo próprio para a sua cerca, em vez de `trecho()` sobre a função inteira.
- O custo é de dez PRs com revisão, e o teste de rastro vira mais um snapshot a manter: mudança legítima de comportamento atualiza o snapshot na PR que muda o comportamento, nunca numa de movimento.

## Aceite

Aceita pelo Peterson em 30/10/2026. O aceite liberou só a fatia S0; cada fatia seguinte começa depois da anterior mergeada na `dev`.
