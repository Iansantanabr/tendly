# Architecture: fork do Tendly (as funcionalidades centrais da Ratoeira, reconstruídas)

Base: `replica/recon.md` e `replica/features.csv` (95 linhas: 44 prontas, 13 parciais, 28 faltando, 10 fora).
As fases 1 a 4 já são a fatia vertical: pedir no Início → conversa na Mesa → aviso no sino → publicar, automatizar ou virar app.
Este documento planeja **o que falta**, sem refazer o que existe.

## Stack

A skill sugere Next.js + Postgres por padrão, mas o projeto já tem a stack do Tendly e roda. Trocar seria reescrever o produto para ganhar nada.

| camada | escolha | por quê |
| --- | --- | --- |
| web | Vue 3 + Vite + TypeScript (`apps/web`), embutido no binário | é o Tendly; a Mesa (canvas) já existe e é a parte mais difícil |
| estilo | CSS com tokens do Tendly (`styles.css`), regra do `design-tokens.test.mjs` | consistência com o upstream e tema claro/escuro prontos |
| servidor | Rust + axum (`crates/server`), código novo em `hub.rs` + `hub/` | um binário só, sem dependência de runtime; ganchos mínimos no upstream |
| banco | SQLite: `tendly.db` (upstream) + `hub.db` (fork, migrações próprias) | zero operação; um usuário; fácil de copiar no backup |
| auth | token único do Tendly (`security.rs`), cookie de sessão; loopback aberto | single-user; o próprio Tendly exige token fora do loopback |
| agentes | Claude Code e Codex pelas contas oficiais da pessoa (assinatura, não API) | é o que a Ratoeira faz e o Tendly já sabe fazer |
| jobs | tokio dentro do servidor (agendador de 30 s, observador de arquivos, limpezas) | o servidor já fica ligado; nada de cron externo |
| arquivos | disco em `~/.tendly` (blobs do histórico, publicados) e nas pastas dos projetos (apps) | conteúdo do usuário fica no lugar dele |
| push | Web Push (VAPID): RFC 8291 + 8292 implementados em `hub/push/crypto.rs` sobre `p256` + `hkdf` + `aes-gcm` (Rust puro, sem OpenSSL), envio pelo `reqwest` | padrão aberto, funciona no Android e no iPhone com o app instalado na tela inicial; o crate `web-push` puxaria OpenSSL |
| ditado | Web Speech API do navegador primeiro; Whisper local depois | zero infraestrutura agora; o áudio sai pelo serviço do navegador (avisar) |
| hospedagem | Mac agora; VPS Linux depois (binário x64/arm64 do CI, systemd, Caddy com HTTPS) | decisão do Ian: "Mac agora, VPS depois" |
| e-mail / pagamentos | nenhum | single-user, sem cobrança |

Um banco por responsabilidade (upstream vs fork), sem microsserviços.

## Schema

Tabelas em `hub.db`: migrações 1 a 11 em produção (a 8, `file_versions.message`, e a 9, `pinned_messages`, entraram no M5; a 10, `app_grants` e `app_frame_secret`, na Apps C; a 11, `app_records`, na Apps D).
Acesso: checagens na camada de dados. O `guard` autentica todo `/api/`, e cada rota do hub valida o id do workspace e o caminho (canonicaliza e confere o prefixo).

O SQL completo está em [`schema.sql`](schema.sql). Restrições importantes:

- `pinned_messages.session_id PRIMARY KEY`: uma mensagem fixada por conversa.
- `app_records PRIMARY KEY (workspace_id, slug, collection, id)` com `rev >= 1` e `json_valid(data)`: um registro por id em cada coleção de cada app. A regra "escrever com `rev` velho é recusado" fica no código, dentro da mesma trava da conexão (ler o `rev`, comparar, gravar), não num gatilho.

