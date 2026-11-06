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

## Piloto automático
- `~/tendly-src/autopilot/` (fora do repo): `start.sh`, `stop.sh`, `run.sh`, `rules.md` (regras de toda rodada), `prompts/M3.md`, `M4.md`, `M5.md`. Roda `claude -p` sem conectores MCP, um marco por vez; espera o limite de uso e retoma a mesma sessão (`--resume`); para se 4 rodadas seguidas não gerarem commit.
- Progresso de cada marco em `replica/progress/<M>.md`; o marco termina quando o agente cria `replica/progress/<M>.done`. Situação atual: `cat ~/tendly-src/autopilot/state/status.txt`; log: `tail -f ~/tendly-src/autopilot/logs/autopilot.log`.

## Decisões
- Todo código novo do servidor fica em `crates/server/src/hub.rs` + `hub/`. Banco próprio `hub.db` ao lado de `tendly.db`, com migrações numeradas em `hub/store.rs` (`MIGRATIONS`, nunca editar uma entrada já publicada).
- Ganchos no código upstream (manter mínimos):
  - `conversations/events.rs`: `hub::on_turn_finished` (fim de turno) e `hub::on_waiting` (primeira aprovação pendente).
  - `conversations.rs`: `ChatManager::choose_permission` virou `pub(crate)` (o Início escolhe o modo de permissão antes do primeiro start).
  - `main.rs`: `mod hub`, campo `hub` no `AppState` (`app.rs`), `.merge(hub::routes())`. Os testes (`api_tests.rs`, `accounts/tests.rs`) usam `HubStore::memory()`.
  - M4 (VPS): `security.rs`, no `guard`: um `Host` ou `Origin` desconhecido é aceito se `hub::serves_public_pages` disser que é o endereço público dos publicados **e** o caminho for `/p/...` (4 linhas; `let path` subiu para o começo da função). `router.ts` + `SettingsPage.vue`: seção `addresses`.
  - M5: `features/ChatSessionPane.vue` (2 imports; `<PinnedMessageBar>` antes da linha do tempo e `<PinMessageButton>` dentro de `.chat-message-actions`, uma linha cada); uma regra CSS no fim do `<style>` que dá 30px embaixo das suas mensagens com mouse, para os botões copiar e fixar não ficarem cortados pela linha (`contain: paint` do VirtualRows), `features/WorkspaceSidebar.vue` (1 import e `<ReportProblem>` como último filho da barra), `features/Icon.vue` (traço `pin`).
  - M3 (celular): `apps/web/index.html` (link do manifest, `apple-touch-icon` em PNG, metas de app instalado), `main.ts` (`installPhoneSupport(router)` depois do mount), `App.vue` (o ciclo de 5 s passa `presentSession(...)` para `refreshInbox`), `router.ts` + `SettingsPage.vue` (seção `notifications`; as seções do hub ficam em `HUB_SECTIONS`), `crates/server/Cargo.toml` (`p256`, `hkdf`, `aes-gcm`, `base64`, `rand_core`).
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
- Ícones novos em `features/Icon.vue`: home, bell, chat, arrowUp, plug, sparkles, timer, apps, pin.

