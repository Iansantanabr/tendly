# Calculadora / Simulador (`calculator`) — stage 2

Files `templates/calculator.html` + `templates/pt-BR/calculator.html`. Collection `scenarios`. Settings key `settings`.

## Job

Inputs on the left, results on the right, updated as you type; the rules are formulas the person writes in Ajustes, like a spreadsheet but tidy. Save a set of inputs as a **scenario**, and compare scenarios side by side. Quotes, commissions, costs, feasibility, "what if".

## Data

Settings:
```js
{ v: 1, currency: 'BRL',
  inputs: [ // kit field schema subset: number | money | choice | checkbox | date; plus default and optional min/max/step and unit
    { id: 'quantidade', label: 'Quantidade', type: 'number', default: 10, min: 0, step: 1, unit: 'un.' },
    { id: 'preco', label: 'Preço unitário', type: 'money', default: 150 },
    { id: 'desconto', label: 'Desconto', type: 'number', default: 5, min: 0, max: 100, unit: '%' },
    { id: 'frete', label: 'Frete', type: 'money', default: 80 } ],
  outputs: [ // { id, label, formula, format: 'money'|'number'|'percent'|'text', highlight: bool, help? }
    { id: 'subtotal', label: 'Subtotal', formula: 'quantidade * preco', format: 'money' },
    { id: 'valor_desconto', label: 'Desconto', formula: 'subtotal * desconto / 100', format: 'money' },
    { id: 'total', label: 'Total', formula: 'subtotal - valor_desconto + frete', format: 'money', highlight: true },
    { id: 'por_unidade', label: 'Custo por unidade', formula: 'total / quantidade', format: 'money' } ] }
```
Outputs may reference inputs and earlier outputs (evaluate in order; a reference to a later output is a compile error "Use só resultados acima deste").
Scenario `{ name, values: { [inputId]: value }, note, pinned: bool, order }`.

## Screens

- **Calcular** (`data-icon="calculator"`): two columns (stacked on phones: inputs first, then a sticky compact bar with the highlighted output at the bottom of the screen). Inputs: one `.t-field` each, numbers with `inputmode="decimal"`, units as suffix, sliders for inputs that have both min and max (slider + number box in sync). Results: a `.t-card` list; highlighted outputs large; each output shows its value formatted, and on hover/focus its formula in muted mono text ("= subtotal − valor_desconto + frete"). Errors (null) show "—" with the reason in a tooltip. Buttons: "Salvar cenário" (asks a name), "Restaurar padrões".
  The scenario currently loaded shows as a chip "Cenário: Proposta A · alterado" with "Salvar alterações" / "Salvar como novo".
- **Cenários** (`data-icon="list"`): list of saved scenarios (name, the highlighted outputs, updated) with Abrir, Renomear, Duplicar, Apagar; checkboxes to pick 2–4 and "Comparar".
- **Comparar** (`data-icon="scale"`; `#compare/<id1>,<id2>,…`): a table with one column per scenario and one row per input and output; differences highlighted (cells that differ from the first scenario get a subtle tone; for each output whose `better` is set (`'lower'|'higher'`, default `null`, chosen in Ajustes), the best scenario's cell gets a "melhor" badge).
- **Ajustes**: **Entradas** (`<t-fields-editor>` limited to the input types, plus default/min/max/step/unit — implement these extra properties in the page's own small editor next to the kit one if the kit editor lacks them; mark `KIT-CANDIDATE`), **Resultados** (ordered list: label, formula input validated live with `tkit.formula.compile` against available ids, format select, "Destacar", "Melhor quando" Menor/Maior/—), **Moeda**, then shared blocks (CSV exports scenarios: one row per scenario with every input and output).

Recompute on every input event (no debounce needed; formulas are cheap). Never block typing: invalid partial numbers keep the last valid result and show the field as invalid.

## Examples

3 scenarios for the default model: "Pedido pequeno" (10 un.), "Pedido médio" (50 un., 8%), "Pedido grande" (200 un., 12%, frete 0).

## Context

summary "Calculadora: total R$ 1.505,00 (Cenário: Pedido médio)"; selection none.

## Acceptance

1. Changing an input updates all outputs instantly; formulas with errors never throw.
2. Ajustes: add an input and an output using it; the Calcular screen and Comparar include them; a bad formula shows the error under the input and is not saved until valid.
3. Save, modify, "Salvar alterações" vs "Salvar como novo" behave as named.
4. Compare 3 scenarios; differences and "melhor" badges right.
5. Phone: sticky result bar, no horizontal scroll except the compare table inside its own scroller.