- `publications UNIQUE(workspace_id, path)`: publicar o mesmo arquivo de novo edita a publicação, não cria outra.
- `push_subscriptions.endpoint UNIQUE`: o mesmo navegador inscrito duas vezes vira uma linha só.
- `spaces UNIQUE(name)`.
- Uma automação nunca roda duas vezes ao mesmo tempo. Isso é garantido no código (mapa de execuções em andamento), não no banco, porque o banco não vê o processo.
- Referências a sessões e workspaces apontam para outro banco (`tendly.db`). São checadas no código, e as listas pulam o que não existe mais.

## API

Rotas novas, todas em `/api/hub/` e todas exigindo o mesmo token. Escritas também exigem `X-Tendly-Client: web`.

### M1: acabamentos (só interface ou quase)

| método e caminho | faz | entrada | saída | fluxo |
| --- | --- | --- | --- | --- |
| `GET automations/recent-sessions?limit=` | conversas abertas por rotinas de agente, mais novas primeiro | — | `{items:[{session_id, automation_id, automation_name, started_at, status}]}` | F06 (Rotinas recentes) |
| `GET publications` (já existe) | lista de publicados, agora também numa aba de Configurações | — | lista | F05 |
| `POST start` (já existe) | usada por "Pedir pro agente" no Publicar e por "Usar no chat" nas Habilidades | `{workspace_id, provider, prompt, endpoint_id?, model?, effort?, permission?}` (os 2 últimos campos são novos) | `{id}` | F05, F08, F01 |
| `GET catalog/skills/{id}/content` | conteúdo do SKILL.md de qualquer origem (só leitura, só dentro das pastas varridas) | — | `{path, content}` | F08 (Ver) |

As outras peças do M1 são só interface:
- "Continuar" no Início: última sessão com `last_turn_at`.
- "Responder" na barra de Conversas.
- "Marcar todas" na barra (`POST activity/seen-all`, já existe).
- Filtro por pasta nas Habilidades.
- Link "Autorizar no claude.ai" (`https://claude.ai/settings/connectors`).
- "Gerar" senha (`crypto.getRandomValues`).
- Link do histórico para a conversa.
- Composer do Início com conta, modelo, esforço e permissão (reusar `ModelSelection`/`ModelPicker`).
- Uso 5h/semana no seletor de conta (reusar os `limits` já mostrados no `AccountsDialog`).

### M2: chat e Mesa

| método e caminho | faz | entrada | saída | fluxo |
| --- | --- | --- | --- | --- |
| `GET spaces` | espaços salvos | — | `{spaces:[{id,name,updated_at}]}` | Mesa |
| `POST spaces` | salva a Mesa atual com nome | `{name, layout}` | espaço | Mesa |
| `PATCH spaces/{id}` / `DELETE spaces/{id}` | renomeia, atualiza ou apaga | `{name?, layout?}` | espaço / 204 | Mesa |
| `POST spaces/{id}/open` | aplica no canvas compartilhado (save com revisão) | `{expected_revision}` | `{revision}` ou 409 | Mesa |
| `GET sessions/{id}/transcript?max_chars=` | texto da conversa para contexto (mensagens e resumo das ferramentas) | — | `{title, text, truncated}` | colar link de conversa |
| ferramenta MCP `tendly_read_conversation` | o agente lê outra conversa pelo id ou link | `{session}` | texto | colar link de conversa |

O ditado é só interface: um botão de microfone no composer usa `SpeechRecognition` com `lang=pt-BR`. Ele some quando o navegador não suporta e respeita `hub_settings.dictation`.

### M3: celular

| método e caminho | faz | entrada | saída |
| --- | --- | --- | --- |
| `GET /manifest.webmanifest`, `GET /sw.js` | PWA instalável; o service worker guarda só o shell e trata `push`/`notificationclick` (rotas do servidor em `hub/pwa.rs`, iguais com o web embutido ou em `~/.tendly/web`) | — | arquivos |
| `GET push/key` | chave pública VAPID | — | `{key}` |
| `POST push/subscriptions` | inscreve este aparelho (ou atualiza, pelo endpoint) | `{endpoint, keys:{p256dh, auth}, label}` | `{id}` |
| `GET push/subscriptions` | aparelhos inscritos, sem segredo nenhum | — | `{subscriptions:[{id, label, service, endpoint_sha256, created_at, last_ok_at, failures}]}` |
| `DELETE push/subscriptions/{id}` | desinscreve | — | 204 |
| `POST push/test` | manda uma notificação de teste | — | `{sent, failed, removed, waiting}` |
| `GET inbox?focused=<sessão>` | (já existia) o navegador diz qual conversa está na frente da pessoa | — | — |