## API nova (`/api/hub/...`)
- `GET conversations` → workspace oculto de conversas sem projeto (`<state>/conversations`, criado também no start via `hub::warm`)
- `GET inbox`, `POST inbox/read {ids|all}`, `GET activity`, `POST activity/seen-all`, `POST sessions/{id}/seen`
- `GET recent-files?limit=`, `POST start {workspace_id, provider, prompt}` (usa `agent_sessions::start_in`)
- Automações (`hub/automations.rs`, migração 2): `GET|POST automations`, `PATCH|DELETE automations/{id}`, `POST automations/{id}/run`, `GET automations/{id}/runs?limit=`. Agendador tokio a cada 30 s (croner); lacuna > 5 min (Mac dormindo) não é recuperada. Automação sem `timezone` próprio usa o fuso das configurações do hub (M4), nunca o do relógio da máquina; a API devolve `effective_timezone`. Script: `$SHELL -l -c`, timeout 10 min, últimos 64 KB. Agente: `start_in`. Ferramentas MCP `tendly_automation_list|create|update` em `agent.rs` (criar/alterar script pede confirmação na janela).
- Histórico (`hub/history.rs`, migração 3): `GET history?workspace_id=&path=`, `GET history/versions/{id}`, `POST history/versions/{id}/restore`. Observador `notify` próprio por workspace (não depende do `file_watch.rs`, que só roda com navegador aberto), reavalia a lista a cada 60 s, espera 1,5 s de silêncio. Só texto ≤ 1 MB; ignora pastas com ponto, build/dependências e o `.gitignore` (via `git check-ignore`). Conteúdo em `~/.tendly/history/blobs/<sha256>`. Autoria: salvar pela interface = você (gancho em `file_routes.rs::write_file`); sessão do workspace rodando = agente; senão "fora do Tendly". 100 versões / 60 dias por arquivo. A primeira versão é a que o observador vê depois da primeira mudança.
- Publicação (`hub/publish.rs` + `hub/publish/`, migração 4): `GET|POST publications`, `GET publications/for?workspace_id=&path=`, `PATCH|DELETE publications/{slug}`, `POST publications/{slug}/refresh`. Página pública `/p/{slug}/` (fora de `/api`, então o guard não pede token). Time = mesma autenticação da API (`Security::authenticated` virou `pub(crate)`); senha = argon2 + cookie HMAC por slug, 7 dias, 10 tentativas/min; congelado = cópia em `~/.tendly/published/<slug>/` com só os arquivos que a página referencia. CSP com sandbox para a página não chamar a API. Com `public_base_url` definido (M4), cada publicação traz `public_url` (link absoluto); "só a equipe" fica `null` e continua no endereço do app.
- Apps (`hub/apps.rs` + `hub/apps/`): convenção `<workspace>/apps/<slug>/app.json` (`name`, `letter?`, `color?` = amber|green|blue|violet|rose|slate|teal|orange, `description?`, `entry?`) + arquivos estáticos; dados em `apps/<slug>/data/<chave>.json`. `GET apps`, `GET apps/{ws}/{slug}/files/{*path}`, `GET|PUT|DELETE apps/{ws}/{slug}/data[/{chave}]` (≤ 1 MB), `GET apps/sdk.js` (`window.tendly.data.get/set/list/remove`), `POST apps/{ws}/scaffold` (201). Apps rodam na mesma origem, sem sandbox, para usar a API de dados (código do próprio agente). Painel novo `app` (protocolo, `LEAF_KINDS`, validadores em `layout_routes.rs` e `canvas.rs`), `AppPane.vue` (Chat abre conversa ao lado via `Canvas.openBeside`), página `/apps`, tiles na barra lateral e no Início, chip de contexto `apps/<slug>/`. Skill em `skills/tendly-apps/SKILL.md`, instalada em `~/.claude/skills/tendly-apps/` (copiar de novo se mudar).
- M1 (acabamentos): `features/hub/start.ts` (`startConversation`, `openConversation`, `defaultEndpoint`; App.vue registra o handler e mantém `startProfiles`) é o jeito único de abrir conversa de qualquer tela. `POST start` aceita `model`, `effort` (low…max | auto) e `permission` (modos do cliente). `GET automations/recent-sessions` alimenta "Rotinas recentes". Skills têm `id` e `GET catalog/skills/{id}/content`. Markdown publicado renderizado com `pulldown-cmark` (HTML cru escapado, links perigosos viram `#`). Configurações → Publicados em `/settings/published`.
- M2: espaços da Mesa (`hub/spaces.rs`, migração 5): `GET|POST spaces`, `GET|PATCH|DELETE spaces/{id}`, `POST spaces/{id}/open {expected_revision}` (salva no canvas compartilhado com revisão; 409 se outra janela mudou). Controle "Espaço: …" na barra de status da Mesa (`SpaceMenu.vue`), `/mesa?espaco=<id>`, espaço ativo em `tendly.hub.space`. `canvas.rs` ganhou `pub(crate) fn validate` e `canvas-persistence.ts` ganhou `adoptSavedLayout`. Transcrição: `GET sessions/{id}/transcript?max_chars=` e ferramenta `tendly_read_conversation` (em `agent.rs`). Colar link de conversa no composer vira chip; ditado pela Web Speech API (`features/hub/dictation.ts`), aviso de privacidade uma vez.
- M3, celular. PWA (`hub/pwa.rs`): `GET /manifest.webmanifest` e `GET /sw.js` são rotas do servidor (iguais com o web embutido ou com `~/.tendly/web`; o `sw.js` recebe o id do build = hash do `index.html`, então cada build tem o próprio cache). O worker (`hub/pwa/sw.js`) guarda só o shell (`/assets/*`, ícones), nunca `/api/` nem `/p/`; sem servidor mostra "Sem conexão"; trata `push`, `notificationclick` (foca a janela e manda `tendly:navigate` para o vue-router, senão abre) e `pushsubscriptionchange`. Ícones em `apps/web/public/icons/`, gerados do `favicon.svg` por `python3 replica/design/gen_icons.py`. Registro do worker em `features/hub/pwa.ts`, só em contexto seguro e fora do `vite dev`.
- M3, Web Push (`hub/push.rs` + `hub/push/crypto.rs`, migração 6): `GET push/key`, `GET|POST push/subscriptions`, `DELETE push/subscriptions/{id}`, `POST push/test` → `{sent, failed, removed, waiting}`. RFC 8291 (aes128gcm) e RFC 8292 (VAPID, ES256) implementados sobre `p256` + `hkdf` + `aes-gcm` (sem OpenSSL), conferidos com o exemplo do RFC 8291. TTL 1 dia, `Urgency: normal`, `Topic` por conversa. 404/410 apaga a inscrição; outra recusa soma `failures` e apaga na 5ª seguida; 429 (ou 5xx com `Retry-After`) pausa aquele serviço de push (até 1 h) sem contar falha; serviço inalcançável (Mac sem internet) também não conta. A chave privada VAPID e o `auth` de cada aparelho ficam selados (AES-256-GCM) com a chave de `~/.tendly/push-seal.key` (0600): o `hub.db` sozinho não revela nada; sem esse arquivo o par é refeito e os aparelhos se inscrevem de novo. Endpoint só `https://` (ou `http://` em loopback, para teste). `sub` do VAPID = `TENDLY_PUSH_SUBJECT` (mailto: ou https:), padrão `mailto:tendly-push@example.com`; na VPS a receita preenche a variável em `/etc/tendly/tendly.env` (não virou chave de `hub_settings`).
- M3, quem recebe push: `home::notify()` (fim de turno, erro, esperando você, rotina) chama `push::dispatch` numa tarefa própria. Não manda para a conversa que um navegador diz estar na frente da pessoa: `GET inbox?focused=<id>` a cada 5 s, só com página visível, janela com foco e teclado/mouse/toque nos últimos 3 min (`features/hub/presence.ts`); vale por 15 s. Mac aberto na conversa sem ninguém mexendo → o celular toca.
- M3, interface: Configurações → Notificações (`/settings/notifications`, `NotificationsPanel.vue`): interruptor "Receber notificações neste aparelho", aparelhos com Remover, "Enviar teste", e o motivo quando não dá (sem HTTPS → Tailscale; iPhone → Adicionar à Tela de Início; navegador sem push; permissão negada). `InstallHint.vue` no Início (dispensável) e nessa página. O texto da notificação é traduzido no worker pelo `kind` (pt-BR/inglês; a página avisa o idioma por `postMessage`).
- M4, configurações do hub (`hub/settings.rs`, migração 7 `hub_settings`): `GET settings` → `{timezone, public_base_url, dictation}`; `PUT settings {chave: valor}` com qualquer subconjunto (um valor inválido recusa tudo, 400); `GET settings/timezones` → `{zones, server}`. `timezone` = nome IANA (chrono-tz); `public_base_url` = vazio ou `https://domínio[:porta]` sem caminho; `dictation` = `browser` | `off`. O fuso é gravado uma vez, no primeiro start, a partir do fuso da máquina (`TZ`, link `/etc/localtime`, `/etc/timezone`); se for UTC/`Etc/*` ou ilegível vira `America/Sao_Paulo`. Interface em Configurações → Endereços e fuso horário (`/settings/addresses`, `AddressesPanel.vue`, `features/hub/settings.ts`). O botão de ditado some com `dictation = off`.
- M4, endereço público dos publicados: o servidor responde pelo host de `public_base_url` só em `/p/...` (qualquer outro caminho com esse `Host` dá 403, e esse `Origin` nunca é aceito pela API). O cookie de senha sai `Secure` quando o proxy manda `X-Forwarded-Proto: https`.
- M5, histórico: migração 8 (`file_versions.message`). Versão escrita por agente guarda uma linha do que ele disse no turno em andamento (primeira frase, até 80 caracteres, sem chamar modelo; lida dos últimos 400 eventos da conversa). `GET history` e `GET history/versions/{id}` devolvem `message`.
- M5, integrações (`hub/catalog/`): cada servidor MCP pode vir com `unused: true` (desligado, "Not configured" ou listado em `disabledMcpServers` do projeto) e a página mostra esses numa seção recolhida "Fora de uso". `GET catalog/env-keys` → nomes das variáveis dos `.env`/`.env.<x>` de cada projeto, por arquivo, **nunca valores** (o arquivo é lido byte a byte e o que vem depois do `=` é pulado; ficam de fora modelos como `.env.example`, `.envrc`, pastas de dependência/build/ponto/ignoradas pelo git). `GET catalog/vault[?unlock=1]` → CLI `op` do 1Password: instalado?, versão, com login?, endereço da conta, nomes dos cofres. Roda só `op --version`, `op whoami` e `op vault list`; o `vault list` só roda sozinho se já houver login (senão é o botão, com `unlock=1`, para o app do 1Password não pedir aprovação ao abrir a página). Nenhum token é recebido ou guardado: conta de serviço = `OP_SERVICE_ACCOUNT_TOKEN` no ambiente do servidor.
- M5, jobs do servidor (`hub/server_jobs.rs`): `GET automations/server-jobs` → `{jobs: [{source: crontab|launchd|systemd, name, schedule, next?, command, disabled?}], sources, truncated}`. Lê `crontab -l`, `~/Library/LaunchAgents/*.plist` (macOS, parser próprio de plist XML) e `systemctl list-timers --all --no-pager` (Linux). Só leitura. Comandos passam pela redação do catálogo (`catalog/redact.rs`, agora visível dentro de `hub`) mais cabeçalhos, `Bearer …` e `-u usuario:senha`; linhas de ambiente do crontab e `EnvironmentVariables` nunca saem.
- M5, mensagem fixada (`hub/pins.rs`, migração 9 `pinned_messages`): `GET|PUT|DELETE sessions/{id}/pin`. `PUT {message_id}`: o servidor lê o texto da conversa guardada e só aceita mensagem sua (agente → 400, inexistente → 404); uma por conversa. Web: `features/hub/pins.ts`, `PinnedMessageBar.vue`, `PinMessageButton.vue`.
- M5, reportar um problema: `POST apps/{ws}/scaffold` aceita `template: blank | issues`. O rodapé da barra lateral (`ReportProblem.vue`, `features/hub/report.ts`) cria `apps/reportes/` no primeiro projeto **só no clique** (e só se nenhum projeto tiver) e abre na Mesa; a lista fica em `apps/reportes/data/issues.json` via `tendly.data`.
- Catálogos (`hub/catalog/`): `GET catalog/integrations?refresh=1` (`claude mcp list` 20 s + cache 10 min, `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`; segredos removidos), `GET catalog/skills` (`~/.claude/skills`, plugins, `.claude/skills` dos workspaces, `~/.codex/skills`).

