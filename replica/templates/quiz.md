# Quiz / Avaliação (`quiz`) — stage 3

Files `templates/quiz.html` + `templates/pt-BR/quiz.html`. Collections `questions` and `attempts`. Settings key `settings`.

## Job

Make a short quiz or self-assessment, take it, see the result and the history. Training checks, knowledge tests, diagnostics. Today only the owner uses GCore, so the person (or anyone at their screen) takes it; later, when apps can be published, others will take it through a link without changing this template — so keep "author" screens and "taker" screens clearly separate (the taker flow must work without the Ajustes/Perguntas screens).

## Data

Question `{ text, kind: 'single'|'multi'|'truefalse'|'scale'|'open', options: [{ id, label, correct: bool, feedback? }], points (default 1), explanation (markdown, shown after answering when settings.showAnswers), section (text, optional), order, active: bool }`. `scale` = 1–5 agreement (no right answer; used for diagnostics, contributes `value` to a section average); `open` = free text (no auto score; "Para revisão").
Attempt `{ who, startedAt, finishedAt|null, answers: [{ questionId, optionIds?, value?, text?, correct?: bool, points }], score, maxScore, percent, passed: bool|null, sectionScores: { [section]: number } }`.
Settings `{ v: 1, mode: 'test'|'diagnostic', intro (markdown), passPercent: 70, showAnswers: 'end'|'each'|'never', shuffle: false, oneAtATime: true, timeLimitMinutes: null, resultTexts: [{ min: 0, max: 49, text }, { min: 50, max: 79, text }, { min: 80, max: 100, text }] (diagnostic mode), person: '' }`.

Scoring (pure, LOGIC block, tested in `apps/web/src/features/hub/quiz-logic.test.mjs`): single/truefalse: points if the chosen option is correct; multi: points × max(0, (right chosen − wrong chosen) / total right), rounded to 2 decimals; scale: no points, feeds section averages; open: no points. percent = score/maxScore×100 (maxScore excludes scale/open).

## Screens (taker)

- **Início** (`data-icon="play"`): title, intro (markdown), facts ("12 perguntas · cerca de 6 min · aprovação com 70%"), a name input (prefilled with settings.person), "Começar". If an attempt is unfinished: "Continuar de onde parou".
- **Fazendo** (`#take/<attemptId>`, not in nav): `<t-steps>` / progress "Pergunta 3 de 12", the question, options as large radio/checkbox cards (44px+), keyboard 1–9 to choose, Enter for Próxima; "Anterior" allowed; timer when limited (auto-finish at 0, with a warning at 1 min). Each answer is saved on Próxima (attempt update with rev). With `showAnswers: 'each'`: after answering, show correct/incorrect and the explanation before Próxima.
- **Resultado** (`#result/<attemptId>`): percent big, passed/failed badge (test mode) or the matching result text (diagnostic), section scores as bars, then the review list (each question, your answer, right answer and explanation unless `showAnswers: 'never'`). "Refazer" and "Voltar ao início".

## Screens (author)

- **Perguntas** (`data-icon="help"`): list grouped by section with drag order, kind badge, points, active switch; "Nova pergunta" opens an editor: text, kind segment, options editor (label + "correta" toggle + optional feedback; truefalse fixed options Verdadeiro/Falso), points, section (datalist of existing), explanation (markdown textarea). Validation: single/truefalse need exactly one correct; multi at least one.
- **Resultados** (`data-icon="chart"`): `<t-table>` of attempts (who, date, percent, passed, duration); stat cards (attempts, average, pass rate, hardest question = lowest correct rate); per-question correct rate list. CSV export of attempts (one row per attempt with per-question correctness).
- **Ajustes**: Modo (Teste/Diagnóstico), Introdução, Aprovação (%), Mostrar respostas (No fim/A cada pergunta/Nunca), Embaralhar, Uma por vez, Tempo limite, Textos de resultado (diagnostic), Seu nome, then shared blocks (CSV import imports **questions**: columns text, kind, options separated by "|", correct options marked with "*", points, section, explanation).

## Examples

A 6-question test "Boas práticas de atendimento" (single, multi, truefalse, one open) with explanations, and 3 past attempts (75%, 50%, 100%).

## Context

summary "Quiz: 12 perguntas, 9 tentativas, média 72%"; during an attempt selection "Tentativa: pergunta 3 de 12".

## Acceptance

1. Scoring tests pass (each kind, partial multi, scale/open excluded from max).
2. An attempt survives a reload in the middle and continues.
3. Time limit auto-finishes.
4. Author screens are not needed to take the quiz (no data dependency on them).
5. Keyboard-only taking works; phone layout comfortable.