`home::notify()` dispara push para cada inscrição, com título, corpo e URL `/session/{id}` (ou `/notificacoes`). O disparo acontece numa tarefa à parte, para não segurar o fim do turno, e é pulado para a conversa que um navegador diz estar na tela, em janela com foco e com a pessoa mexendo (M3 feito).

### M4: VPS

| método e caminho | faz | entrada | saída |
| --- | --- | --- | --- |
| `GET/PUT settings` | `timezone`, `public_base_url`, `dictation` (feito no M4; um valor inválido recusa o pedido inteiro). Etapa A dos apps: `mesa_sidebar` (`icons` \| `expanded`) e `app_order` (objeto `{pinned, order, hidden}` de `<workspace>/<slug>`) | `{key: value}` | mapa |
| `GET settings/timezones` | os fusos que o servidor aceita, para o seletor, e o fuso do relógio da máquina | — | `{zones, server}` |

Fora da API (kit em `deploy/`, feito no M4, ainda não rodado numa VPS):
- `deploy/tendly.service`: unit de sistema com usuário próprio e sandbox. Não é o `tendly service install` do upstream, que cria um unit de usuário sem token obrigatório.
- `deploy/Caddyfile`: HTTPS automático para dois domínios: o do app (tudo) e o dos publicados (só `/p/*`, o resto 404).
- `deploy/backup.sh` + timer: backup diário do `~/.tendly` (bancos por `sqlite3 .backup`, 14 dias, restic opcional), incluindo `hub.db`, `history/` e `published/`.
- `deploy/install.md`: a receita que o Claude Code segue para instalar tudo.

O link publicado usa `public_base_url` quando definido (`public_url` em cada publicação; "só a equipe" continua no endereço do app). O servidor só responde por esse nome em `/p/...`: ele nunca vira `Host` do app nem `Origin` aceito pela API (gancho no `guard`).

### M5: os "could" sem conta externa (feito)

| método e caminho | faz | saída |
| --- | --- | --- |
| `GET history`, `GET history/versions/{id}` (já existiam) | cada versão traz `message`: uma linha do que o agente disse | `message: texto \| null` |
| `GET catalog/integrations` (já existia) | cada servidor pode vir com `unused: true` | lista |
| `GET catalog/env-keys` | nomes das variáveis dos `.env` de cada projeto, nunca valores | `{workspaces:[{workspace_id, workspace_name, files:[{path, names:[{name, secret}]}], truncated}]}` |
| `GET catalog/vault?unlock=` | CLI `op` do 1Password: login e nomes dos cofres | `{installed, platform, version?, signed_in, account?, service_account, listed, vaults, error?}` |
| `GET automations/server-jobs` | crontab, LaunchAgents, timers do systemd, só leitura | `{jobs:[{source, name, schedule, next?, command, disabled?}], sources, truncated}` |
| `GET\|PUT\|DELETE sessions/{id}/pin` | a mensagem fixada no topo da conversa (`PUT {message_id}`) | `{pin: null \| {message_id, text, pinned_at}}` |
| `POST apps/{ws}/scaffold` (já existia) | aceita `template: blank \| issues` | app (201) |

### Apps B: tela cheia, recarregar sozinho, erros do app (feito)

