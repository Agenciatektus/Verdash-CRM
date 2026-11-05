# 04 — Densidade Aerada

> **Source of truth:** `app/globals.css` (`--density-*`, `--row-py`, `@custom-variant mb`). O CSS vence.

## Tokens

| Token | Valor | Onde aplica |
|-------|-------|-------------|
| `--density-row` | 56px | `min-height` de item de lista (inbox row, kanban list) |
| `--density-gap` | 24px | `gap` entre items em lista (`.ds-list`) |
| `--density-px` | 20px | Padding horizontal interno de row |
| `--density-py` | 16px | Padding vertical interno de row |

CSS vars são consumidas por componentes de lista, kanban e cards de inbox. Componentes de form (input, button) **não** dependem de densidade — têm altura fixa (36px).

## Por que Aerada (e não Equilibrada/Compacta)

DeskcommCRM tem como persona principal o **atendente que passa 8h/dia na ferramenta**. Decisões importantes:

1. **Fadiga visual cumulativa.** Densidade alta (Linear-like, 32px row) é eficiente em sessões curtas; em sessões longas, gera tensão e erros. Aerada respira.
2. **Não é banking ou planilha.** Em CRM de e-commerce, precisão extrema (ver 200 linhas em uma tela) importa menos que **conforto e velocidade na linha que você está lendo agora**.
3. **Hit-target generoso.** 56px de altura permite click confortável com mouse e dedo (em tablet), sem exigir precisão. Reduz miscliques.
4. **Whitespace como hierarquia.** Aerada dá ar pra hierarquia tipográfica (Atkinson Hyperlegible, weights 400/700) funcionar — não precisa truncar tudo em 1 linha.
5. **Diferenciação de mercado.** A maioria dos CRMs converge pra densidade equilibrada (~44px) ou compacta. Aerada projeta confiança operacional sem urgência.

Comparativo:

| Densidade | Row | Gap | Quando faria sentido |
|-----------|-----|-----|----------------------|
| Aerada | 56 | 24 | **DeskcommCRM (default)** — uso prolongado, atendimento, navegação tranquila |
| Equilibrada | 44 | 16 | Things-like; produtividade pessoal, sessões curtas |
| Compacta | 32 | 8 | Linear-like; uso intenso de teclado, navegação por engenharia |

## Quando overrider Aerada

Aerada é default **global**. Há contextos específicos onde densidade muda:

### 1. Tabela de dados densa

Tabelas de relatório (`/reports/sales`, exportações, listas de produtos com 50+ colunas) podem reduzir **vertical** mantendo Aerada na decisão de gap horizontal:

- Row: 44px (não 56)
- Gap entre cells: 0 (border-only)
- Padding-y: 10px (compacta vertical)
- Padding-x: 16px (mantém respiração horizontal)

Mesmo aqui, **nunca abaixo de 32px de row** — perde hit-target.

### 2. Kanban card

Aerada faz sentido pleno: cards de Pedido têm:
- Padding interno: 12px (não 16, porque o card é menor)
- Gap entre lines internas: 8px
- Min-height: livre (cresce com conteúdo)

Não comprime mais que isso — kanban serve pra leitura passiva, não pra screening de massa.

### 3. Sidebar de navegação

Sidebar tem densidade própria (não Aerada):
- Row: 36–40px
- Padding: 8px 10px
- Gap: 2px

Lógica: navegação é vista 100% do tempo; comprimir economiza altura útil pro canvas.

### 4. Forms e settings

Aerada nos campos:
- Input height: 36px (não 56 — input não precisa do mesmo conforto que linha de lista clicável)
- Espaçamento entre fields: `space-5` (20px)
- Espaçamento entre groups: `space-8` (32px)

## O que Aerada NÃO é

❌ **Não é Notion exato.** Notion tem padding muito maior em containers (32px+) e linhas aerated principalmente em prose. DeskcommCRM aplica Aerada em componentes operacionais (inbox, kanban) e usa space-5/6 em containers.

❌ **Não é "tudo grande".** Botões, inputs, badges mantêm altura proporcional (36, 22, etc.). Aerada é sobre **rows clicáveis em listas**, não sobre tudo.

❌ **Não é desperdício.** Whitespace está calibrado pra hierarquia. Adicionar mais não melhora.

## Breakpoints e layout (DS v2)

O corte do celular é **760px** (`@custom-variant mb`: `max-width: 759px`), não o `md` de 768 do Tailwind. Abaixo de 760 vale o app de celular (`mb:`, `components/mobile/`); de 760 para cima, tablet e desktop (`largo:`). `tests/unit/paridade-mobile.test.ts` confere o corte. Referência visual: canvas "CRM Inbox v2" (https://claude.ai/artifact/5ietsYc7JmwqE8KjoETHJ4).

| Faixa | Layout |
|-------|--------|
| ≥ 1280px | Três colunas: navegação, lista, conversa com a coluna do lead |
| 1024–1279px | A coluna do lead vira gaveta |
| 760–1023px | Só a 1ª coluna da navegação |
| < 760px | Uma coluna (app de celular) |

Navegação em 2 colunas: 72px (trilho) + 232px (painel). Topo: 56px.

No celular a densidade se ajusta: gap 12px, padding-x 16px, padding-y 14px; alvo de toque mínimo 44px (`--mb-alvo`). Medidas do celular em `--mb-*`.

## Como consumir

```css
.ds-list-item {
  min-height: var(--density-row);           /* 56px */
  padding: var(--density-py) var(--density-px);  /* 16px 20px */
}
.ds-list { gap: var(--density-gap); }         /* 24px */
```

```tsx
// Em Tailwind (mapeado)
<div className="min-h-row-aerada py-4 px-5">
<ul className="flex flex-col gap-6">
```

Para overrider em contexto específico (tabela densa):

```tsx
<table className="density-table">  {/* sobrescreve --density-row: 44px */}
```
