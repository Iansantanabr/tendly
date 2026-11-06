# Plano: construtor de apps e rail de ícones

Base: `recon-apps.md`. Ordem pensada para que cada etapa já mude o uso do dia a dia e não dependa das seguintes. Cada etapa termina com testes, `build.sh`, conferência no navegador e commit, como nas fases anteriores.

## Decisões de arquitetura (antes de construir)

1. **App continua sendo uma pasta `apps/<slug>/` no workspace**, versionada pelo histórico de arquivos. O agente edita arquivos normais; nada de formato fechado.
2. **Segurança do iframe: separar a origem do app.**
   - **Problema de hoje:** o app roda com `allow-same-origin` na origem do Tendly. Qualquer app (ou um script de CDN que ele carregue) pode chamar a API inteira: abrir sessões, ler arquivos, mudar configurações.
   - **Antes de dar mais poder aos apps:** servir os apps num host separado (ex.: `apps.127.0.0.1.nip.io:28789`, ou um subdomínio na VPS) ou num sandbox sem `allow-same-origin`.
   - **Daí em diante:** toda conversa com o Tendly passa por uma **ponte `postMessage`**, com as permissões declaradas no `app.json` e aceitas uma vez pela pessoa.

   É a base de tudo que vem depois.
3. **Dois níveis de app.**
   - **Nível 1, estático + SDK** (padrão): HTML/JS, com dados, arquivos, ponte e leitura de dados do Tendly. Cobre kanban, CRM, calendário, painel e editor.
   - **Nível 2, com servidor** (opcional, `"server": "server.mjs"` no `app.json`): o Tendly roda o processo com `node`, supervisionado, escutando só em loopback, e encaminha `/…/<slug>/api/*` para ele. Serve para ações pesadas ("Salvar e renderizar"), webhooks (leads de fora), jobs e checagens.
4. **Dados em coleções no `hub.db`** (registros com `rev`), mantendo `tendly.data` como está. JSON em arquivo continua para quem quer, mas não aguenta dois painéis editando a mesma coisa.

## Etapa A: barra lateral e rail de ícones  ·  S

O que você pediu e o que mais se vê.

- **Rail na Mesa (S16).**
  - Coluna fixa de ~56px com: Início, Mesa, Habilidades, Integrações, Automações; o ícone de grade para o catálogo; os tiles dos apps (tooltip com o nome, o app aberto destacado, rolagem própria se houver muitos); e, embaixo, o sino com número, Reportar e Configurações.
  - O painel Workspaces/Conversas fica **ao lado**, com o próprio botão de recolher. Isso tira o menu alto de cima da lista.
- **Barra expandida (S17)** no Início, nas páginas e no catálogo:
  - "Apps ›" leva ao catálogo, com "+" para criar;
  - a lista vertical de até 8 apps no lugar dos chips em grade de hoje;
  - "Ver todos".
- **Preferência:** "Barra na Mesa: ícones | expandida", com padrão ícones, como na fonte. O celular continua com a gaveta.
- Arrastar um tile do rail para a Mesa abre o app como painel (reusa o arrastar de abas).
- **Ordem e fixar:** o menu "…" do tile tem Fixar no rail, Mover para cima/baixo e Esconder. Fica guardado em `hub_settings` (`app_order`).
- **Teste:** janela de 640px e de 900px, 360px, tema escuro, teclado (Tab/setas no rail, Enter abre).

## Etapa B: app em tela cheia e o loop "Conversar"  ·  M

O loop principal, F10.

- **Rota `/apps/<workspace>/<slug>` (S15):**
  - o rail à esquerda;
  - um cabeçalho fino com tile + nome, **Conversar**, **Abrir na Mesa**, recarregar, copiar link, abrir fora e "código em apps/<slug>/" (abre a pasta no explorador);
  - o app ocupa o resto.
- **Conversar em tela cheia** abre um painel de chat à direita (redimensionável, fecha com Esc), já com o chip do app. O mesmo botão no painel da Mesa divide ao lado, como hoje.
- **Recarregar sozinho:** o `file_watch` do workspace avisa quando algo muda em `apps/<slug>/` (fora de `data/`). O app recarrega depois de 600 ms sem mudanças e mostra "Atualizado agora · desfazer". Desfazer volta os arquivos do app para a versão de antes do turno, usando o histórico.
- **Erros do app:** a ponte captura `error` e `unhandledrejection`. O cabeçalho mostra "2 erros", com a lista e o botão **"Pedir correção"**, que manda para o chat aberto (ou um novo) o erro, o arquivo e a linha, o app e a tela atual.
- **Teste:** pedir uma mudança, ver recarregar sozinho e desfazer; quebrar o app de propósito e ver "Pedir correção".