| método e caminho | faz | saída |
| --- | --- | --- |
| web `/apps/{ws}/{slug}` | o app na página inteira, com o rail; Conversar abre uma coluna de chat ao lado | página |
| `GET apps/{ws}/{slug}/changes` | a mudança mais recente do app (e indexa o app, para a próxima poder ser desfeita) | `{latest: null \| {id, at, paths, count, undoable, undo_of, redo}, quiet_ms}` |
| `POST apps/{ws}/{slug}/changes/{id}/undo` | volta os arquivos do app para antes daquela mudança, pelo histórico de arquivos; só a mais recente | `{undone, restored, removed, skipped:[{path, reason}]}`; 404, 409 |
| socket `agent-activity/ws` (já existia) | mensagem nova `{type:"hub", event:"app-changed", workspace_id, slug, change}` 600 ms depois da última escrita em `apps/<slug>/` (fora de `data/`) | — |
| `GET apps/sdk.js` (já existia) | passa a avisar erros e a página em vista para a página que emoldura o app, e ganha `tendly.host.holdReload` | JS |

Como o "antes" é guardado: `hub/apps/live.rs` mantém em memória, por app, o que cada arquivo continha na última rajada (hash do conteúdo, já salvo como versão no histórico). No fim de uma rajada compara com o disco; a diferença é a mudança. Nada disso vai para o `hub.db`: reiniciar o servidor esquece as mudanças (o histórico por arquivo continua lá).

### Apps C: origem própria, ponte e permissões (feito)

| método e caminho | faz | saída |
| --- | --- | --- |
| `GET /apps-run/{ws}/{slug}/{token}/{caminho}` (fora de `/api`) | um arquivo do app para quem tem o token; CSP `sandbox` sem `allow-same-origin`, `ACAO: *`, `CORP: cross-origin` | o arquivo; 404 seco para token errado, vencido, de outro app ou caminho proibido |
| `GET apps/{ws}/{slug}/frame` | um endereço novo para a moldura (token de 8 h) | `{base, url, token, expires_at, renew_after_seconds}` |
| `POST apps/{ws}/{slug}/frame/renew` | mantém vivo o endereço de uma moldura aberta | `{expires_at, renew_after_seconds}`; 410 vencido, 404 |
| `GET apps/{ws}/{slug}/files[/…]` (já existia) | o endereço antigo: redireciona para o novo | 307 |
| `GET apps/{ws}/{slug}/grants` | o que o app pede e o que você respondeu | `{requested, granted, refused, pending, status}` |
| `PUT apps/{ws}/{slug}/grants` | a resposta: `granted` permitido, o resto recusado | o mesmo; 400 para o que o app não pede |
| `GET apps/{ws}/{slug}/tendly/sessions` | lista de conversas (`sessions:read`), sem transcrição | `{sessions, total}` |
| `GET apps/{ws}/{slug}/tendly/files` · `…/tendly/file` | pasta e arquivo de texto ≤ 1 MB do workspace do app (`files:read`), sem nada com ponto | `{path, entries}` · `{path, content, size}` |
| `GET apps/{ws}/{slug}/tendly/automations` | automações com as últimas execuções (`automations:read`), sem comando nem saída | `{automations}` |
| `POST apps/{ws}/{slug}/notify` | aviso no sino e push (`notify`), com link para o app | `{ok}`; 429 |
| `GET apps/sdk.js` (já existia) | agora é público (o mesmo script para todos) e fala só por `postMessage` | JS |

Quem confere o quê: o **guard** recusa tudo que vem da moldura para `/api` (origem `null` ou `sec-fetch-site: cross-site`), menos a leitura de `/apps-run/…` e do SDK; o **token** diz de qual app são os arquivos; a **página do Tendly** só ouve a janela da moldura e faz os pedidos com as credenciais dela; o **servidor** confere a permissão em cada rota `tendly/*` e no `notify`. A página decide sozinha só o que só ela pode fazer (rascunho no composer, abrir na Mesa, toast).

### Apps D: coleções, ao vivo, arquivos, exportar/importar (feito)

