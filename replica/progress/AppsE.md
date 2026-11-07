# AppsE — Etapa E de `replica/plan-apps.md`: o construtor

Rodada do piloto automático. Sem navegador: o que precisa ser visto na tela está no fim.

## Plano (decidido antes de escrever código)

Fatias, cada uma com testes, `build.sh`, conferência com `curl` e commit:

1. **Servidor: kit, modelos, scaffold, diagnóstico.**
   - `GET /api/hub/apps/kit.css`, `kit.js`, `kit-demo.html` (estáticos, como o `sdk.js`; entram em `frame::is_frame_request`).
   - Modelos em `crates/server/src/hub/apps/templates/<nome>.html`: `blank`, `kanban`, `table`, `calendar`, `dashboard`, `form`, `document` (e o `issues` que já existia). `POST apps/{ws}/scaffold` aceita `template` e `letter`.
   - `GET apps/{ws}/{slug}/diagnostics` (checagem estática + os erros que a página que emoldura o app relatou) e `PUT` para a página relatar. `GET apps` passa a trazer `errors` e `checked_at` por app.
2. **Servidor: atalhos e versões.**
   - Migração 12: `app_shortcuts` e `app_file_removals`.
   - `GET|POST shortcuts`, `PATCH|DELETE shortcuts/{id}`, `POST shortcuts/{id}/check` (lê `X-Frame-Options` e `frame-ancestors`).
   - `GET apps/{ws}/{slug}/versions`, `POST apps/{ws}/{slug}/versions/{id}/restore`.
3. **Web:** painel "Criar com o agente" (`builder.ts` + `CreateAppPanel.vue`), cards do catálogo, atalhos (catálogo, rail, Início, painel na Mesa), "Versões" no cabeçalho, demonstração do kit em `/design`.
4. **Documentos:** skill v2, `apps-summary.md`, `FORK.md`, `features.csv`, `schema.sql`, `components.md`, `.done`.

## Decisões

- **Kit sem a folha de estilos do Tendly.** O app roda numa origem opaca e não enxerga o `styles.css`. O `kit.css` traz os mesmos valores dos tokens (`replica/design/tokens.json` e `tokens.dark.json`) como variáveis `--t-*`; um teste confere que continuam iguais. Tema: `prefers-color-scheme` e `html[data-tendly-theme]` (que o SDK mantém).
- **Web components em DOM comum (sem shadow DOM)**, para o `kit.css` e o CSS do app alcançarem tudo.
- **Barra lateral → barra inferior** por largura do próprio app (container query, 640px), não da janela.
- **Versão do app = rajada de versões de arquivo** do histórico em `apps/<slug>/` (fora `data/` e `files/`), agrupadas por autor + conversa + intervalo: mesma conversa de agente com até 5 min entre arquivos é uma versão; "você" e "fora do Tendly" agrupam com até 60 s. O histórico não guarda o turno, então o intervalo é a fronteira (dois turnos seguidos em menos de 5 min viram uma versão só).
- **Voltar o app para uma versão** escreve, para cada arquivo, o conteúdo que ele tinha naquele ponto (versões novas, autor "você") e remove o que foi criado depois (o conteúdo fica no histórico; `app.json` nunca é removido). Nada do histórico é apagado.
- **Arquivo apagado:** o histórico não registra exclusão. A tabela nova `app_file_removals` guarda as exclusões vistas pelo recarregar (`live.rs`) daqui para a frente, para o "voltar" não ressuscitar arquivo que já tinha sido apagado naquele ponto. Exclusões anteriores a esta etapa não são conhecidas.
- **Atalho abre como painel `app`** com `metadata.shortcut = <id>` (o validador do painel já aceita; nada novo no upstream). Clicar no tile: painel na Mesa se o site deixa embutir; senão aba nova, com o motivo num aviso.
- **A checagem de "deixa embutir" é do servidor** (só cabeçalhos, nunca o corpo; http/https; sem usuário:senha no endereço; 8 s; até 5 redirecionamentos), guardada na linha do atalho e refeita depois de 24 h ou a pedido.
- **"Criar com o agente" não envia mais nada sozinho.** Antes chamava `POST /api/hub/start` (abria a conversa e gastava uso). Agora: scaffold do modelo, Mesa com o app à esquerda e uma conversa nova à direita, composer preenchido; enviar é seu.
- **Sugestões sem modelo:** modelo por palavras-chave (pt e en), nome pelas 2–3 primeiras palavras que importam, letra = primeira do nome, cor por modelo.

## Feito

