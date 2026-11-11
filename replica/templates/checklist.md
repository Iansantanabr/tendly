# Checklist / Rotina (`checklist`) — stage 2

Files `templates/checklist.html` + `templates/pt-BR/checklist.html`. Collections `routines` and `runs`. Settings key `settings`. **Permission**: the app asks for `notify` (Opus adds `"permissions": ["notify"]` to the scaffolded app.json for this template).

## Job

Repeatable checklists: a routine is a list of steps; each time someone does it, that is a **run** with each step ticked, who did it, when, and notes. Store opening, inspections, onboarding a hire, quality checks. The home screen answers "what must be done today, and what is late?".

## Data

Routine `{ name, description, steps: [{ id, label, required: bool, help? }], frequency: { kind: 'daily'|'weekly'|'monthly'|'once'|'manual', weekdays?: [0-6] (weekly), day?: 1-31 (monthly), date?: 'YYYY-MM-DD' (once) }, dueTime: 'HH:MM'|null, owner: text, active: bool, order }`.
Run `{ routineId, routineName (copied), period: 'YYYY-MM-DD' (the day it counts for; for weekly the Monday/Sunday of that week per settings.weekStart; monthly the 1st), startedAt, finishedAt|null, by: text, items: [{ stepId, label (copied), done, at|null, note }], status: 'open'|'done'|'skipped', note }`.
Settings `{ v: 1, person: '' (your name, used as "by"), weekStart: 0|1, notifyLate: true, lastNotified: 'YYYY-MM-DD'|null }`.

A routine is **due** for the current period when its frequency matches and there is no `done`/`skipped` run for that routine+period. It is **late** when due and (dueTime passed today) or (the period is before today's period). Pure functions in the page (well commented, they are the heart of it): `periodFor(routine, date, weekStart)`, `isDue(routine, runs, now)`, `isLate(routine, runs, now)`, `nextDue(routine, now)`.

## Screens

- **Hoje** (Today, `data-icon="check-square"`): sections "Atrasadas" (danger tone), "Para hoje", "Em andamento" (open runs), "Feitas hoje" (collapsed by default). Each routine row: name, steps count, dueTime, owner, a `<t-progress>` if a run is open, and the action button: "Começar" / "Continuar" / "Ver". Empty: "Nada para hoje" + "Nova rotina" / "Ver com exemplos".
- **Run screen** (`#run/<runId>`, not in nav): routine name, period label ("Hoje, 11 de nov." / "Semana de 10 de nov."), `<t-checklist>` of the run's items (each tick saved immediately with `update(..., { rev })`; on conflict reload), a note per item (expands on "Adicionar nota"), overall note, then "Concluir" (disabled while a required step is unchecked; tooltip says which), "Pular esta vez" (asks a reason, status skipped), "Descartar" (deletes an open run). Finished runs show read-only with who/when.
- **Rotinas** (`data-icon="repeat"`): list of routines with frequency in words ("Toda segunda e quinta às 09:00", "Todo dia 1", "Sob demanda"), next due, active switch; "Nova rotina"; editing in a modal: name, description, owner, frequency (`.t-segment` Diária/Semanal/Mensal/Uma vez/Sob demanda + its sub-fields: weekday toggles, day of month, date), due time, and the steps editor (`<t-list-editor>` for labels + a "Obrigatória" switch per step; implement the switch as an extra column in the page if the kit list editor lacks it — mark `KIT-CANDIDATE`).
- **Histórico** (`data-icon="clock"`): `<t-table>` of runs (routine, period, status badge, by, finished, items done/total), pills by routine; open → run screen read-only.
- **Ajustes**: Seu nome (used in "by"), Semana começa, Avisos ("Avisar no sino quando houver rotina atrasada" switch), then shared blocks (CSV exports runs: one line per run with routine, period, status, by, done/total, note).

## Late notifications

On start-up and every 10 minutes while open: if `notifyLate` and some routine is late and `lastNotified !== today`, call `tendly.host.notify('Rotinas atrasadas', '<n> rotinas atrasadas: <names, max 3>')` once, then save `lastNotified = today`. If the permission was refused, show a muted line on Hoje: "Avisos no sino estão desligados para este app." with no nagging.

## Examples

3 routines: "Abertura da loja" (diária 08:30, 6 steps, 2 required), "Inspeção semanal de extintores" (semanal seg), "Fechamento do mês" (mensal dia 1, 5 steps); plus 6 past runs over the last 10 days (one skipped with reason), and one open run for today half done. All `_sample`.

## Context

summary "Hoje: 2 atrasadas, 3 para hoje, 1 em andamento"; selection on a run "Execução: Abertura da loja (hoje, 3 de 6)".

## Acceptance

1. Due/late logic correct for each frequency across week/month boundaries (write the pure functions so they can be unit-tested; add `apps/web/src/features/hub/checklist-logic.test.mjs` that extracts them by evaluating the page script's marked block `// LOGIC START … // LOGIC END` in `vm` — keep that block free of DOM and SDK calls).
2. Ticking steps persists immediately; two panes see the same run update live.
3. Required steps block "Concluir".
4. Notification fires at most once per day and only with permission.
5. Phone: run screen checkboxes are 44px and the Concluir bar sticks to the bottom.