| método e caminho | faz | saída |
| --- | --- | --- |
| `GET apps/{ws}/{slug}/db` | as coleções do app | `{collections: [{name, count, updated_at}]}` |
| `GET apps/{ws}/{slug}/db/{coleção}` · `POST …/query` | lista com `where` (igualdade em campos de topo, ou `in`), `order`, `limit`, `offset`; `count: true` só conta | `{records, total, truncated}` · `{total}`; 400 para filtro que não existe |
| `POST apps/{ws}/{slug}/db/{coleção}` | registro novo (`{data, id?}`) | 201 o registro; 409 `exists` + `current`; 413 (5 MB, 50.000, 100 coleções) |
| `GET …/db/{coleção}/r/{id}` | um registro | `{id, rev, created_at, updated_at, data}`; 404 |
| `PATCH …/db/{coleção}/r/{id}` | muda campos de topo (`{patch, rev?}`) | o registro; **409 `conflict` + `current`** se o `rev` está velho; 404 |
| `PUT …/db/{coleção}/r/{id}` | troca tudo ou cria com esse id (`{data, rev?}`) | 200 / 201; 409; 404 se veio `rev` e não existe |
| `DELETE …/db/{coleção}/r/{id}?rev=` | remove | `{removed}` (falso se já não existia); 409 |
| `DELETE …/db/{coleção}` | esvazia a coleção | `{removed: n}` |
| `GET …/db/{coleção}/export?format=json\|csv` | a coleção inteira num arquivo | anexo `<slug>-<coleção>.json\|csv` |
| `POST …/db/{coleção}/import?format=&mode=merge\|replace` | lê o arquivo para a coleção, tudo ou nada | `{inserted, updated, removed, total}`; 400 diz a linha |
| `GET apps/{ws}/{slug}/uploads` | arquivos enviados | `{files: [{path, name, size, type, updated_at}]}` |
| `POST apps/{ws}/{slug}/uploads?name=` | guarda os bytes em `apps/<slug>/files/` com nome seguro | 201 `{path, …}`; 415 (não é imagem nem PDF); 413 (20 MB, 2.000 arquivos) |
| `DELETE apps/{ws}/{slug}/uploads/{nome}` | remove um arquivo enviado | `{removed}` |
| socket `/api/agent-activity/ws` (já existia) | `{type:"hub", event:"app-records", workspace_id, slug, collection, change}` a cada escrita | — |
| MCP `tendly_app_records_list\|get\|upsert\|delete` | o agente lê e escreve os registros de um app | o registro / a lista; conflito com o registro atual no texto |

Como uma escrita chega ao outro painel: o app chama `leads.update(...)` → o SDK manda a mensagem para a página → a página faz o `PATCH` → o servidor grava e avisa todas as janelas pelo socket → cada `AppView` daquele app repassa para a própria moldura, se o app se inscreveu naquela coleção → o SDK chama os `subscribe`. O mesmo caminho serve para o que o agente escreve pelas ferramentas MCP e para o que outra janela (o celular) escreve.

Quem confere o quê: o **servidor** valida nomes, tamanho, quantidade, o `rev` e o filtro (os valores e os nomes de campo do `where` são parâmetros de um SQL de forma fixa; não há texto do app dentro do SQL); o tipo de um arquivo enviado vem dos bytes, e o nome guardado é feito no servidor. A **página** só transforma cada chamada num pedido sobre aquele app (nomes conferidos antes de virar caminho) e repassa mudanças só da coleção pedida. A **moldura** continua sem alcançar `/api`: ler, gravar, exportar e enviar arquivo de dentro dela dá 403.

### Webhooks e jobs

Webhooks entrando: nenhum. Webhooks saindo: Web Push (M3).

| job | quando | faz |
| --- | --- | --- |
| agendador de automações | a cada 30 s | roda o que venceu; não recupera horário perdido |
| observador do histórico | contínuo, com debounce de 1,5 s, relista workspaces a cada 60 s | grava versões |
| limpeza do histórico | de hora em hora | 100 versões / 60 dias, blobs órfãos |
| limpeza de inscrições push (M3) | a cada envio | remove após 404/410 ou 5 recusas seguidas; serviço fora do ar ou pedindo pausa (`Retry-After`) não conta |
| backup (M4) | diário, cron/systemd timer da VPS | copia `~/.tendly` para fora da máquina |

