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

## Falta

- Fatia 2: atalhos (migração 12) e versões do app.
- Fatia 3: web (painel criar, catálogo, atalhos, versões, demo do kit no `/design`, "+" no rail).
- Fatia 4: skill v2, `apps-summary.md`, FORK.md, features.csv, schema.sql, components.md, `.done`.