## Do Mac para a VPS
Kit e receita em `deploy/` (comece por `deploy/install.md`, escrita para o Claude Code seguir numa VPS Ubuntu nova). **Nada disso rodou numa VPS ainda**: foi escrito e revisado no Mac.

O que o Ian precisa providenciar, nesta ordem: (1) a VPS (Ubuntu 24.04, 4 GB+, acesso SSH por chave); (2) dois nomes de domínio, um para o app e um só para os publicados; (3) os registros DNS `A` (e `AAAA` se houver IPv6) dos dois nomes apontando para a VPS; (4) um e-mail para o Let's Encrypt e o Web Push; (5) decidir de onde vem o binário (CI do fork ou compilar na VPS) e se os dados do Mac vão junto; (6) entrar de novo nas contas do Claude e do Codex na VPS; (7) escolher o destino do backup de fora (restic).

**Por que a pasta do usuário na VPS é `/Users/iansantana` quando os dados vêm do Mac.** O `tendly.db` guarda caminhos absolutos: a raiz de cada projeto (`workspaces.root_path`), a pasta de configuração de cada conversa e de cada conta (`native_config_dir`, `config_dir`) e os worktrees (`checkout_path`). O Claude Code também nomeia o histórico pela pasta do projeto. Com outra pasta de usuário, os projetos aparecem como "pasta não existe" e as conversas antigas não retomam. Criando o usuário `tendly` com a pasta `/Users/iansantana` (passo 3 da receita, `T_HOME=/Users/iansantana`), todos esses caminhos continuam valendo sem editar banco nenhum. A alternativa é começar vazio em `/home/tendly` sem copiar nada: o `hub.db` sozinho não serve, porque automações, publicações e histórico apontam para ids de projeto do `tendly.db`.