Somente APIs oficiais e públicas com as chaves do próprio Ian. Nada da Ratoeira é chamado ou copiado.

## The parts that bite

- **Fusos horários:** na VPS o relógio fica em UTC, e uma automação "todo dia às 9h" sem fuso rodaria às 6h de Brasília. Por isso o padrão vira `hub_settings.timezone` (America/Sao_Paulo), nunca o fuso da máquina. O croner calcula a próxima execução no fuso da automação e guarda em UTC.
- **Idempotência:**
  - o agendador marca a execução antes de iniciar; se o servidor reiniciar, as execuções que ficaram "rodando" viram "falhou" (já é assim);
  - push repetido para o mesmo aparelho é evitado pelo `endpoint UNIQUE`;
  - "Pedir pro agente" e "Criar com o agente" desabilitam o botão até a resposta, para não abrir duas conversas.
- **Corridas:**
  - duas janelas do Tendly brigam pelo canvas (visto no teste da Fase 4), e "abrir espaço" usa o mesmo save com revisão, então o 409 vira aviso e não sobrescreve;
  - o observador do histórico versus um salvamento pela interface já é resolvido pelo hash de 10 s;
  - os dados dos apps usam gravação atômica, e a última escrita vence.
- **Limites de tamanho:** histórico 1 MB por arquivo, dados de app 1 MB por chave, publicados 200 arquivos / 20 MB, transcrição de conversa para contexto limitada por `max_chars`.
- **Limites de taxa:** `claude mcp list` leva cerca de 7 s, então tem cache de 10 min; senha errada no publicado, 10 por minuto; Web Push respeita `Retry-After` do serviço.
- **Busca:** habilidades e apps são filtrados no navegador (centenas de itens). Busca em conversas fica com a do upstream.
- **Tempo real:** o sino e as não lidas usam polling (o ciclo do App.vue). O push no celular cobre "fora da janela". Trocar por WebSocket só se o polling pesar.
- **Offline:** o PWA guarda só o shell; sem servidor não há conversa. Mostrar "sem conexão" em vez de fingir que funciona.
- **HTTPS:**
  - Web Push, service worker, microfone e `crypto.subtle` exigem contexto seguro;
  - `localhost` conta como seguro, mas o celular não acessa o Mac por localhost;
  - no Mac, a saída é o `tailscale serve` com HTTPS (o Tendly já integra Tailscale); na VPS, o Caddy;
  - por isso o M3 depende de HTTPS e é testado primeiro pelo Tailscale.
- **Segurança na VPS:**
  - o token passa a ser obrigatório. Atenção: atrás do Caddy o servidor escuta em loopback, e em loopback o Tendly **não** pede token a não ser que exista um. Por isso o `TENDLY_TOKEN` é obrigatório no arquivo de ambiente e o unit se recusa a iniciar sem ele;
  - o domínio dos publicados só serve `/p/*` (no Caddy e de novo no servidor) e não é origem aceita pela API;
  - o publicado fica fora de `/api` e com CSP sandbox;
  - apps rodam numa moldura com origem opaca (Apps C): CSP `sandbox` sem `allow-same-origin` em `/apps-run/…`, no mesmo host, então o Caddy e o Tailscale não mudam. O token do endereço é a credencial dos arquivos daquele app (nunca `data/`); a API recusa qualquer pedido vindo da moldura. Em loopback sem token essa recusa depende de o navegador mandar `Origin` ou `Sec-Fetch-Site` (todos os atuais mandam); com token (VPS, Tailscale) o cookie `SameSite=Strict` também não acompanha;
  - o que o app manda para a página (erros, tela, `holdReload`) é só leitura de texto: a página confere a origem e a janela da moldura, corta os tamanhos e nunca executa nem navega com o que recebe. "Pedir correção" põe esse texto num composer; quem envia é a pessoa;
  - o 1Password (M5, feito só leitura) usa o CLI `op`; o token da conta de serviço fica na variável `OP_SERVICE_ACCOUNT_TOKEN` do ambiente do servidor e o Tendly não o recebe nem guarda;
  - a lista de chaves dos `.env` (M5) devolve só nomes: o valor é pulado byte a byte na leitura.
