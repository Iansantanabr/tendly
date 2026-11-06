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

(nada ainda)

## Falta

Tudo do plano acima.
