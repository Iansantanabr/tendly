# Integration (done by Opus after each stage)

Per new template id:
1. `crates/server/src/hub/apps.rs`: add to `TEMPLATES` and `TEMPLATES_PT_BR`; `document` maps to the `knowledge` page for new scaffolds (alias) while `document.html` stays for reference; optional per-template manifest extras (`checklist` → `"permissions": ["notify"]`).
2. Server tests: the diagnostics loop covers every template in both languages; add a scaffold test per new id (app.json + index.html made, placeholders filled, no `{{` left).
3. `apps/web/src/features/hub/builder.ts`: `TemplateId`, `TEMPLATES` with `group` (`featured | organize | schedule | track | collect | decide | content`), label, hint, colour, collection; `CLUES` and `STRONG` words (pt + en) for each new id; `knowledge` replaces `document` in the list (old `document` id still accepted by `templateById`).
4. `CreateAppPanel.vue`: grouped grid (Base flexível + Em branco highlighted on top, then the six groups with headings), keyboard radiogroup across groups; i18n strings in `pt-BR.json`.
5. `builderPrompt`: mention the kit v2 pieces (`<t-record-form>`, `<t-detail>`, `tkit.settings`, `tkit.formula`, `tkit.csv`, `tkit.samples`) and the "Ajustes" convention, and the collection names of multi-collection templates.
6. `skills/tendly-apps/SKILL.md` (and the installed copy, with Ian's OK): template list, kit v2 API, the Ajustes/examples/CSV/detail conventions, and "keep settings in `settings`".
7. `kit-demo.html` up to date.
8. Build, restart, check every template in Chrome (desktop, laptop, 375 px; light and dark), fix, commit, push, report to Ian.
