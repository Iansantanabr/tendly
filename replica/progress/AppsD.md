# AppsD — Etapa D: dados de verdade (coleções com revisão, ao vivo, arquivos)

Etapa D de `replica/plan-apps.md`. Rodada sem navegador: tudo abaixo foi conferido por testes e pela API do servidor rodando; a lista do que olhar na tela está no fim.

## Feito (2026-11-06)

1. **Coleções.** `tendly.db.collection('leads')` com `list({ where, order, limit, offset })`, `count(where)`, `get(id)`, `insert(doc)`, `update(id, patch, { rev })` e `remove(id, { rev })`. Os registros ficam no `hub.db` (migração 11, tabela `app_records`), um por linha, cada um com um `rev` que começa em 1 e sobe 1 a cada escrita.
   - Escrever (ou remover) dizendo um `rev` velho devolve **409 com o registro como está agora**; no app isso chega como `error.code === 'conflict'` e `error.current`. Nada é gravado, então nenhuma mudança é perdida: o app refaz a sua em cima do registro atual.
   - Limites: 5 MB por registro, 50.000 registros por coleção, 100 coleções por app. Nomes de coleção e ids seguem a regra das chaves do `tendly.data` (letras, números, `_`, `-`, até 64).
   - `where` é um filtro pequeno: igualdade em campos de topo (`{ stage: 'new', hot: true }`) e `in` (`{ stage: { in: ['new', 'won'] } }`). O nome do campo e o valor entram como parâmetros de um SQL de forma fixa; não existe texto do app dentro do SQL.
2. **Ao vivo.** `collection.subscribe(fn)`: cada escrita é avisada a todas as janelas pelo socket que já existia, e cada vista daquele app repassa para a própria moldura. Dois painéis do mesmo app se atualizam sozinhos, e o que o agente escreve aparece na hora.
3. **Arquivos.** `tendly.files.upload(file)` guarda em `apps/<slug>/files/` (imagens e PDF, até 20 MB, com nome seguro); `tendly.files.url(path)` serve de `<img src>`; `list()` e `remove(path)`; e `open(path)`, que abre o arquivo na Mesa.
4. **Exportar e importar.** O cabeçalho do app ganhou o botão **"…"** com "Exportar dados…" e "Importar dados…": uma coleção em JSON (tudo) ou CSV (uma coluna por campo, para planilha). Importar adiciona ao que existe ou substitui, com confirmação na própria tela.
5. **Ferramentas do agente** no MCP do Tendly, ao lado das `tendly_automation_*`: `tendly_app_records_list`, `_get`, `_upsert` e `_delete`, um app por chamada. É o "o agente lê os leads e escreve uma resposta sugerida".
6. **Documentação.** O cabeçalho do `sdk.js` lista as chamadas novas; `skills/tendly-apps/SKILL.md` (cópia do repositório) ganhou "Where data goes" (quando usar coleção, `tendly.data` ou arquivo), "Records", "Revisions", "Live", "Files" e "Export, import and the agent's tools"; o texto que o "Criar com o agente" manda para agente sem a skill também fala de coleções, `rev` e arquivos.

## Como funciona por dentro

- **Servidor**
  - `hub/apps/records.rs`: a tabela, as operações (inserir, mudar, trocar, remover, listar com filtro, importar em transação), as rotas `…/db/…` e o aviso (`announce`).
  - `hub/apps/records/transfer.rs`: ler e escrever JSON e CSV, e as rotas `export` / `import`.
  - `hub/apps/records/tools.rs`: as quatro ferramentas MCP.
  - `hub/apps/uploads.rs`: tipo pelo conteúdo, nome seguro, a pasta `files/`, e as rotas `…/uploads`.
  - `hub/apps/live.rs`: `files/` passou a ser tratada como `data/` (não recarrega o app, não entra no índice do desfazer).
  - `agent.rs` (upstream): 3 pontos pequenos para listar e chamar as ferramentas.
