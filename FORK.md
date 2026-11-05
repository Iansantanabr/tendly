# Fork do Ian: notas de trabalho

Fonte da verdade para retomar o trabalho (inclusive depois de compactar a conversa).
Plano completo: `~/.claude/plans/users-iansantana-desktop-portuguese-aut-ticklish-knuth.md`.

## Como construir e rodar
- Branch `ian`, criada a partir de `v0.1.113` (origin = wnzzer/tendly; ainda não há fork no GitHub do Ian).
- `~/tendly-src/build.sh` faz `pnpm build:web` + `cargo build --release -p tendly-server` e copia para `~/tendly-src/bin/tendly-server`.
- Node 24 via nvm (`nvm use 24`); Rust via rustup (`source ~/.cargo/env`).
- Rodar o fork: `tendly stop`, depois `~/tendly-src/bin/tendly-server` (mesmo `~/.tendly`). Não rodar `tendly update`.
- O web embutido só vale se `~/.tendly/web` NÃO existir (o disco ganha do embutido).

## Decisões
- Todo código novo do servidor fica em `crates/server/src/hub.rs` + `hub/`. Banco próprio `hub.db` ao lado de `tendly.db`, com migrações numeradas em `hub/store.rs` (`MIGRATIONS`, nunca editar uma entrada já publicada).
- Ganchos no código upstream (manter mínimos):
  - `conversations/events.rs`: `hub::on_turn_finished` (fim de turno) e `hub::on_waiting` (primeira aprovação pendente).
  - `main.rs`: `mod hub`, campo `hub` no `AppState` (`app.rs`), `.merge(hub::routes())`. Os testes (`api_tests.rs`, `accounts/tests.rs`) usam `HubStore::memory()`.
- Web novo em `apps/web/src/features/hub/`. Texto da interface em inglês no código, com tradução em `i18n/pt-BR.json`.
- Rotas: `/` = Início (`home`), `/mesa` = canvas (nome `canvas` mantido), `/notificacoes` = sino (`inbox`).
- Testes web upstream que esperam chinês fixam `zh-CN` no `before` (model-selection, profile-environment-dialog); os de i18n agora esperam pt-BR.
- Dev rápido da interface: `pnpm build:web`, copiar `apps/web/dist` para `~/.tendly/web` e `tendly-server restart` (o disco só é lido se existir no start). Ao fechar a fase, apagar `~/.tendly/web`.
- Chips de contexto: `features/hub/open-context.ts` (App.vue alimenta a partir das abas abertas; ChatSessionPane mostra "+ arquivo").
- Teste Rust `task_tests` (worktree) pode estourar 20 s com a suíte toda em paralelo; passa sozinho. Não é do fork.
- Ícones novos em `features/Icon.vue`: home, bell, chat, arrowUp, plug, sparkles, timer, apps.

## API nova (`/api/hub/...`)
- `GET inbox`, `POST inbox/read {ids|all}`, `GET activity`, `POST activity/seen-all`, `POST sessions/{id}/seen`
- `GET recent-files?limit=`, `POST start {workspace_id, provider, prompt}` (usa `agent_sessions::start_in`)

## Status
- [x] Fase 0: Rust, branch `ian`, build.sh, primeiro build ok
- [x] Fase 1: Início, sino, não lidas, barra Conversas, chips de contexto no chat (testado no navegador; 790 testes web ok)
- [ ] Fase 2: automações, integrações, habilidades
- [ ] Fase 3: histórico e publicação de arquivos
- [ ] Fase 4: apps personalizados
