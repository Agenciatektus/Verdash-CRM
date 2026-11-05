# 01 — Foundation Tokens

> **Source of truth:** `app/globals.css` (`:root`). O CSS vence; este texto descreve.

Todos os tokens primitivos do DeskcommCRM. Componentes compõem **só** a partir desta camada — nunca digite valores literais (`16px`, `#000`, `300ms`) em CSS de feature.

## Spacing

Base 4px. Escala não-linear (4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 80). Sem 56 nem 72 — se precisar, repense o layout.

| Token | px | Uso típico |
|-------|----|------------|
| `space-0` | 0 | Reset |
| `space-1` | 4 | Gap interno em badge/pill, ícone+label muito próximos |
| `space-2` | 8 | Gap entre tags, gap interno em controle compacto |
| `space-3` | 12 | Gap entre itens em lista densa, padding de ícone-button |
| `space-4` | 16 | Padding interno default de cards pequenos, gap em densidade equilibrada |
| `space-5` | 20 | Padding-x default de cards (Aerada) |
| `space-6` | 24 | Gap entre rows em Aerada, padding interno de containers |
| `space-8` | 32 | Margin entre seções dentro de uma view |
| `space-10` | 40 | Padding interno de modals e sheets |
| `space-12` | 48 | Margin entre blocos maiores em página de settings |
| `space-16` | 64 | Margin top/bottom de hero sections |
| `space-20` | 80 | Padding bottom da última seção de scroll (`.ds-scroll`) |
| `space-24` / `space-32` | 96 / 128 | Respiro de página inteira (raro) |

**Tailwind:** mapeia direto pro `theme.spacing` (`p-4`, `gap-6`, `mb-12`).

## Radius

Escala base (`--radius-*`) mais raios de forma (o raio cresce com o objeto). Não invente valores intermediários.

| Token | Valor | Use quando |
|-------|-------|------------|
| `radius-none` | 0 | Tabelas de dados, cabeçalhos de coluna |
| `radius-sm` | 4px | Badge pequeno, item de dropdown |
| `radius-md` | 8px | **Default** (`--radius`): cards de lista, kanban card |
| `radius-lg` | 12px | Painéis, side-card, modal menor |
| `radius-xl` | 16px | Modal full-size, popover grande, sheet |
| `radius-full` | 9999 | Avatar, dot, icon-button circular |
| `radius-pill` | 6px | Pílula/tag |
| `radius-control` | 9px | Botão |
| `radius-field` | 10px | Input, select, textarea |
| `radius-menu` | 14px | Menu, popover |
| `radius-bubble` | 18px | Balão de mensagem (canto de quem enviou: `radius-bubble-tail`, 6px) |

Regra: **suba de raio só quando o componente for hierarquicamente "mais alto"**. Card (8) > Modal (16); o controle dentro de um card não ganha raio maior que o do card.

## Border

Hairline foi removido na densidade Aerada (deixa o layout sem definição). Mantemos:

| Token | Valor | Uso |
|-------|-------|-----|
| `border-thin` | `1px solid var(--color-border)` | **Default** universal — cards, inputs, dividers, separadores |
| `border-focus` | `2px solid var(--color-accent)` | Focus ring (a11y). **Sempre 2px**, com `outline-offset: 2px` |

Borda 4px ou maior é proibida fora de elementos decorativos isolados (não usados no produto).

## Shadow

Sombras em `rgba(16, 24, 40, X)` (azul-acinzentado), não preto puro. No escuro são pretas e mais fortes, com uma linha de 2 a 4px embaixo.

| Token | Valor (claro) | Uso |
|-------|---------------|-----|
| `shadow-xs` | `0 1px 2px 0 rgba(16,24,40,0.05)` | Controle em repouso |
| `shadow-sm` | `0 1px 2px 0 rgba(16,24,40,0.06), 0 1px 1px 0 rgba(16,24,40,0.04)` | Hover discreto em card interativo |
| `shadow-md` | `0 4px 12px -2px rgba(16,24,40,0.08), 0 2px 4px -1px rgba(16,24,40,0.05)` | Popover, dropdown, toast |
| `shadow-lg` | `0 12px 32px -8px rgba(16,24,40,0.22), 0 2px 6px 0 rgba(16,24,40,0.08)` | Modal, sheet |
| `shadow-xl` | `0 24px 48px -12px rgba(16,24,40,0.24), 0 8px 16px -4px rgba(16,24,40,0.10)` | Overlay de maior elevação |
| `shadow-pop` | `0 12px 32px -8px rgba(17,22,31,0.22), 0 2px 6px 0 rgba(17,22,31,0.08)` | Menus e popovers do DS v2 |
| `shadow-bubble` | `0 1px 1px 0 rgba(17,22,31,0.06)` | Balão (escuro: nenhuma) |

Padrão: sem sombra, use whitespace + borda. **Anti-pattern:** `0 4px 24px rgba(0,0,0,0.2)`.

## Z-index

6 stops nomeados. Nunca use literais (`z-[9999]`).

| Token | Valor | Uso |
|-------|-------|-----|
| `z-base` | 0 | Conteúdo |
| `z-raised` | 10 | Sticky headers, badges flutuantes sobre lista |
| `z-dropdown` | 20 | Select, popover, menu contextual |
| `z-sticky` | 30 | Cabeçalho fixo |
| `z-modal` | 40 | Dialog, sheet, drawer |
| `z-toast` | 50 | Sonner, system messages globais |

## Motion

Todas as transições usam uma das 4 curvas canônicas + uma das 4 durations. Combinações fora desta tabela não são aceitas em PR.

| Token | Duration | Easing | Uso |
|-------|----------|--------|-----|
| `motion-fast` | 120ms | `cubic-bezier(0.2, 0, 0, 1)` | Hover, press, micro-feedback (cor/border) |
| `motion-base` | 200ms | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Default UI (modal fade, color shift) |
| `motion-slow` | 320ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Modal enter, sheet, page-level transition |
| `motion-spring` | 420ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful (badge pop, drag confirm) — uso parcimonioso |

Detalhes em `07-motion-language.md`.

## Como tokens são consumidos

Dois caminhos, dependendo do contexto:

### 1. CSS variables (preferido para showcase e estilos globais)

Definidas em `:root` e `[data-theme="dark"]` de `app/globals.css`. Lidas em CSS comum:

```css
.my-card {
  padding: var(--space-5);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
  transition: background var(--duration-fast);
}
```

### 2. Tailwind classes (preferido em componentes React)

Mapeadas no bloco `@theme inline` de `app/globals.css` para consumir as mesmas
CSS vars. (Era `tailwind.config.ts` até o Tailwind 4; o arquivo não existe
mais — a ponte token → utilitário vive no próprio CSS, logo abaixo dos blocos
`:root` / `[data-theme]`.)

```tsx
<div className="p-5 rounded-md border border-border shadow-sm transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]">
```

**Regra:** se você precisa de valor que não existe na escala, primeiro pergunte se a escala é o problema. Adicionar token novo é OK quando justificado em PR; usar valor literal nunca é.