- **Navegador**
  - `features/hub/app-bridge.ts`: `answerCall` ganhou `db.*` e `files.*`; `ask()` é um pedido que guarda o que o servidor disse além da mensagem (o `current` do 409).
  - `features/hub/app-live.ts`: `watchRecords` e o evento `app-records` do socket.
  - `features/hub/app-records.ts`: inscrições por moldura, `changeFor` (o que contar ao app), exportar/importar.
  - `features/hub/AppDataPanel.vue`: a faixa de exportar/importar.
  - `features/hub/AppView.vue`: repassa as mudanças, guarda as inscrições, o menu "…".
- **O caminho de uma escrita até o outro painel:** `cards.update(...)` no app → mensagem para a página → `PATCH` → o servidor grava e avisa pelo socket → cada `AppView` daquele app repassa para a moldura, se o app se inscreveu naquela coleção → o SDK chama os `subscribe`.

Rotas novas (todas em `/api/hub/apps/{ws}/{slug}/…`): `GET db`; `GET|POST|DELETE db/{coleção}`; `POST db/{coleção}/query`; `GET db/{coleção}/export`; `POST db/{coleção}/import`; `GET|PUT|PATCH|DELETE db/{coleção}/r/{id}`; `GET|POST uploads`; `DELETE uploads/{nome}`. O detalhe de cada uma está no `FORK.md` e em `replica/architecture.md`.

## Decisões (podem ser invertidas)

**Registros**

- **O registro é um envelope**: `{ id, rev, created_at, updated_at, data }`, e `data` é sempre um objeto. Assim um campo seu chamado `id` não briga com o id do registro, e `where` sempre fala dos campos de `data`.
- **`update` troca só os campos de topo citados** e mantém o resto (não é merge profundo). Um campo posto como `null` fica guardado como `null`. Para trocar o registro inteiro: `update(id, doc, { replace: true })`.
- **`rev` é opcional.** Sem ele, a última escrita vence (como no `tendly.data`). Com ele, `rev` velho dá 409 e devolve o registro atual. A skill manda usar `rev` em tudo que a pessoa edita.
- **Remover o que já não existe não é erro**: devolve `false` (com ou sem `rev`). O objetivo, "não existir", já vale.
- **Inserir com um id que já existe** dá 409 com `code: "exists"` e o registro que está lá. Sem id, o servidor cria um UUID.
- **Tipos não se misturam no filtro**: o número `100` não acha o texto `"100"`, e `true` não acha `1`. `null` acha tanto o campo `null` quanto o registro sem o campo.
- **O filtro é só isso**: igualdade e `in` (até 100 valores, até 20 campos). Sem intervalo, sem busca de texto, sem campo aninhado; o resto o app filtra na tela. Operador desconhecido é recusado com 400, em vez de ser ignorado.
- **Nome de campo no filtro**: até 64 caracteres, sem aspas, barra invertida ou caractere de controle. Aceita acento, espaço e ponto (`"e-mail"`, `"nome completo"`).
- **Ordem**: `created_at` (padrão, mais antigo primeiro), `updated_at` ou um campo; `-` na frente inverte. Um campo de dados chamado `created_at` perde para a data do registro.
- **Lista**: 1.000 por padrão, 5.000 no máximo, com `offset`. A lista traz `.total` (quantos casam). Se os dados passarem de 32 MB, a resposta é cortada e diz (`truncated`).
- **Limite estourado**: registro grande demais e coleção cheia respondem 413 com a mensagem dizendo o limite (coleção cheia traz `code: "full"`).
- **Extras fora do pedido, pequenos**: `collection.count(where)`, `tendly.db.collections()`, e a rota `DELETE …/db/{coleção}` (esvaziar; usada pela limpeza e pelos testes, **não** está no SDK, para um app com defeito não apagar tudo num laço).
- **Sem permissão nova**: coleções e arquivos são dados do próprio app, como o `tendly.data`.
- **Apagar a pasta do app não apaga os registros.** Ficam no `hub.db`; se a pasta voltar com o mesmo nome, o app os vê de novo. Preferi não apagar dado sozinho (a pasta pode estar só sendo movida ou restaurada). "Apagar app com tudo" pode entrar com o catálogo da Etapa E.
- **Migração 11** (a Apps C já tinha usado a 10).

