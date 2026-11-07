# Tendly → GCore

Decidido em 2026-11-07: o produto se chama **GCore** (G e C maiúsculos).

## Etapa 1 (feita): só o que se vê

O nome visível mudou; os nomes internos continuam `tendly`, para nada quebrar e
para continuar fácil trazer atualizações do Tendly original.

| Onde | Como |
|---|---|
| Textos das telas (en, pt-BR, zh) | `brand()` em `apps/web/src/i18n/index.ts`: `translate()` troca a palavra `Tendly` por `PRODUCT_NAME` depois de achar a tradução e antes de pôr os valores. As chaves e o `pt-BR.json` continuam com "Tendly" (strings do upstream seguem casando). Só troca a palavra inteira com maiúscula: `tendly_*`, `tendly.data`, `~/.tendly`, `TENDLY_*`, `X-Tendly-Client` ficam. Teste: `i18n/brand.test.mjs`. |
| Mensagens de erro do servidor | `api.ts` passa a mensagem por `brand()` antes de mostrar. `host-roots.ts` reconhece os dois nomes. |
| Fixo no código da web | `index.html` (título da aba, descrição, nome no iPhone), logo no topo (`App.vue`), título no celular, cartão em Preferências, `/design` (ChatPreview), erros da ponte dos apps (`app-bridge.ts`). |
| Servidor, visível | Manifesto do app instalado (`hub/pwa.rs`), título das notificações (`hub/push.rs`, `hub/pwa/sw.js`), página offline, página "só para o time" das publicações, descrições dos apps "issues"/"blank" (`hub/apps.rs`), erro do 1Password, nome padrão da máquina e aviso de versão no pareamento (`peers.rs`), demo do kit e modelo "Em branco". |

## Etapa 2 (a fazer): a troca global

Ainda dizem "Tendly" ou `tendly`. Cada grupo pode ser feito sozinho:

1. **Textos que só o agente lê**: descrições das ferramentas MCP (`agent.rs`, `agent_config.rs`, `agent_sessions.rs`, `agent_canvas.rs`, `peers.rs`, `hub/automations.rs`, `hub/transcript.rs`, `hub/apps/records/tools.rs`), prompts montados na web (`hub/apps.ts`, `builder.ts`, `conversation-link.ts`, `publish.ts`; esses já mostram GCore porque passam por `t()`), comentários do `sdk.js`/`kit.js`, a skill `skills/tendly-apps/SKILL.md`.
2. **Nomes que o agente e os apps usam**: ferramentas `tendly_*` → `gcore_*` (manter os nomes antigos como apelido por um tempo), `window.tendly` / `tendly.data` / `tendly.host` → `gcore.*` (com `tendly` como apelido, senão os apps existentes quebram), atributo `data-tendly-theme`, skill `tendly-apps` → `gcore-apps`. Conversas abertas precisam reiniciar para ver as ferramentas novas.
3. **Linha de comando e serviço**: binário e comando `tendly` (`cli.rs`, `update.rs`, `service.rs`, `daemon.rs`, `resume.rs`, `mcp.rs`), launchd/systemd/registro do Windows, `tendly update` (aponta para o npm do upstream; no fork não deve ser usado).
4. **Dados e configuração**: `~/.tendly` → `~/.gcore` (com migração ou link), variáveis `TENDLY_HOME`, `TENDLY_DB`, `TENDLY_TOKEN`, `TENDLY_ALLOWED_ORIGINS`, `TENDLY_WORKSPACE_ROOT` etc. (aceitar as duas por um tempo), chave `tendly.locale` do navegador e outras do `localStorage`, cabeçalho `X-Tendly-Client`, `user.name=Tendly` dos commits de worktree, provedor `tendly` no config do Codex.
5. **Código**: crates `tendly-server`, `tendly-runtime`, `tendly-domain`, `tendly-persistence`, pacote `@tendly/web`, fonte "Tendly Symbols", nome do repositório. É o grupo que mais atrapalha trazer atualizações do upstream: deixar por último, ou não fazer.

Ordem sugerida: 1 → 2 → 4 → 3 → 5. Na VPS (instalação nova) é o melhor momento para 3 e 4.
