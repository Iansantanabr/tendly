# AppsB — Etapa B: app em tela cheia e o loop "Conversar"

Etapa B de `replica/plan-apps.md`. Rodada sem navegador: tudo abaixo foi conferido por testes e pela API do servidor rodando; a lista do que olhar na tela está no fim.

## Feito (2026-11-06)

1. **App em tela cheia** em `/apps/<id do workspace>/<slug>` (`features/hub/AppFullPage.vue` + `AppView.vue`). O rail de ícones fica à esquerda, sozinho (sem o painel Workspaces/Conversas), com o tile do app destacado. Cabeçalho fino: tile + nome, "código em apps/<slug>/" (abre o painel de arquivos na pasta do app), Conversar, Abrir na Mesa, recarregar, copiar link, abrir fora. O app ocupa o resto.
   - Abrem a tela cheia: o cartão do catálogo (página Apps), os tiles do rail, a lista de apps da barra expandida e o cartão Apps do Início. "App em branco" também abre em tela cheia.
   - Continuam abrindo painel na Mesa: arrastar um tile, "Abrir na Mesa" (no cabeçalho e no catálogo) e "Reportar um problema".
   - O painel da Mesa usa o mesmo `AppView.vue`: ficou como era e ganhou **copiar link** (o link é o da tela cheia).
2. **Conversar em tela cheia** abre uma coluna de conversa à direita: redimensionável (arrastar a divisória, ou ← → com ela em foco), fecha com Esc ou no ×, e o botão Conversar fica marcado enquanto ela está aberta. A conversa é uma conversa comum do projeto do app, criada do mesmo jeito que o "+" da barra cria; o composer já vem com o app como chip de contexto e o cursor. **Nada é enviado sozinho.** Cada app lembra a sua conversa neste navegador; "+" na barra da coluna começa outra; "Levar para a Mesa" abre a conversa como aba.
3. **Recarregar sozinho**: quando um arquivo em `apps/<slug>/` muda (nunca `data/`), depois de 600 ms de silêncio todo painel e a tela cheia daquele app recarregam e mostram **"Atualizado agora · Desfazer"**. Desfazer volta os arquivos do app para como estavam antes daquela rajada, pelo histórico de arquivos, e a tela mostra "Mudança desfeita · Refazer".
4. **Erros do app**: o `sdk.js` avisa a página do Tendly (só ela, conferindo a origem) dos erros do app. O cabeçalho mostra "N erros", a lista, e **"Pedir correção"**, que preenche a conversa (a da coluna em tela cheia; na Mesa, a conversa do mesmo projeto aberta ao lado, ou uma nova ao lado) com o app, a tela aberta e cada erro com arquivo e linha. **Nunca envia.**
5. **`tendly.host.holdReload(true/false)`**: o app com algo não salvo pede para o Tendly esperar; o aviso vira "Tem uma versão nova pronta · Recarregar agora". Documentado na skill.
6. **Skill** atualizada no repositório (`skills/tendly-apps/SKILL.md`): recarregar sozinho, desfazer, `holdReload`, erros e "Pedir correção", tela cheia. O texto que o "Criar com o agente" manda (para agente sem a skill) ganhou uma linha sobre isso.

## Como funciona por dentro

- **Servidor** (`crates/server/src/hub/apps/live.rs`): o observador que já alimenta o histórico (`history.rs`) passa cada caminho mudado para `Live::touched`. Caminhos de um mesmo app em sequência são uma rajada; 600 ms sem mudança fecham a rajada. Ao fechar: o histórico grava as versões (com a autoria de sempre), compara o que cada arquivo continha antes (índice em memória) com o que tem agora, e o resultado é uma "mudança" com id. O aviso sai pelo socket `/api/agent-activity/ws` (o canal ao vivo que o navegador já mantém aberto), como `{type:"hub", event:"app-changed", …}`.
- **Rotas novas**: `GET /api/hub/apps/{ws}/{slug}/changes` (a mudança mais recente; também indexa o app) e `POST /api/hub/apps/{ws}/{slug}/changes/{id}/undo`.
- **Navegador**: `AgentActivity.vue` entrega cada mensagem do socket para `app-live.ts::liveMessage`; cada `AppView` escuta o seu app. Na reconexão do socket, pergunta a mudança mais recente para não perder nada.
- **SDK** (`crates/server/src/hub/apps/sdk.js`): `postMessage` só para `window.parent`, endereçado a `location.origin`, e só quando o app está numa moldura. A página confere `event.origin` e que a mensagem veio da janela daquela moldura (`app-errors.ts::readAppMessage`).