**Ao vivo**

- **Quem escreveu também ouve a própria escrita.** O app pode desenhar tudo a partir do `subscribe`, sem tratar a própria escrita à parte (a skill mostra esse jeito).
- **O registro vai junto com o aviso** quando tem até 256 KB; maior que isso, a página lê o registro antes de repassar ao app.
- **Muita coisa de uma vez vira um `reset`** ("leia a lista de novo"): importar, esvaziar a coleção, e quando o socket cai e volta (o que foi dito no meio se perdeu).
- **A inscrição é por coleção e por carga de página.** O app que recarrega se inscreve de novo; a página só repassa as coleções pedidas.
- **Escrita recusada não gera aviso.**

**Arquivos**

- **O tipo vem do conteúdo**, não do nome nem do que o navegador diz: PNG, JPEG, GIF, WebP, AVIF e PDF. Um HTML chamado `foto.png` é recusado (415).
- **SVG e HEIC ficaram de fora.** SVG é código; HEIC só o Safari mostra (o iPhone já converte para JPEG ao escolher a foto no navegador).
- **O nome guardado é feito pelo servidor**: letras sem acento, números, `-` e `_`, com a extensão do tipo real ("Relatório de Março.PDF" vira `Relatorio-de-Marco.pdf`). **Nunca sobrescreve**: nome repetido vira `-2`, `-3`.
- **Pasta plana** `apps/<slug>/files/`, até 2.000 arquivos por app.
- **`files/` não recarrega o app** e não entra no "Desfazer" (antes, só `data/` era assim). Um app antigo que tivesse código numa pasta `files/` deixaria de recarregar sozinho ao mudar esse código; não há nenhum app assim hoje.
- **`url(path)` muda a cada carga do app** (é o endereço assinado da moldura). O app guarda o `path` e pede o endereço na hora de desenhar; a skill diz.
- **`tendly.files.open(path)`** não estava no pedido: abre o arquivo na Mesa. Entrou porque um PDF pode não aparecer dentro do sandbox do app.
- **O arquivo atravessa a ponte como bytes** (`ArrayBuffer`): até 20 MB copiados na memória do navegador. A chamada espera até 5 minutos (as outras, 30 s).

**Exportar e importar**

- **Feito no servidor** (rotas), não na página: funciona por `curl` e é testado em Rust.
- **JSON guarda tudo**; ao importar um arquivo exportado, `id` e `created_at` são mantidos e o `rev` recomeça. Uma lista simples de objetos vira registros novos.
- **CSV**: coluna `id` + uma por campo de topo, com vírgula e BOM (para o Excel ler os acentos). Lê também ponto e vírgula e tab (o Excel em português grava `;`). Lista e objeto vão como texto JSON na célula. Um campo seu chamado `id` vira a coluna `data.id`.
- **Ao ler CSV, o tipo é por coluna**: vira número só se **todas** as células forem número simples. Uma coluna de telefone ou CPF com zero à esquerda fica texto inteira. CSV é o formato prático; JSON é o fiel.
- **Importar é tudo ou nada**, e o erro diz a linha ("Record 2: …").
- **"Manter" ou "Remover antes"**: no primeiro, registro com o mesmo id é substituído e o resto entra; o segundo esvazia a coleção antes e pede confirmação na tela (nunca `window.confirm`).
- **Depois de importar**, o app que escuta a coleção recebe o `reset`; o que não escuta é recarregado (ou mostra "Tem uma versão nova pronta" se estiver segurando o recarregar).
- **O "…" é novo** no cabeçalho (não existia menu ali) e tem só esses dois itens.

**Ferramentas do agente**

