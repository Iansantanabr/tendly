# Comparador / Comparison (`compare`) — stage 2

Files `templates/compare.html` + `templates/pt-BR/compare.html`. Collection `options`. Settings key `settings`.

## Job

Decide between options with criteria: options side by side, each criterion with a weight, each option scored or measured, a weighted total and a clear winner, with the differences visible. Suppliers, proposals, products, plans, equipment.

## Data

Settings:
```js
{ v: 1, currency: 'BRL', title: '' /* the decision, e.g. "Fornecedor de limpeza 2027"; read the h1 when empty */,
  criteria: [ // { id, label, kind, weight (0–10), better: 'higher'|'lower', unit?, help? }
    { id: 'preco', label: 'Preço mensal', kind: 'money', weight: 8, better: 'lower' },
    { id: 'qualidade', label: 'Qualidade', kind: 'score', weight: 7, better: 'higher' },   // score = 1–5 stars
    { id: 'prazo', label: 'Prazo de início', kind: 'number', unit: 'dias', weight: 4, better: 'lower' },
    { id: 'suporte', label: 'Suporte 24h', kind: 'yesno', weight: 3, better: 'higher' } ],
  decided: null /* option id once chosen */ }
```
Option `{ name, link (url|null), note (longtext), values: { [criterionId]: number|boolean|null }, pros: [text], cons: [text], order, archived: bool }`.

**Scoring** (pure functions in a `// LOGIC START … // LOGIC END` block, unit-tested in `apps/web/src/features/hub/compare-logic.test.mjs` like the checklist): each criterion normalizes the options' values to 0–1 (min–max over non-archived options; `lower` inverts; a single option or all equal → 1; null → 0 and flagged "sem dado"; yesno → 1/0; score → (v−1)/4); weighted total = Σ(weight × normalized) / Σ(weight) × 100, rounded to 1 decimal. Ties keep order.

## Screens

- **Comparar** (`data-icon="scale"`): the matrix. Columns = options (sticky first column with criteria names + weight chips); rows = criteria, then "Pontuação" (bold, a bar per cell), then Prós/Contras (bullets). The best cell per criterion gets a subtle ok tone and a "melhor" mark; the winner column gets a header badge "Melhor pontuação" and, when `decided`, "Escolhida". Cells are editable in place (click → small input/stars/toggle; Enter saves; Esc cancels) — editing a cell updates that option with `rev`. Header per option: name (link icon if `link`), "…" menu (Editar, Arquivar, Apagar, Escolher esta). "Nova opção" primary, "Novo critério" secondary. Phones: the matrix scrolls horizontally inside its scroller with the criteria column sticky; plus a toggle "Ver por opção" that shows one card per option instead.
- **Ranking** (`data-icon="chart"`): options sorted by score with a horizontal bar each and the top 3 reasons ("Melhor em Preço mensal, Qualidade"); a `<t-chart type="bar">` of scores; "Escolher <winner>" button sets `decided`.
- Option detail (`<t-detail>`-like drawer; `#compare/<id>`): all values, note (markdown), pros/cons editing (simple add/remove lines).
- **Ajustes**: Decisão (title), **Critérios** (rows: label, kind select Dinheiro/Número/Nota 1–5/Sim ou não, unit, weight slider 0–10, Melhor quando Maior/Menor; reorder; delete keeps values in options), Moeda, Opções arquivadas (list with Restaurar), then shared blocks (CSV: one row per option, one column per criterion + score).

## Examples

"Fornecedor de limpeza": 3 options ("Limpa Bem Serviços", "Brilho Total", "Casa & Cia Facilities") with filled values making a non-obvious winner (cheapest isn't best), pros/cons 2 each.

## Context

summary "Comparador 'Fornecedor de limpeza': 3 opções, melhor: Brilho Total (82,4)"; selection on an option "Opção: Brilho Total".

## Acceptance

1. Scoring matches the rule (unit tests: lower/higher, nulls, single option, equal values, yes/no, score).
2. In-place cell editing works with keyboard only.
3. Changing a weight re-ranks instantly.
4. Archiving removes an option from scoring and matrix; restoring brings it back.
5. Phone: no page overflow; "Ver por opção" readable.