## Decisões (podem ser invertidas)

- **Clicar num tile sai da Mesa.** É o que o plano pede (F13: tile → tela cheia; arrastar → painel). No rail da Mesa isso muda o que a Etapa A fazia (clicar abria aba). Para abrir como aba: arrastar o tile, ou "Abrir na Mesa" no cabeçalho.
- **Em tela cheia a barra é sempre o rail**, mesmo com a preferência "Expandida" (a preferência é sobre a Mesa). No celular (< 761px) não há rail: a gaveta de sempre, e o topo mostra "Apps".
- **Sem botão Voltar no cabeçalho do app.** O rail leva a qualquer lugar; o cabeçalho ficou só com o que a etapa pede.
- **A conversa da coluna é criada no clique de Conversar** (uma sessão vazia, como o "+" da barra e como o Conversar do painel já faziam). Não usa `POST /api/hub/start`, que manda um prompt. Abrir a página nunca cria conversa: com a coluna lembrada como aberta e a conversa apagada, aparece "Nova conversa".
- **Em tela cheia o chip do app já vem anexado**; no painel da Mesa o Conversar ficou como era (o chip "+ App" é oferecido embaixo do composer). "Pedir correção" anexa o chip nos dois.
- **Canal ao vivo = socket `agent-activity`**, com um método novo no `activity.rs` (`hub_event`, 4 linhas). A alternativa era o socket de arquivos por workspace (`files/ws`), que só existe para workspaces com painel aberto e não sabe o "antes" de cada arquivo.
- **Quem conta a rajada é o servidor**, não cada navegador: todos os painéis recarregam juntos e o desfazer vale para o mesmo conjunto de arquivos.
- **Desfazer**: só a mudança mais recente de cada app, por até 1 hora, e some se o servidor reiniciar (o histórico por arquivo continua). Arquivo editado volta; apagado volta; **criado na rajada é removido** (o conteúdo fica no histórico); binário e arquivo > 1 MB ficam como estão e são citados; `app.json` nunca é removido. Mais de 200 caminhos numa rajada (um checkout, um gerador): recarrega, mas não oferece desfazer.
- **Desfazer o desfazer é o refazer.** O servidor marca a mudança como `undo_of` (e `redo` quando é a volta), e o aviso diz "Mudança desfeita · Refazer".
- **O aviso some em 60 s** (o de "versão nova pronta" fica até recarregar).
- **O índice dos apps grava versões no histórico** no start do servidor, no scaffold e quando uma janela mostra o app pela primeira vez (autor "Fora do Tendly", só se o conteúdo for diferente da última versão). É o que permite desfazer a primeira mudança de um arquivo que o histórico nunca tinha visto. Um app criado por fora com o servidor rodando e nunca aberto: a primeira rajada dele não tem desfazer.
- **Recarregar mantém a página do app que estava aberta** (o SDK informa o endereço; vale se continuar dentro da pasta do app). O botão recarregar faz o mesmo.
- **Erros valem por carga de página**: a lista zera quando o app recarrega. Até 50 por carga; o mesmo erro repetido conta "×n". `console.error` conta como erro (a skill explica quando usar). "Pedir correção" escreve os 5 mais recentes, cada um com até 3 linhas da pilha, sem endereço da máquina (vira `apps/<slug>/arquivo:linha`). O texto sai no idioma da interface.
- **`holdReload` é do navegador**: o servidor avisa a mudança de qualquer jeito; quem segura é a moldura. Uma carga de página nova zera o pedido.
- **Esc**: dentro do composer o primeiro Esc sai do campo (comportamento do upstream, que também interrompe a resposta em andamento); o seguinte fecha a coluna. Com o foco dentro do app (a moldura), o Esc é do app.
- **A conversa da coluna conta como "na sua frente"**: é marcada como lida e não toca o celular, como a aba em foco na Mesa.
- **Tela estreita**: abaixo de 680px de página a conversa cobre o app em vez de espremer (fechar mostra o app); o cabeçalho esconde os rótulos (ficam ícone, nome acessível e dica) e quebra as ações para a segunda linha.
- **Sem migração no `hub.db`**: o estado das mudanças é memória (`HubStore.app_live`).
- **App de teste pela API**, não por arquivo: criei `apps/zz-appsb-check/` na pasta oculta de conversas pelo scaffold, mudei pelos arquivos da API, e apaguei pela mesma API que o painel de arquivos usa (a sandbox não deixa `rm` fora do repositório). A pasta `apps/` que o teste criou ali também foi apagada. Ficaram no histórico de arquivos algumas versões desse app de teste (somem sozinhas em 60 dias).
- **Skill só no repositório**: não escrevi em `~/.claude/skills/` (fora do repositório).
- **Assinatura dos commits**: a regra do piloto pede a linha "Claude Opus 5.5"; segui a regra. Esta rodada rodou no modelo Claude Fable 5.1.