- **Um app por chamada**: `app` é o nome da pasta em `apps/`. Sem `workspace_id`, vale o projeto da conversa; se o app não está lá, o único projeto que tem um app com esse nome; se houver mais de um, o erro lista os ids.
- **Não pedem confirmação na janela.** É dado do app, que o agente já alcançaria editando o app. `delete` não tem volta e a descrição da ferramenta diz.
- **A lista é cortada para caber num modelo**: 50 por padrão, 200 no máximo, e 256 KB de dados por resposta, com `next_offset`.
- **Conflito volta com o registro atual no texto**, para o agente decidir e repetir.
- **Sem `collection`, `tendly_app_records_list` lista as coleções do app**: é como o agente descobre o que existe.

**Outras**

- **Testes antigos ajustados**: dois testes da Apps B conferiam a lista exata de botões do cabeçalho (ganhou "More") e um conferia a linha do reconectar (ganhou `resyncRecords()`); um teste Rust limitava o `sdk.js` a 340 linhas (agora 480; ele tem 458).
- **Skill só no repositório**: não escrevi em `~/.claude/skills/` (fora do repositório).
- **Assinatura dos commits**: a regra do piloto pede a linha "Claude Opus 5.5"; segui a regra. Esta rodada rodou no modelo Claude Fable 5.1.

## Limites conhecidos

- **Não há teto total por app**: o limite é por registro (5 MB) e por coleção (50.000). Um app com defeito gravando registros grandes num laço pode encher o disco. Também não há limite de frequência de escrita na ponte.
- **`hub.db` passa a guardar os dados dos apps** e cresce com eles. O backup (`deploy/backup.sh`) já copia o `hub.db`; os arquivos enviados ficam na pasta do projeto.
- **Os registros não entram no histórico de arquivos** nem no "Desfazer" do app. Exportar em JSON é o backup.
- **O filtro não tem índice por campo**: cada consulta com `where` lê a coleção inteira no SQLite. Com 50.000 registros pequenos isso é rápido; com registros de megabytes, fica lento.
- **Duas vistas do mesmo app não trocam a inscrição**: cada moldura tem a sua (é o esperado).
- **CSV perde tipo**: o texto `"123"` exportado volta como o número `123` se a coluna toda for numérica.
- **Um aviso perdido** (socket caiu) é coberto pelo `reset` na volta, mas só para o app que trata `reset` (a skill manda tratar).

## Arquivos do upstream tocados

- `crates/server/src/agent.rs`: uma linha no `INSTRUCTIONS`; `tools.extend(crate::hub::app_record_tools());`; um braço no `match` do `call_tool`.

Nada mais: o aviso ao vivo usa o `hub_event` da Apps B, e o limite de tamanho do corpo é por rota.

## Testes

- **Hub (Rust): 195 ok** (14 novos). Servidor inteiro: 625 ok, 2 ignorados. Os novos, pelo roteador de verdade com o guard:
  - ida e volta de um registro, cada escrita uma revisão, coleção de um app invisível para outro;
  - **conflito com `rev` velho**: dois painéis na revisão 1, o segundo recebe 409 com o registro atual, refaz e as duas mudanças ficam; o mesmo para trocar e para remover;
  - **filtro**: igualdade, `in`, tipos, `null`, ordem, página; texto que seria SQL (em valor e em nome de campo) só é comparado e não acha nada; operador desconhecido dá 400;
  - **limites**: exatamente 5 MB cabe e 1 byte a mais não; a 50.001ª inserção e a 101ª coleção são recusadas; importação que estouraria não grava nada;
  - **dois ouvintes** recebem cada escrita, na ordem, com o registro; a recusada não gera aviso; registro grande vai sem os dados; importar e esvaziar viram `reset`;
  - JSON e CSV: exportar, importar em outra coleção, de novo (substitui em vez de dobrar), substituir; aspas, quebra de linha, `;` e tab; tipo por coluna; arquivo ruim diz a linha e não grava;
  - **envio de arquivos**: `../../app.json` vira `files/app.png`; nome repetido não sobrescreve; HTML, SVG e script chamados `.png`/`.pdf` são recusados; 20 MB cabe e 1 byte a mais não; a moldura não envia nem remove sozinha; link simbólico em `files` para fora dá 409 e nada é escrito lá; remover só aceita nome simples;
  - **ferramentas MCP**: listadas com `app` obrigatório; ler, escrever a resposta sugerida com `merge` (o app aberto é avisado), conflito com o registro atual no texto, criar, apagar, um app por chamada, app de mesmo nome em dois projetos, lista longa cortada com `next_offset`;
  - migração 10 → 11 preservando o que havia.