- **Privacidade do ditado:** a Web Speech API do Chrome manda o áudio para o Google. Mostrar isso na primeira vez e deixar desligar. Um Whisper local fica para quando houver VPS com CPU sobrando.
- **Mac dormindo:** a automação não roda e não é recuperada (a tela já mostra a próxima execução). Isso some na VPS.
- **Apagar dados:** apagar uma publicação apaga a cópia congelada; apagar uma automação apaga as execuções; o histórico tem retenção. Não há dados de terceiros (LGPD/GDPR só entram no multiusuário).

## Build order

1. **Fatia vertical: feita** (fases 1 a 4).
   - Telas S01–S05, S07–S16.
   - Tabelas: `notifications`, `session_activity`, `automations`, `automation_runs`, `file_versions`, `publications`.
   - Rotas: `/api/hub/*` (inbox, activity, start, conversations, automations, catalog, history, publications, apps).

2. **M1: acabamentos de must e should (1–2 dias), sem tabela nova**
   - S01: Continuar; composer com conta, modelo, esforço e permissão; uso por conta no seletor.
   - S04: Responder inline, Marcar todas, Rotinas recentes (`GET automations/recent-sessions`).
   - S08: link para a conversa que mudou o arquivo.
   - S09: Gerar senha, Pedir pro agente, markdown publicado renderizado (`pulldown-cmark`), aba "Publicados" em Configurações.
   - S12: link Autorizar no claude.ai.
   - S13: Usar no chat, Ver (`GET catalog/skills/{id}/content`), filtro por pasta.

3. **M2: chat e Mesa (2–3 dias)**
   - S05: ditado (Web Speech), colar link de conversa como contexto (`GET sessions/{id}/transcript` + `tendly_read_conversation`).
   - S02: espaços nomeados (migração 5, rotas `spaces`).

4. **M3: celular (2 dias, depende de HTTPS pelo Tailscale)**
   - S18: PWA (manifest + service worker), Web Push (migração 6, rotas `push/*`, disparo no `notify`).
   - Conferir o layout mobile do Tendly no aparelho.

5. **M4: VPS (2–3 dias, etapa à parte)**
   - Preparação feita: `hub_settings` (migração 7) com fuso, domínio dos publicados e ditado; kit `deploy/` (systemd, Caddy + HTTPS, backup, receita `deploy/install.md`).
   - Falta: a VPS, os domínios e o DNS (do Ian), rodar a receita, trazer os dados do Mac.
   - Fecha o must "rodar 24h num servidor".

6. **M5: coulds, feito o que não depende de conta externa**
   - Mensagem por versão (migração 8).
   - Integrações: Fora de uso, chaves em `.env` (só nomes), cofre 1Password via `op` (só leitura).
   - Inventário de jobs do servidor (crontab, LaunchAgents, timers do systemd).
   - Fixar mensagem (migração 9), app de "Reportar um problema".
   - Ficou de fora: rail de ícones na Mesa e versão publicada de app por commit (não estavam no pedido do M5).

   - Apps A–D (plano em `plan-apps.md`): rail, tela cheia com Conversar e recarregar sozinho, origem própria com ponte e permissões (migração 10), coleções com revisão, ao vivo e arquivos (migração 11). Faltam E (modelos, kit de UI, versões do app, atalhos) e F (apps com servidor).

7. **Depois: multiusuário**
   - Pessoas, permissões por pasta, compartilhar conversa (ler/participar), "Entre nós", @menções, contas da organização.
   - Esboço no fim de `schema.sql`.

8. **Correções que o `/replica-entrepreneur` apontar**, quando rodar.

Cada milestone segue a regra do fork: compilar com `~/tendly-src/build.sh`, reiniciar, testar no navegador, commit + push, e atualizar `FORK.md` e `features.csv`.