## Toques em arquivos do upstream

- `apps/web/src/App.vue`: 2 imports; `page` aceita `app`; `openAppPage`, `routeApp`, `appSideChat`, `onAppChatRequest`, `revealAppCode`, `openReferenceOnMesa`; `sidebarMode` / `railMode` / `appFocus`; `quickSession` com o parâmetro `detached` e devolvendo a sessão; `viewedSessionId` para "lida" e presença; classe `hub-app-focus`; atributos do `<IconRail>`; `@open-app-page` no `WorkspaceSidebar`; `@open-app` do `HomePage` e do `AppsPage`; a linha do `<AppFullPage>`; "Apps" como título no celular.
- `apps/web/src/router.ts`: rota `app`.
- `apps/web/src/features/AgentActivity.vue`: 1 import e 1 linha (`liveMessage(message)`).
- `apps/web/src/features/WorkspaceSidebar.vue`: emit `openAppPage`, usado pelo `<SidebarApps>`.
- `apps/web/src/styles.css`: 2 regras `.hub-app-focus`.
- `crates/server/src/activity.rs`: método `hub_event`.

## Testes

- Web: 961 ok (29 novos em `features/hub/appsB-live.test.mjs`; 3 asserções do `appsA-rail.test.mjs` atualizadas para a nova fiação). Entre os novos: o `sdk.js` de verdade rodando numa página de mentira (o que ele manda, para quem, o teto de 50, silêncio fora da moldura), a leitura das mensagens com origem e janela erradas, o texto do "Pedir correção", o composer preenchido sem `pending`, o cabeçalho desenhado (SSR) em tela cheia, painel, pt-BR e os estados de app sumido. Typecheck ok.
- Hub (Rust): 164 ok (8 novos em `hub/apps/tests.rs`: caminhos que recarregam, rajada → uma mudança, desfazer e refazer, o que não dá para voltar, enxurrada de caminhos, índice ao perguntar, o aviso chegando no canal depois dos 600 ms, o SDK só fala com a própria origem). Servidor inteiro: 594 ok, 2 ignorados.
- Servidor rodando depois do `build.sh` (28 conferências, todas ok): scaffold do app de teste; `sdk.js` novo servido; `/apps/<ws>/<slug>` serve a interface; socket `agent-activity` aberto; arquivo reescrito + arquivo criado + dado salvo → aviso `app-changed` 0,62 s depois, com os 2 arquivos e sem `data/`; desfazer sem `X-Tendly-Client` → 403; desfazer → `index.html` igual ao original, arquivo criado removido, dado intacto; aviso seguinte com `undo_of`; mudança antiga → 409; desconhecida → 404; app de teste apagado e `GET /api/hub/apps` igual a antes (vazio).
- Contraste: nenhuma cor nova (só tokens que já existiam).

## Não exercitado ao vivo

- **Nada foi visto num navegador.** Layout da tela cheia, a coluna de conversa, a divisória, o aviso sobre a moldura, a lista de erros, o foco com teclado: tudo isso só foi desenhado em SSR ou conferido no código.
- **Nenhuma conversa foi aberta** (regra do piloto): Conversar e "Pedir correção" criam uma sessão no clique, e isso não foi clicado. O que foi testado: a função que preenche o composer, e a fiação.
- **A moldura de verdade**: `postMessage` entre o app e a página, e `holdReload`, só rodaram numa página de mentira (Node).
- Recarregar com o agente editando de verdade (várias escritas com pausas): cada pausa maior que 600 ms é um recarregar; a skill pede para o agente terminar de uma vez.

## Para o Ian olhar no navegador