## Etapa C: ponte app ↔ Tendly (SDK v2) e origem separada  ·  M

- **Origem separada** (decisão 2), com migração transparente para os apps que já existem (o `sdk.js` continua com a mesma API).
- **`tendly.host`:**
  - `setContext({ view, selection, summary })`: o chip vira "Sessões · Quadro" e o agente recebe a tela e o item selecionado (P32);
  - `openConversation(id)`, `openFile(path)`, `openApp(slug)`, `openUrl(url)`: abrem na Mesa (F12, o "Abrir" do card de sessão);
  - `draftChat(text, { attach })`: abre o composer **preenchido, sem enviar**. Enviar continua com a pessoa, porque gasta uso da conta;
  - `notify(title, body)` (sino + push), `toast(text)`;
  - `theme` / `onTheme`, `pane` (largura, foco) / `onResize`: para o app trocar para a navegação inferior em painel estreito (P13).
- **Permissões no `app.json`:** `"permissions": ["sessions:read", "files:read", "automations:read", "notify", "agent:draft"]`.
  - Ao abrir o app pela primeira vez, ou quando a lista muda, um cartão mostra o que ele quer e pede Permitir/Recusar. Fica guardado em `hub.db` (`app_grants`).
- **Dados do Tendly para apps**, só leitura e só com permissão: lista de sessões (título, estado, workspace, provedor, idade, resumo), arquivos de um workspace (listar/ler) e automações com as últimas execuções. É o que o app "Sessões" precisa.
- **Teste:** um app de teste que pede `sessions:read`; recusar e ver o erro claro; permitir e ver a lista.

## Etapa D: dados de verdade (coleções, arquivos, ao vivo)  ·  M

- **`tendly.db.collection('leads')`:** `list({ where, order, limit })`, `get(id)`, `insert(doc)`, `update(id, patch, { rev })`, `remove(id)`.
  - Usar `rev` evita sobrescrever o que outro painel salvou; se houver conflito, vem 409 com o registro atual.
  - Migração 10 cria `app_records(workspace_id, slug, collection, id, data, rev, created_at, updated_at)`.
  - Limites: 5 MB por registro, 50 mil por coleção.
- **Ao vivo:** `collection.subscribe(cb)` por WebSocket. Dois painéis do mesmo app se atualizam sozinhos.
- **Arquivos:** `tendly.files.upload(file)` → `apps/<slug>/files/…` (imagens, PDF, até 20 MB), `url(path)` e `list()`. É o "Subir outra foto" da Bancada.
- **Exportar/importar** uma coleção em JSON ou CSV no menu "…" do app. O agente também lê e escreve coleções pelas ferramentas MCP do Tendly (`tendly_app_records_*`), para "o agente sugere resposta para o lead".
- **Teste:** dois painéis do mesmo kanban arrastando o mesmo card; conflito resolvido sem perder dado.

## Etapa E: o construtor (criar e evoluir apps)  ·  M

- **"Criar com o agente"** (catálogo e "+" do rail) abre um painel curto:
  - o que o app faz (uma frase);
  - um modelo: **Em branco, Kanban/CRM, Tabela, Calendário, Painel com gráficos, Formulário + lista, Editor de documentos**;
  - nome, letra e cor sugeridos a partir da frase.

  Ao criar:
  1. o scaffold sai do modelo, que já funciona e usa o kit;
  2. a Mesa abre com o **app à esquerda e a conversa à direita**;
  3. a primeira mensagem vai preenchida e você envia.
- **Kit de UI para apps:** `/…/apps/kit.css` + `kit.js` (web components sem build).
  - Componentes: barra lateral do app que vira barra inferior em painel estreito, kanban com arrastar, tabela com filtro, cards, filtros em pílula, modal, toast, estados vazio, carregando e erro.
  - Usa os tokens do Tendly e segue tema claro e escuro sozinho. É o que dá aos apps um visual coerente.