### Fatia 1 (servidor): kit, modelos, scaffold, diagnóstico — commit "Apps E: kit, templates, diagnostics"
- `crates/server/src/hub/apps/kit.css` (304 linhas) e `kit.js` (~700 linhas): variáveis `--t-*` com os valores dos tokens claro/escuro, classes `t-page`, `t-button`, `t-field`, `t-card`, `t-grid`, `t-stat`, `t-badge`, `t-list`/`t-row`, e os elementos `t-app`, `t-nav`, `t-view`, `t-kanban` (arrastar com pointer events: mouse na hora, toque segurando 350 ms; ← → com o cartão em foco), `t-table` (filtro, ordenação, Enter abre), `t-pills`, `t-modal` (`<dialog>`), `t-state`, `t-chart` (SVG, barras e linha), `t-calendar`. Helpers `tkit.h/icon/toast/confirm/live/form/fill/date/ago/money/number/filterRows/sortRows/groupBy/monthGrid`. Textos do kit em inglês e pt (pelo `lang` da página ou do navegador).
- Servidos em `GET /api/hub/apps/kit.css|kit.js|kit-demo.html` (sem token, como o `sdk.js`; `frame::is_frame_request` ganhou `SHARED_PATHS`). O demo sai com o CSP sandbox dos apps.
- Modelos em `hub/apps/templates/*.html`: `blank` (lista "items"), `kanban` (colunas em `tendly.data`, cartões na coleção `cards`, lista + pílulas), `table` (`entries`, pílulas por categoria, totais), `calendar` (`events`, agenda do dia), `dashboard` (`entries`, 3 totais, 2 gráficos), `form` (`submissions`, formulário + lista + detalhe), `document` (`docs`, lista + editor com salvar automático e `holdReload`), e o `issues` de sempre (movido para a pasta). Placeholders `{{NAME}} {{LETTER}} {{DESCRIPTION}} {{COLOR}} {{ACCENT}}`. O `template.html` antigo (contador) saiu: o app em branco agora usa o kit.
- `POST apps/{ws}/scaffold` aceita `template` (qualquer um dos oito) e `letter`.
- `GET apps/{ws}/{slug}/diagnostics` → `{ok, problems:[{kind, message, file}], runtime}`: checagem estática (arquivo local citado que não existe, SDK depois do script do app, `tendly.` sem SDK, kit.js sem kit.css, kit.js depois do script do app) + o que a última janela do Tendly mostrando o app relatou (`PUT` com `{page, errors:[…]}`; memória, `HubStore.app_health`). `GET apps` traz `errors` (quantidade) e `errors_at` por app.
- `updated_at` do app agora é o arquivo mais novo da pasta (até 3 níveis, 400 arquivos; fora `data/`, `files/` e arquivos com ponto).
- Testes: 202 hub (7 novos, entre eles "todo modelo passa na checagem estática" e "nenhum placeholder sobra"); web `appsE-kit.test.mjs` (18): helpers do kit em Node, cores do kit = tokens (claro e os dois blocos escuros), cada modelo só usa tags/classes/helpers que o kit tem e os scripts compilam. Servidor rodando: 24 conferências (`live1.py`): sete modelos criados no workspace oculto com diagnóstico limpo e apagados; relatório de erros entra e aparece na lista.

### Fatia 2 (servidor): atalhos e versões — commit "Apps E: shortcuts and app versions"
- Migração 12: `app_shortcuts` e `app_file_removals` (teste de upgrade da versão 11).
- `hub/shortcuts.rs`: `GET /api/hub/shortcuts` → `{shortcuts, check_fresh_seconds: 86400}`, `POST` (`name`, `url` http/https sem usuário:senha, `letter?`, `color?`; 201 já com o veredito), `PATCH /{id}` (trocar a URL zera o veredito), `DELETE /{id}`, `POST /{id}/check` → veredito agora, com `reason_text`. Veredito = `embed: {allowed: true|false|null, reason, checked_at}`; `reason` ∈ `x-frame-options-deny|sameorigin`, `frame-ancestors[-none]`, `unreachable: …`. A origem do Tendly usada no `frame-ancestors` vem do `Host` (+ `X-Forwarded-Proto`). Máximo 200 atalhos.
- `hub/apps/versions.rs`: `GET apps/{ws}/{slug}/versions` → `{versions: [{id, author_kind, session_id, session_title, message, started_at, at, files, count, current}], truncated}` (até 2.000 linhas do histórico, 50 versões); `POST …/versions/{id}/restore` → `{restored, removed, unchanged, skipped}`. O `id` é o id da versão de arquivo mais nova da rajada (aceita qualquer id de arquivo do app).
- Exclusões: `live.rs` anota em `app_file_removals` cada arquivo que sumiu numa rajada (com o maior id do histórico naquele momento e a hora). Regra do "estado em V": um arquivo está ausente se há exclusão anotada com `after_version_id` ≥ a versão dele ≤ V **e** `removed_at` ≤ fim de V + 2 s. Uma exclusão que veio numa rajada só dela compartilha o id com a versão anterior; a hora separa as duas (ela não entra na versão anterior; voltar a essa versão traz o arquivo de volta, o que é inofensivo). Caso achado no servidor rodando: arquivo apagado e recriado com o mesmo conteúdo não ganhava linha no histórico (conteúdo igual = mesma versão) e a exclusão ficava "aberta", então o "voltar" apagava o arquivo. Agora `hold()` (`live.rs`) pergunta `versions::removal_open` e, se sim, grava uma linha mesmo com conteúdo igual (`history::keep_again`).
- O `prune` do histórico (60 dias) derrubou o primeiro rascunho do teste que envelhecia as versões para janeiro: o teste usa horas atrás.
- Testes: 210 hub (shortcuts: validação, veredito por cabeçalho, origem; versões: agrupamento, e pelo router: três rajadas, voltar para cada uma, arquivo apagado e recriado, 404/403). Servidor rodando (`live2.py`, 19 conferências): atalho para o próprio Tendly e para example.com (ambos "deixa embutir"), check, patch, delete; app de teste com versão ao nascer, edição sua pela API de arquivos vira versão "you", voltar para a primeira versão restaura o index.html e remove o notes.css, o voltar aparece como versão sua. O histórico do workspace oculto ficou com as linhas dos apps de teste (caminhos `apps/e-test-*`), que o próprio histórico limpa em 60 dias.
- `task_tests` (worktree, upstream): os 2 passam sozinhos (17 s, limite 20 s) e estouram em paralelo, como antes.

## Falta

- Fatia 3: web (painel criar, catálogo, atalhos, versões, demo do kit no `/design`, "+" no rail).
- Fatia 4: skill v2, `apps-summary.md`, FORK.md, features.csv, schema.sql, components.md, `.done`.