Antes: copie a skill (`cp ~/tendly-src/tendly/skills/tendly-apps/SKILL.md ~/.claude/skills/tendly-apps/SKILL.md`) e crie um app de teste (Apps → nome "Teste" → "App em branco").

1. **Tela cheia, janela larga (≥ 1250px), tema claro.** "App em branco" já abre em `/apps/…/teste`. Esperado: rail à esquerda com o tile "T" destacado, sem o painel Workspaces/Conversas; cabeçalho com tile, nome, "código em apps/teste/", Conversar, Abrir na Mesa e três ícones; o app embaixo ocupando tudo. Passe o mouse em cada botão (cada um tem dica).
2. **Entradas.** Vá ao Início e clique no app no cartão Apps; na página Apps clique no cartão; na Mesa clique no tile do rail: os três abrem a tela cheia. Na página Apps, "Abrir na Mesa" abre como aba. Na Mesa, arraste o tile para um painel: abre como aba.
3. **Cabeçalho.** "código em apps/teste/": o painel de arquivos abre à direita com a pasta do app aberta. Copiar link: o ícone vira ✓; cole o link em outra aba e veja abrir o mesmo app. Abrir fora: o app sozinho numa aba. Abrir na Mesa: vira aba na Mesa (e o painel ali tem os mesmos ícones, com copiar link).
4. **Conversar.** Clique em Conversar: abre a coluna à direita, o botão fica marcado, o composer já tem o chip "Teste" e o cursor. **Confira que nada foi enviado.** Arraste a divisória; com ela em foco use ← →. Esc (fora do composer) fecha e o foco volta para Conversar. Abra de novo: é a mesma conversa. "+" começa outra; o ícone de grade leva a conversa para a Mesa.
5. **Recarregar sozinho.** Com o app em tela cheia e a coluna aberta, peça: "troque o título para Olá". Quando o agente salvar, o app recarrega sozinho e aparece "Atualizado agora · Desfazer" no canto inferior esquerdo. Clique em Desfazer: o título volta e o aviso vira "Mudança desfeita · Refazer". Clique em Refazer. Abra o mesmo app também numa aba da Mesa (outra janela) e veja os dois recarregarem.
6. **Erros.** Peça ao agente: "adicione um botão que chama uma função que não existe" e clique nesse botão no app. O cabeçalho mostra "1 erro"; clique: a lista tem a mensagem e `apps/teste/index.html:linha`. "Pedir correção": o composer da coluna recebe o texto com app, tela e erro. **Confira que não enviou.** Envie você, e veja o app recarregar e o "1 erro" sumir.
7. **Erros no painel da Mesa.** Repita o 6 com o app numa aba da Mesa e nenhuma conversa aberta: "Pedir correção" abre uma conversa ao lado, preenchida. Com uma conversa do mesmo projeto já aberta, ele usa essa.
8. **holdReload.** Peça: "adicione um campo de texto que chama tendly.host.holdReload(true) ao digitar e um botão Salvar que chama holdReload(false)". Digite algo, peça outra mudança qualquer: em vez de recarregar aparece "Tem uma versão nova pronta · Recarregar agora" e o texto digitado continua lá. Clique em Salvar: recarrega.
9. **Tema escuro**: repita 1, 4 e 6 olhando o cabeçalho, o selo "N erros" (vermelho suave), os cartões da lista de erros e a pílula do aviso.
10. **Janela de 900px de largura**: tela cheia com a coluna aberta; os rótulos do cabeçalho somem (só ícones) quando o app fica com menos de 620px. **640px e 360px** (ou o celular): sem rail, o menu abre a gaveta; o cabeçalho quebra em duas linhas sem cortar nada; Conversar cobre o app com a conversa e o × volta para o app. No celular, confira que os botões do cabeçalho são fáceis de tocar.
11. **App que sumiu**: abra `/apps/<id>/nao-existe` (troque o fim do link): "Este app não está mais aqui" com "Ver todos os apps".
12. **Sidebar** (correção do bf0f3f0): no Início, janela baixa (~640px de altura): o seletor Workspaces/Conversas inteiro, as listas com pelo menos 180px, a barra rolando.

## Falta

- Nada da Etapa B. Com você: olhar no navegador (acima) e copiar a skill para `~/.claude/skills/tendly-apps/`.
- Fica para as próximas etapas, como no plano: origem separada e ponte com permissões (C), contexto com a tela do app no chip (C), coleções (D), modelos, kit e versões do app inteiro (E).