- **Skill `tendly-apps` v2:** ensina o kit, a ponte, as permissões, as coleções, o recarregar sozinho e o "pedir correção". Também traz uma checagem: abrir o app pelo `curl` e conferir que não há erro no console, via um endpoint de diagnóstico do Tendly.
- **Versões do app:** cada turno de agente que mexe em `apps/<slug>/` vira uma versão do app inteiro (agrupando as versões de arquivo do histórico). O cabeçalho mostra "Versões" com a lista (o que o agente disse, quando) e **Voltar o app para esta versão**.
- **"Adicionar atalho" (F14):** nome, URL, letra e cor. O tile abre o site num painel quando ele deixa embutir; senão, numa aba nova. Fica em `hub.db` (`app_shortcuts`), não numa pasta.
- **Cards do catálogo** com a rota, "Atualizado há X" e o selo de erros. Apps quebrados aparecem com "Pedir correção".

## Etapa F: apps com servidor  ·  L  (depois que A–E estiverem em uso)

- `"server": { "command": "node server.mjs", "env": ["OPENAI_KEY"] }` no `app.json`.
- **Processo:**
  - o Tendly sobe o processo quando o app é aberto ou quando um job/webhook precisa dele, e para depois de 15 min ocioso, a não ser que o `app.json` peça `"keepAlive": true`;
  - reinicia quando os arquivos mudam (como o recarregar);
  - escuta em `127.0.0.1:<porta livre>`, com `PORT` no ambiente.
- **Proxy:** `/…/<slug>/api/*` → processo, com a autenticação do Tendly na frente. Webhook público opcional em `/hooks/<slug>/<segredo>` (para leads de fora), com o segredo gerado pelo Tendly.
- **Segredos:** os nomes ficam no `app.json` e os valores em Integrações → "Chaves". Vão cifrados em `hub.db`, como as chaves de push, e são injetados só no processo daquele app.
- **Logs:** as últimas 2.000 linhas aparecem no cabeçalho ("Servidor · rodando · logs") e o agente lê pelo MCP. Se o servidor cai, aparece "Pedir correção" com o log.
- **Jobs:** o app declara `"jobs": [{ "cron": "*/10 * * * *", "path": "/api/check" }]` e eles viram automações ligadas ao app, que aparecem em Automações.
- **Isolamento no Mac:** usuário normal, sem sandbox de sistema. Na VPS, um usuário de sistema próprio para os apps (o `deploy/` ganha isso). Fica registrado como risco: um app com servidor pode o que esse usuário pode.

## Depois (multiusuário, depois da VPS)

- Publicar app para o time ("No ar · hash") e acesso por pessoa ("Marina · admin"); selo do papel no cabeçalho.

## Ordem e tamanho

| etapa | tamanho | depende de | muda o quê no dia a dia |
|---|---|---|---|
| A rail + barra | S | — | acesso de 1 clique aos apps; a lista para de ser esmagada |
| B tela cheia + Conversar + recarregar | M | — | o loop "pedir mudança → ver mudado" sem recarregar à mão |
| C ponte + origem separada | M | B | apps conversam com a Mesa; a segurança vira a base |
| D coleções + arquivos + ao vivo | M | C | apps de verdade (CRM, kanban) sem perder dado |
| E construtor (modelos, kit, versões, atalhos) | M | C, D | criar um app bom de primeira; desfazer |
| F servidor por app | L | C, D | ações pesadas, webhooks, jobs |

Dá para o piloto automático rodar A→E em sequência, como no M3–M5, com um prompt por etapa e a mesma regra de não abrir conversas de agente na sua conta. A Etapa F eu faria com você acompanhando, por causa do risco de segurança.

## Riscos

- **Origem separada no Mac:** precisa de um segundo nome de host que resolva para 127.0.0.1. `*.localhost` resolve no Chrome e no Safari; cookie e token mudam de origem; o túnel do Tailscale (HTTPS) precisa servir os dois.
- **Recarregar sozinho no meio de uma digitação** perde o que a pessoa escreveu: o app pode pedir para esperar (`tendly.host.holdReload()`) enquanto tem algo não salvo.
- **Apps com servidor** são código rodando na sua máquina, escrito por um agente: só o seu usuário e o loopback, nada de porta aberta, e o webhook com segredo.