- **Web: 1.003 ok** (18 novos em `features/hub/appsD-data.test.mjs`; 3 da `appsB-live.test.mjs` ajustados). Typecheck ok. Entre os novos:
  - o `sdk.js` de verdade numa página de mentira com origem `"null"`: cada chamada de coleção e de arquivo vira mensagem, o conflito chega com `error.current`, nome ruim nunca sai da página, nenhum `fetch`;
  - a ponte com um `fetch` de mentira: só rotas do próprio app, nome nunca vira caminho, bytes vão como bytes, limite de 20 MB antes de pedir;
  - **dois painéis do mesmo quadro movendo o mesmo cartão**: dois SDKs de verdade, as funções que o `AppView` usa e um servidor em memória com a regra do `rev`; cada um vê a escrita do outro, o conflito devolve o registro atual e a nota e o movimento ficam os dois;
  - a faixa de exportar/importar desenhada (SSR) em inglês e pt-BR; o menu "…" e a fiação do `AppView`;
  - traduções com os mesmos marcadores; tokens, borda `--line-input`, 44px no toque, sem `window.confirm`.
- **Servidor rodando depois do `build.sh`: 63 conferências, todas ok**, com um app de teste (`apps/zz-appsd-check/`) criado, usado e apagado pela própria API na pasta oculta de conversas. Duas conexões no socket `/api/agent-activity/ws` ouviram cada escrita (inclusive a da ferramenta MCP). Depois: lista de apps vazia como antes, 0 linhas em `app_records`, pasta `apps/` removida. `hub.db` migrou de 10 para 11 sozinho no restart.
- **Contraste**: nenhuma cor nova (não rodei o `contrast.py`; os tokens não mudaram).

## Não exercitado ao vivo

- **Nada foi visto num navegador.** O que mais depende dele:
  - o arquivo atravessando a ponte de verdade (`File` → `ArrayBuffer` → `postMessage` de uma moldura sem origem);
  - `<img src>` com o endereço de `tendly.files.url` dentro do sandbox (no servidor a resposta sai certa: tipo, CSP, CORS);
  - **PDF dentro do app**: é provável que o navegador não mostre um PDF embutido num sandbox; por isso existe `tendly.files.open(path)`, que abre na Mesa;
  - o download do exportar (um `<a download>` criado pela página);
  - o menu "…" (posição, clique fora, teclado) e a faixa em 360px.
- **Nenhuma conversa foi aberta** (regra do piloto): as ferramentas MCP foram chamadas direto na rota `/api/agent/call`, não por um agente.
- **Safari e o app instalado no celular** não foram testados.

## Para o Ian olhar no navegador

Antes de tudo: **recarregue as abas do Tendly que já estavam abertas** (a página antiga não conhece as chamadas novas e o app fica esperando 30 s) e copie a skill:
`cp ~/tendly-src/tendly/skills/tendly-apps/SKILL.md ~/.claude/skills/tendly-apps/SKILL.md`

1. **O que já existia continua** (janela larga, tema claro). Apps → crie um "App em branco": contador e nota funcionam e voltam depois de recarregar a página. No cabeçalho há um botão novo, **"…"**, depois do "abrir fora".
2. **Crie o app de teste.** Clique em Conversar e peça ao agente:
   > Crie um app "Quadro" em apps/quadro. Um kanban com as colunas A fazer, Fazendo e Feito, guardado na coleção tendly.db.collection('cards') (campos title, column, note, photo). Botão para criar cartão; arrastar entre colunas com update(id, { column }, { rev }); em conflito (error.code === 'conflict') refaça em cima de error.current e mostre um aviso "outra pessoa mudou este cartão". Desenhe a partir de cards.subscribe (trate 'reset' lendo a lista de novo). Em cada cartão: editar a nota, "Subir foto" com tendly.files.upload (guarde o path em photo e mostre com tendly.files.url), "Abrir" com tendly.files.open quando for PDF, e Remover. Mostre na tela o erro de qualquer chamada.