**No Mac (exportar).** Espere as conversas em andamento terminarem e rode, na pasta do repositório:

```bash
TENDLY_BACKUP_DIR=~/tendly-export bash deploy/backup.sh     # cria ~/tendly-export/AAAA-MM-DD/
cd ~/tendly-export/AAAA-MM-DD && rm -rf tailnet.json token config.toml web
```

O script copia os bancos com `sqlite3 .backup` (cópia consistente com o servidor ligado; nunca copie `tendly.db` aberto com `cp`) e já deixa de fora o que só serve ao processo em execução. Ele ainda não foi executado nenhuma vez (no M4 só foi lido): confira que termina em `Done: …` e rode `bash deploy/backup.sh --check ~/tendly-export/AAAA-MM-DD` antes de enviar.

| dentro de `~/.tendly` | leva? | o que é |
| --- | --- | --- |
| `tendly.db` | sim | projetos, conversas, contas, perfis, Mesa |
| `hub.db` | sim | sino, automações, índice do histórico, publicações, espaços, aparelhos de push, configurações do hub (o fuso vai aqui) |
| `history/` | sim | o conteúdo das versões de arquivo |
| `published/` | sim | as cópias congeladas dos publicados |
| `push-seal.key` | sim | abre a chave do push guardada no `hub.db`; sem ele o par é refeito |
| `sessions/`, `accounts/` | sim | configuração e histórico de cada conversa e de cada conta (o login é refeito) |
| `conversations/` | sim | a pasta das conversas sem projeto |
| `secrets.toml` (se existir) | sim | chaves de API salvas no Tendly |
| `session-secret`, `tendly-metrics.db`, `price-list.json`, `agent-mcp/`, `file-search-home/` | tanto faz | são refeitos se faltarem |
| `tailnet.json` | **não** | ligaria o Tailscale do Mac na VPS |
| `token` | **não** | na VPS o token é o `TENDLY_TOKEN` de `/etc/tendly/tendly.env` |
| `config.toml` (se existir) | **não** | porta e rede do Mac |
| `web/` (se existir) | **não** | interface em disco ganha da embutida no binário |
| `*.db-wal`, `*.db-shm`, `*.lock`, `tendly.pid`, `tendly.log`, `pty/`, `native-bridge/` | **não** | estado do processo; o script já não copia, e o binário recria o `native-bridge/` |

