# Fork do Ian: notas de trabalho

Fonte da verdade para retomar o trabalho (inclusive depois de compactar a conversa).
Plano completo: `~/.claude/plans/users-iansantana-desktop-portuguese-aut-ticklish-knuth.md`.

## Como construir e rodar
- Branch `ian`, criada a partir de `v0.1.113`. `origin` = github.com/Iansantanabr/tendly (fork), `upstream` = wnzzer/tendly. Enviar com `git push`.
- `~/tendly-src/build.sh` faz `pnpm build:web` + `cargo build --release -p tendly-server`, troca o binário em `~/tendly-src/bin/tendly-server` com `mv` (sobrescrever no lugar faz o macOS matar o processo, exit 137) e reinicia o servidor.
- Node 24 via nvm (`nvm use 24`); Rust via rustup (`source ~/.cargo/env`).
- O servidor precisa do PATH completo (node e `claude` em `~/.nvm/versions/node/v22.23.3/bin`); iniciá-lo de um shell sem isso dá "Native chat could not initialize". Sempre iniciar pelo `build.sh` ou por um shell de login.
- Rodar o fork: `tendly stop`, depois `~/tendly-src/bin/tendly-server` (mesmo `~/.tendly`). Não rodar `tendly update`.
- O web embutido só vale se `~/.tendly/web` NÃO existir (o disco ganha do embutido).

## Decisões
- Todo código novo do servidor fica em `crates/server/src/hub.rs` + `hub/`. Banco próprio `hub.db` ao lado de `tendly.db`, com migrações numeradas em `hub/store.rs` (`MIGRATIONS`, nunca editar uma entrada já publicada).
- Ganchos no código upstream (manter mínimos):
  - `conversations/events.rs`: `hub::on_turn_finished` (fim de turno) e `hub::on_waiting` (primeira aprovação pendente).
  - `conversations.rs`: `ChatManager::choose_permission` virou `pub(crate)` (o Início escolhe o modo de permissão antes do primeiro start).
  - `main.rs`: `mod hub`, campo `hub` no `AppState` (`app.rs`), `.merge(hub::routes())`. Os testes (`api_tests.rs`, `accounts/tests.rs`) usam `HubStore::memory()`.
- Web novo em `apps/web/src/features/hub/`. Texto da interface em inglês no código, com tradução em `i18n/pt-BR.json`.
- Rotas: `/` = Início (`home`), `/mesa` = canvas (nome `canvas` mantido), `/notificacoes` = sino (`inbox`).
- Testes web upstream que esperam chinês fixam `zh-CN` no `before` (model-selection, profile-environment-dialog); os de i18n agora esperam pt-BR.
- Dev rápido da interface: `pnpm build:web`, copiar `apps/web/dist` para `~/.tendly/web` e `tendly-server restart` (o disco só é lido se existir no start). Ao fechar a fase, apagar `~/.tendly/web`.
- Chips de contexto: `features/hub/open-context.ts` (App.vue alimenta a partir das abas abertas; ChatSessionPane mostra "+ arquivo").
- Teste Rust `task_tests` (worktree) pode estourar 20 s com a suíte toda em paralelo; passa sozinho. Não é do fork.
- Traduções: arquivo único `i18n/pt-BR.json`, indentado com 1 espaço e sem quebra de linha no fim (manter esse formato ao editar por script).
- `cargo check` precisa de `apps/web/dist` existir (RustEmbed); num clone novo, rodar `pnpm build:web` antes.
- Duas janelas do Tendly abertas (ex.: Chrome + navegador do app) disputam o canvas compartilhado: a que salva depois vê "Conflito ao salvar". Comportamento do upstream, não do fork.
- Recon da Ratoeira em `replica/` (`recon.md`, `features.csv`; prints em `replica/screens/`, fora do git).
- Design (`replica/design/`): `tokens.json`/`tokens.dark.json` gerados do `styles.css` por `gen_tokens.py`; `python3 replica/design/contrast.py replica/design/tokens.json` (e o dark) deve dar 0 falhas AA. Ajustes do fork no `styles.css`: `--muted` e `--faint` mais escuros (claro) / mais claros (escuro), `--line-input` novo para borda de campo, cores dos tiles de app. Página `/design` mostra os primitivos (fora do menu). Specs em `components.md`.
- Confirmações na tela, não `window.confirm` (no navegador do app o diálogo nativo não aparece).
- Ícones novos em `features/Icon.vue`: home, bell, chat, arrowUp, plug, sparkles, timer, apps.