3. **Dois painéis do mesmo app.** Abra o Quadro na Mesa ("Abrir na Mesa") duas vezes, lado a lado. Crie um cartão num painel: ele aparece no outro sem recarregar. Arraste num: move no outro. Edite a nota num: muda no outro.
4. **Conflito.** Arraste o mesmo cartão nos dois painéis quase ao mesmo tempo (ou edite a nota num enquanto arrasta no outro): nenhum dos dois perde o que fez, e o que chegou depois mostra o aviso.
5. **O agente escreve nos dados.** Numa conversa do mesmo projeto, peça: "liste os cartões do app quadro e escreva em note do primeiro: 'revisado pelo agente'". O cartão muda no app aberto, sem recarregar. (Isso usa as ferramentas `tendly_app_records_*`.)
6. **Foto.** "Subir foto" com um JPG ou PNG: a miniatura aparece. Recarregue a página: continua lá. No painel de arquivos do projeto, `apps/quadro/files/` tem o arquivo com um nome limpo. Subir a mesma foto de novo cria `…-2`. **O app não recarrega ao subir.**
7. **O que é recusado.** Tente subir um `.txt` ou um `.zip`: o app mostra "Only images … and PDF files can be uploaded". Um arquivo com mais de 20 MB: "at most 20 MB".
8. **PDF.** Suba um PDF e clique "Abrir": ele abre na Mesa. (Se você pedir ao agente para mostrar o PDF dentro do app e não aparecer, é o sandbox: me avise se quiser que eu procure outro jeito.)
9. **Exportar.** "…" → "Exportar dados…": aparece a faixa acima do app com a coleção `cards · N registros`. Exporte em JSON (baixa `quadro-cards.json`) e em CSV (abra no Numbers ou no Excel: uma coluna por campo, acentos certos).
10. **Importar.** Mude um título no CSV, salve, e "…" → "Importar dados…" → escolha o arquivo → a coleção `cards` já vem preenchida → "Manter" → Importar: "N registros atualizados" e o quadro mostra o título novo sem recarregar. Depois escolha "Remover antes": aparece a faixa vermelha pedindo confirmação, com Cancelar e "Remover e importar".
11. **Teclado no menu.** Tab até o "…", Enter abre, ↓ ↑ andam, Enter escolhe, Esc fecha e o foco volta ao "…". Na faixa, Esc fecha.
12. **Tela cheia e painel.** Repita 9 no app em tela cheia e num painel estreito da Mesa (~360px): a faixa cabe sem rolagem lateral, os botões quebram de linha, o menu não sai da tela.
13. **Tema escuro**: o menu "…", a faixa de exportar/importar (as duas opções em cartão, a marcada mais clara) e a faixa vermelha de confirmação.
14. **Celular** (pelo endereço do Tailscale): "…" e os botões da faixa fáceis de tocar; subir uma foto da câmera funciona (o iPhone converte para JPEG).
15. **Sidebar** (correção do bf0f3f0): no Início, janela baixa (~640px de altura): seletor Workspaces/Conversas inteiro, listas com pelo menos 180px, a barra rolando.

## Falta

- Nada da Etapa D. Com você: olhar no navegador (acima), recarregar as abas abertas e copiar a skill.
- Fica para as próximas etapas, como no plano: modelos, kit de UI, versões do app inteiro, atalhos e os cards do catálogo (E); apps com servidor (F). Ideias que apareceram aqui e cabem na E: "apagar o app com os dados", um teto total de dados por app, e o modelo Kanban já usando coleção e `subscribe`.