**Fora do `~/.tendly`, e também precisa ir, nos mesmos caminhos:**
- as pastas dos projetos (`sqlite3 ~/.tendly/tendly.db "select name, root_path from workspaces"` lista todas). `node_modules` e outros binários compilados no Mac não funcionam no Linux: reinstale as dependências lá;
- `~/.claude/` (habilidades, plugins, `settings.json`, `CLAUDE.md`, e `projects/` para retomar conversas começadas fora do Tendly), `~/.claude.json` (servidores MCP) e `~/.codex/`. Revise depois: servidor MCP ou hook que aponta para um programa do Mac não existe na VPS.

```bash
rsync -a ~/tendly-export/AAAA-MM-DD/ root@VPS:/Users/iansantana/.tendly/
rsync -a --exclude node_modules ~/claude/ root@VPS:/Users/iansantana/claude/      # repita para cada pasta de projeto
rsync -a ~/.claude ~/.claude.json ~/.codex root@VPS:/Users/iansantana/
ssh root@VPS 'chown -R tendly:tendly /Users/iansantana && chmod 700 /Users/iansantana/.tendly'
```

**O que não viaja:**
- os logins. No Mac o do Claude fica no Keychain: entre de novo em cada conta (Configurações → Contas). O `auth.json` do Codex até vai junto, mas a renovação dele é de uso único: entre de novo na VPS e pare de usar aquela conta no Mac, senão um derruba o outro;
- as inscrições de push: são do endereço antigo. Remova os aparelhos em Configurações → Notificações e ligue de novo em cada um, já no endereço novo;
- o endereço do Tailscale (na VPS quem dá HTTPS é o Caddy).