## API nova (`/api/hub/...`)
- `GET conversations` → workspace oculto de conversas sem projeto (`<state>/conversations`, criado também no start via `hub::warm`)
- `GET inbox`, `POST inbox/read {ids|all}`, `GET activity`, `POST activity/seen-all`, `POST sessions/{id}/seen`
- `GET recent-files?limit=`, `POST start {workspace_id, provider, prompt}` (usa `agent_sessions::start_in`)
- Automações (`hub/automations.rs`, migração 2): `GET|POST automations`, `PATCH|DELETE automations/{id}`, `POST automations/{id}/run`, `GET automations/{id}/runs?limit=`. Agendador tokio a cada 30 s (croner); lacuna > 5 min (Mac dormindo) não é recuperada. Script: `$SHELL -l -c`, timeout 10 min, últimos 64 KB. Agente: `start_in`. Ferramentas MCP `tendly_automation_list|create|update` em `agent.rs` (criar/alterar script pede confirmação na janela).
- Histórico (`hub/history.rs`, migração 3): `GET history?workspace_id=&path=`, `GET history/versions/{id}`, `POST history/versions/{id}/restore`. Observador `notify` próprio por workspace (não depende do `file_watch.rs`, que só roda com navegador aberto), reavalia a lista a cada 60 s, espera 1,5 s de silêncio. Só texto ≤ 1 MB; ignora pastas com ponto, build/dependências e o `.gitignore` (via `git check-ignore`). Conteúdo em `~/.tendly/history/blobs/<sha256>`. Autoria: salvar pela interface = você (gancho em `file_routes.rs::write_file`); sessão do workspace rodando = agente; senão "fora do Tendly". 100 versões / 60 dias por arquivo. A primeira versão é a que o observador vê depois da primeira mudança.
- Publicação (`hub/publish.rs` + `hub/publish/`, migração 4): `GET|POST publications`, `GET publications/for?workspace_id=&path=`, `PATCH|DELETE publications/{slug}`, `POST publications/{slug}/refresh`. Página pública `/p/{slug}/` (fora de `/api`, então o guard não pede token). Time = mesma autenticação da API (`Security::authenticated` virou `pub(crate)`); senha = argon2 + cookie HMAC por slug, 7 dias, 10 tentativas/min; congelado = cópia em `~/.tendly/published/<slug>/` com só os arquivos que a página referencia. CSP com sandbox para a página não chamar a API.
- Apps (`hub/apps.rs` + `hub/apps/`): convenção `<workspace>/apps/<slug>/app.json` (`name`, `letter?`, `color?` = amber|green|blue|violet|rose|slate|teal|orange, `description?`, `entry?`) + arquivos estáticos; dados em `apps/<slug>/data/<chave>.json`. `GET apps`, `GET apps/{ws}/{slug}/files/{*path}`, `GET|PUT|DELETE apps/{ws}/{slug}/data[/{chave}]` (≤ 1 MB), `GET apps/sdk.js` (`window.tendly.data.get/set/list/remove`), `POST apps/{ws}/scaffold` (201). Apps rodam na mesma origem, sem sandbox, para usar a API de dados (código do próprio agente). Painel novo `app` (protocolo, `LEAF_KINDS`, validadores em `layout_routes.rs` e `canvas.rs`), `AppPane.vue` (Chat abre conversa ao lado via `Canvas.openBeside`), página `/apps`, tiles na barra lateral e no Início, chip de contexto `apps/<slug>/`. Skill em `skills/tendly-apps/SKILL.md`, instalada em `~/.claude/skills/tendly-apps/` (copiar de novo se mudar).
- M1 (acabamentos): `features/hub/start.ts` (`startConversation`, `openConversation`, `defaultEndpoint`; App.vue registra o handler e mantém `startProfiles`) é o jeito único de abrir conversa de qualquer tela. `POST start` aceita `model`, `effort` (low…max | auto) e `permission` (modos do cliente). `GET automations/recent-sessions` alimenta "Rotinas recentes". Skills têm `id` e `GET catalog/skills/{id}/content`. Markdown publicado renderizado com `pulldown-cmark` (HTML cru escapado, links perigosos viram `#`). Configurações → Publicados em `/settings/published`.
- Catálogos (`hub/catalog/`): `GET catalog/integrations?refresh=1` (`claude mcp list` 20 s + cache 10 min, `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`; segredos removidos), `GET catalog/skills` (`~/.claude/skills`, plugins, `.claude/skills` dos workspaces, `~/.codex/skills`).

## Status
- [x] Fase 0: Rust, branch `ian`, build.sh, primeiro build ok
- [x] Fase 1: Início, sino, não lidas, barra Conversas, chips de contexto no chat (testado no navegador; 790 testes web ok)
- [x] Pendência da Fase 1 (pedido do Ian): a aba Conversas mostra só conversas SEM projeto e tem "Nova conversa". Implementação: workspace oculto em `~/.tendly/conversations` criado pelo servidor (`GET /api/hub/conversations`), filtrado da lista de Workspaces; Início com opção "Sem projeto".
- Regra do Ian: depois de compilar, sempre reiniciar o servidor (`~/tendly-src/bin/tendly-server restart`) e conferir no navegador.
- [x] Fase 2: automações (`/automacoes`), integrações (`/integracoes`), habilidades (`/habilidades`). Testado no navegador: rotina `* * * * *` rodou sozinha e apareceu no histórico; 50 integrações e 166 habilidades listadas. 794 testes web e 24 testes hub ok.
- [x] Fase 3: histórico (botão relógio no arquivo) e publicação (botão globo). Testado: salvar = Você, edição por fora = Fora do Tendly, restaurar; publicar com senha (401 sem, 303 com a certa, traversal 404), despublicar com confirmação na tela. 803 testes web e 49 hub ok.
- [x] M1: Continuar, composer completo no Início, Responder/Marcar todas/Rotinas recentes, Gerar senha, Pedir pro agente, Markdown publicado, Publicados nas Configurações, Ver/Usar no chat/filtro nas Habilidades, link da conversa no histórico, Autorizar no claude.ai. 829 testes web e 69 hub ok.
- [x] Fase 4: apps personalizados. Testado: app em branco aparece em Apps e na barra lateral, abre como aba da Mesa, contador e nota sobrevivem ao recarregar (arquivos em `data/`), Chat abre conversa ao lado com o chip do app. 813 testes web e 61 hub ok.
