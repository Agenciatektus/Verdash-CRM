# 02 — Paleta Verdash

> **Source of truth:** `app/globals.css` (`:root` = claro, `[data-theme="dark"]` = escuro). Este texto descreve; se divergir, **o CSS vence**.
> Referência visual: canvas "CRM Inbox v2" (https://claude.ai/artifact/5ietsYc7JmwqE8KjoETHJ4, board DS_V2Verdash).
> O nome do arquivo (`palette-sage`) é histórico: a Sage #506D48 foi a paleta até a etapa 2 do DS e hoje é só um preset. O padrão é o **Verde Verdash #0E7A5F** (claro) e o **azul #2690B1** (escuro).

## Filosofia

O CRM é ferramenta de trabalho para quem passa 8 horas na tela. A paleta é calma: neutros frios e suaves (azul-acinzentados, não greige), um accent único e estados dessaturados. Claro e escuro são **desenhados separadamente**, não invertidos.

O accent é a marca: uma organização pode substituí-lo em runtime (rampa derivada de uma semente, `lib/branding/rampa.ts`). Por isso cor de pessoa (agenda, avatar) **nunca** usa o accent.

## Claro — accent (Verde Verdash)

| Stop | Hex | Uso |
|------|-----|-----|
| 50 | `#eef7f4` | Hover muito sutil |
| 100 | `#daeee6` | `--color-accent-soft`: fundo de chip e item ativo |
| 200 | `#b4ddcd` | Bordas de elemento accent secundário |
| 300 | `#82c4ad` | Disabled do accent |
| 400 | `#4ead8f` | — |
| 500 | `#229676` | — |
| 600 | `#0e7a5f` | `--color-accent`: botão primary, link, foco |
| 700 | `#17614c` | `--color-accent-hover` |
| 800 | `#1a4f3f` | Texto sobre fundo accent claro |
| 900 | `#1a4235` | — |
| 950 | `#0a211a` | — |

`--color-accent-fg` = `#ffffff`.

## Claro — superfícies, texto, bordas e neutros

| Token | Hex | Uso |
|-------|-----|-----|
| `--color-bg` | `#eef1f5` | Fundo da página |
| `--color-surface` | `#ffffff` | Cards, painéis |
| `--color-surface-elevated` | `#f5f7f9` | Cabeçalho, dropdown, alt-bg |
| `--color-hover` | `#eaedf2` | Hover de linha/item |
| `--color-thread` | `#f2f5f8` | Fundo da conversa |
| `--color-text` | `#171d26` | Texto primário |
| `--color-text-muted` | `#474d58` | Texto secundário |
| `--color-text-subtle` | `#606671` | Timestamp, helper |
| `--color-border` | `#e0e3e8` | Borda padrão |
| `--color-border-strong` | `#cdd1d7` | Borda firme |
| `--color-overlay` | `rgba(17,22,31,0.32)` | Fundo de modal |

Rampa neutra claro (`--color-neutral-N`): 50 `#eef1f5` · 100 `#eaedf2` · 200 `#e0e3e8` · 300 `#cdd1d7` · 400 `#999fa7` · 500 `#606671` · 600 `#474d58` · 700 `#323842` · 800 `#232933` · 900 `#171d26` · 950 `#070b12`.

## Escuro

| Token | Hex |
|-------|-----|
| `--color-bg` | `#0d0e11` |
| `--color-surface` | `#181a1c` |
| `--color-surface-elevated` | `#1f2225` |
| `--color-hover` | `#212326` |
| `--color-thread` | `#111315` |
| `--color-text` / `muted` / `subtle` | `#f8f8f8` / `#c8cbce` / `#a1a5aa` |
| `--color-border` / `strong` | `#292c2f` / `#3a3d41` |

Accent no escuro (azul, semente `#2690B1`): 50 `#edf7fb` · 100 `#daf0f8` · 200 `#b6e1f2` · 300 `#87cde7` · 400 `#54b9dc` · 500 `#2da6cc` · 600 `#2690b1` (`--color-accent`) · 700 `#247089` · 800 `#21596c` · 900 `#1f4958` · 950 `#072028`. `--color-accent-fg` = `#000000`, `--color-accent-hover` = stop 500, `--color-accent-soft` = `rgba(38,144,177,0.2)`.

Neutros escuro (parcial; a rampa completa está no CSS): 50 `#f8f8f8` · 100 `#e3e5e7` · 200 `#c8cbce` · 300 `#a1a5aa` · 400 `#6e7276`.

## Estados

Cada estado tem três tokens: sólido (`--color-X`, fundo de botão com texto branco), fundo suave (`-bg`) e texto sobre o fundo suave (`-fg`).

| Estado | Sólido claro | bg claro | fg claro | Sólido escuro | bg escuro | fg escuro |
|--------|--------------|----------|----------|---------------|-----------|-----------|
| `success` | `#5a8a5f` | `#dff6e2` | `#287c42` | `#82a077` | `#0a3723` | `#41ce90` |
| `warning` | `#b07a2b` | `#ffeed2` | `#824c00` | `#d09455` | `#412805` | `#ffb848` |
| `error` | `#b02a2d` | `#ffe9e6` | `#b02a2d` | `#fa8785` | `#521c1d` | `#fa8785` |
| `info` | `#4a7a93` | `#e1f1ff` | `#0077bc` | `#7da9bf` | `#182e4b` | `#65a7fa` |

Badge de estado = `-bg` + `-fg`. Nota interna: `--color-note-bg` `#fff1cc` / `--color-note-fg` `#54360b` (escuro `#392c0c` / `#f3dba9`).

## Cor de pessoa (fora do accent)

- **Avatar:** 6 pares fundo/texto (`--color-avatar-1..6` e `-fg`), escolhidos por hash estável do id (`lib/inbox/cor-do-avatar.ts`).
- **Agenda:** 8 trilhas `--agenda-pessoa-1..8` (telha, âmbar, oliva, turquesa, azul, índigo, violeta, framboesa). Cor nunca é a única informação: leva junto a inicial da pessoa.

## Contraste

A régua de contraste (`lib/branding/contraste.ts`) lê os hex do `globals.css` e há testes que reprovam par abaixo do mínimo. Regras:

- Prosa e corpo: AAA (`text` sobre `bg`).
- Texto de UI 14px+: AA, 4,5:1.
- Não textual (borda, ícone): 3:1.
- Nunca dependa só de cor para estado: ícone Phosphor + cor + texto.

## Anti-padrões de cor

- Accent como fundo de área grande (sidebar inteira) ou em texto de leitura longa.
- `#000`/`#fff` soltos em texto: use `--color-text` e `--color-surface`.
- Cor fora do sistema (roxo, ciano) para tag de usuário. Categórica de gráfico: abrir RFC.
- Gradiente decorativo accent → accent.
- Hex literal em feature: leia o token.