**Depois do primeiro start na VPS, confira:** Configurações → Endereços e fuso horário mostra o fuso que veio do Mac (defina ali o endereço público); Automações mostra a próxima execução na hora certa; um projeto abre e uma conversa antiga carrega; publicar um arquivo de teste gera link no domínio dos publicados.

**Não deixe os dois rodando com as mesmas automações**: depois de mover, desligue as automações no Mac (ou pare o servidor do Mac), senão cada rotina roda duas vezes.

## Status
- [x] M5: os "could" sem conta externa. Mensagem por versão do histórico, Integrações (chaves em `.env` só com nomes, "Fora de uso", cofre do 1Password só leitura), "Jobs do servidor" nas Automações, fixar mensagem no topo da conversa, "Reportar um problema". Testado sem navegador: 153 testes hub (583 no servidor todo), 906 web; cada rota conferida com `curl` no servidor rodando. Não exercitado ao vivo: versão de agente com mensagem (não abro conversas), o `op` (não está instalado neste Mac), `systemctl` (só Linux), e a criação do app `reportes` (só no seu clique). Ver `replica/progress/M5.done`.
- [x] Fase 0: Rust, branch `ian`, build.sh, primeiro build ok
- [x] Fase 1: Início, sino, não lidas, barra Conversas, chips de contexto no chat (testado no navegador; 790 testes web ok)
- [x] Pendência da Fase 1 (pedido do Ian): a aba Conversas mostra só conversas SEM projeto e tem "Nova conversa". Implementação: workspace oculto em `~/.tendly/conversations` criado pelo servidor (`GET /api/hub/conversations`), filtrado da lista de Workspaces; Início com opção "Sem projeto".
- Regra do Ian: depois de compilar, sempre reiniciar o servidor (`~/tendly-src/bin/tendly-server restart`) e conferir no navegador.
- [x] Fase 2: automações (`/automacoes`), integrações (`/integracoes`), habilidades (`/habilidades`). Testado no navegador: rotina `* * * * *` rodou sozinha e apareceu no histórico; 50 integrações e 166 habilidades listadas. 794 testes web e 24 testes hub ok.
- [x] Fase 3: histórico (botão relógio no arquivo) e publicação (botão globo). Testado: salvar = Você, edição por fora = Fora do Tendly, restaurar; publicar com senha (401 sem, 303 com a certa, traversal 404), despublicar com confirmação na tela. 803 testes web e 49 hub ok.
- [x] M4 (preparação): configurações do hub (fuso, endereço público, ditado), agendador pelo fuso das configurações, links publicados com endereço público, Configurações → Endereços e fuso horário, e o kit `deploy/` (systemd, Caddy, backup, receita). Testado sem navegador: 125 testes hub (555 no servidor todo), 894 web, rotas de configuração e a regra "endereço público só em `/p/`" conferidas com `curl` no servidor rodando. O kit não rodou numa VPS: falta o Ian contratar VPS e domínios (ver "Do Mac para a VPS").
- [x] M3: app instalável (PWA) e notificações push. Testado sem navegador: manifest, `sw.js`, ícones, chave, inscrever/listar/remover, push de teste cifrado e push de uma rotina chegando num serviço de push de mentira em loopback, 410 removendo a inscrição. 881 testes web, 109 hub (539 no servidor todo). Falta o Ian conferir no celular por HTTPS (Tailscale): instalar, ligar o interruptor, "Enviar teste", tocar na notificação.
- [x] M2: espaços da Mesa, link de conversa como contexto, ditado. Testado: salvar/abrir espaço (409 em nome repetido e em revisão antiga), chip de conversa no composer, transcrição truncada. Ditado não testado com microfone real. 848 testes web, 82 hub, 17 agent ok.
- [x] M1: Continuar, composer completo no Início, Responder/Marcar todas/Rotinas recentes, Gerar senha, Pedir pro agente, Markdown publicado, Publicados nas Configurações, Ver/Usar no chat/filtro nas Habilidades, link da conversa no histórico, Autorizar no claude.ai. 829 testes web e 69 hub ok.
- [x] Fase 4: apps personalizados. Testado: app em branco aparece em Apps e na barra lateral, abre como aba da Mesa, contador e nota sobrevivem ao recarregar (arquivos em `data/`), Chat abre conversa ao lado com o chip do app. 813 testes web e 61 hub ok.
