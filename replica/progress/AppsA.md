# AppsA — Etapa A: barra lateral e rail de ícones

Etapa A de `replica/plan-apps.md`. Rodada sem navegador: tudo abaixo foi conferido por testes e por `curl` no servidor rodando; a lista do que olhar na tela está no fim.

## Feito (2026-11-06)

1. **Rail de ícones na Mesa** (`features/hub/IconRail.vue`, `features/hub/rail.ts`). Em `/mesa`, com a janela em largura de computador (≥ 761px) e a preferência em "ícones", a navegação global vira uma coluna de 56px: Início, Mesa, Habilidades, Integrações, Automações; divisória; ícone de Apps (catálogo); um tile por app (nome ao lado no hover/foco, app em foco destacado, bolinha nos que têm aba aberta), rolando sozinhos quando são muitos; embaixo: sino com o número de não lidas, Reportar um problema, Mais, Configurações.
2. **Painel Workspaces/Conversas ao lado**, em coluna própria (`WorkspaceSidebar` com `compact`): sem o menu global, sem a seção de apps e sem o rodapé de reportar; só o seletor Workspaces/Conversas e as listas. Controle próprio de recolher: a alça redonda "‹ / ›" na borda do painel (fica na borda do rail quando o painel está recolhido). O botão do topo e o atalho de sempre continuam valendo e mexem no mesmo estado.
3. **Barra expandida** (Início, páginas, gaveta do celular): a seção de apps virou `features/hub/SidebarApps.vue`: "Apps ›" (catálogo), "+" (vai para a página Apps com o cursor no formulário de criar), lista vertical de até 8 apps (tile + nome, "…" em cada linha) e "Ver todos". Os chips em grade saíram.
4. **Preferência "Barra lateral na Mesa: Ícones | Expandida"**, padrão ícones, em `hub_settings` (`mesa_sidebar`), validada no servidor. Fica em Configurações → Endereços e fuso horário (cartão novo no fim). Atalhos: no rail, Mais → "Mostrar a barra completa aqui"; na barra expandida, na Mesa, o rodapé ganhou "Mostrar só ícones aqui".
5. **Arrastar um tile para a Mesa** abre o app como painel: o tile (no rail e na lista da barra) carrega o mesmo `application/tendly-pane` que uma conversa arrastada da lista, com `appPane(app)`. Nada novo no Canvas.
6. **Ordem dos apps** (`features/hub/app-order.ts`, `AppOrderMenu.vue`): Fixar no topo / Desafixar, Mover para cima, Mover para baixo, Ocultar / Mostrar de novo. Guardado em `hub_settings` (`app_order` = `{pinned, order, hidden}`, cada entrada `<id do workspace>/<slug>`). Vale no rail, na lista da barra, no cartão Apps do Início e na página Apps (que mostra os ocultos no fim, com o selo "Oculto").
7. **Teclado**: o rail é uma parada de Tab; ↑/↓ andam pelos itens (dão a volta), Home/End vão às pontas, Enter abre; → (ou a tecla de menu, ou Shift+F10) num app abre as opções; Esc, ← e Tab fecham o menu e devolvem o foco. Todo ícone tem `aria-label`.

## Decisões (podem ser invertidas)

- **Chaves em `hub_settings`, sem migração.** `mesa_sidebar` e `app_order` são linhas da tabela da migração 7; um banco antigo responde os padrões. Há um teste para isso no lugar do "teste de upgrade".
- **`app_order` é um objeto JSON**, não texto: o `PUT /api/hub/settings` aceita `{"app_order": {"pinned": [...], "order": [...], "hidden": [...]}}`. Regras do servidor: cada entrada é `<id>/<slug>` válido; até 500 por lista; repetido conta uma vez; **ocultar ganha de fixar** (um app oculto sai dos fixados); campo desconhecido → 400 e nada muda.
- **O que "Fixar" quer dizer:** o app vai para o começo (no rail, na barra e no Início), na ordem em que foi fixado. Por isso o rótulo é "Fixar no topo" e não "Fixar no rail": é o mesmo arranjo nos três lugares.
- **Mover** troca o app com o vizinho dentro do grupo dele (fixados entre si, o resto entre si). O primeiro "mover" escreve a ordem inteira como está na tela; daí em diante um app mexido pelo agente não pula de lugar e um app novo entra no fim. Sem nada arranjado continua como era: o mais recente primeiro.
- **"…" no rail é menu de contexto** (botão direito, → ou tecla de menu), porque não cabe um botão "…" num tile de 40px. Na barra expandida e na página Apps é um botão "…" visível.
- **Mais** no rail leva a Todas as sessões, Uso e Sistema, que a barra expandida lista e o plano não pôs no rail. Sem isso essas três páginas ficariam sem entrada na Mesa.
- **Ícones do rail = os da barra expandida** (Mesa = grade de 4, Apps = grade com "+"), para o que se aprende com nome no Início valer na Mesa.
- **A preferência só troca depois de salva** (sem troca otimista): rail e barra expandida são componentes diferentes, e desfazer a troca perderia a mensagem de erro. A última escolha vista fica em `localStorage` (`tendly.hub.mesa-sidebar`) só para a Mesa não abrir de um jeito e virar para o outro enquanto o servidor responde.
- **O cartão da preferência ficou em "Endereços e fuso horário"** para não criar outra seção nas Configurações (seria mais um toque em `router.ts` e `SettingsPage.vue`).
- **Dica com o nome** (ao lado do ícone) e menus do rail são desenhados no `body` (`Teleport`), porque a área dos tiles rola e cortaria o que saísse para o lado.
- **O rail só existe na Mesa.** Nas outras páginas a barra expandida fica, como pede o plano; o app em tela cheia com rail é da Etapa B.
- **Sem app de teste em disco.** A sandbox desta rodada não deixa apagar arquivo fora do repositório, então não criei `~/.tendly/conversations/apps/<teste>/`. A ordem foi testada com apps de mentira nos testes web e com chaves de mentira pela API (apagadas no fim: `app_order` voltou a `{}` e `mesa_sidebar` a `icons`).

## Toques em arquivos do upstream

- `apps/web/src/App.vue`: 3 imports; `railMode` e `railGo`; `void loadHubSettings()` no bootstrap; classe `hub-rail-on`; `<IconRail v-if="railMode" …/>` antes do `<aside>`; `:compact="railMode"` no `WorkspaceSidebar`.
- `apps/web/src/features/WorkspaceSidebar.vue`: import de `SidebarApps` no lugar de `AppTile`/`apps`; prop `compact`; `v-if="!compact"` no menu global e no `ReportProblem` (que ganhou `:on-mesa`); a seção de chips trocada por `<SidebarApps …/>`; saíram as 6 regras CSS `.sidebar-app*`. As regras do bf0f3f0 (seletor que não encolhe, listas ≥ 180px, barra que rola) ficaram e têm teste.
- `apps/web/src/styles.css`: um bloco de 5 regras `.hub-rail-on …` (a grade ganha a coluna do rail).

## Testes

- Web: 932 ok (26 novos em `features/hub/appsA-rail.test.mjs`: ordem dos apps, regras do rail, o que o rail/lista/menu/cartão desenham via SSR, fiação, traduções, regras de design). Typecheck ok.
- Hub (Rust): 156 ok (3 novos em `hub/settings.rs`: validação das duas chaves, API, banco de antes da etapa). Servidor inteiro: 586 ok, 2 ignorados.
- Contraste: 36 pares, 0 falhas AA nos dois temas (não mexi em cores; o rail usa só tokens que já existiam).
- Servidor rodando depois do `build.sh`: `GET /api/hub/settings` traz `mesa_sidebar` e `app_order`; `PUT` com fixado+oculto devolve o app só em `hidden`; entrada `../../etc/passwd` → 400 sem mudar nada; sem `X-Tendly-Client` → 403; o JS e o CSS servidos contêm o rail.

## Não exercitado ao vivo

- Nada foi visto num navegador: posição do rail, da alça do painel, das dicas e dos menus; arrastar de verdade; foco e setas com teclado real.
- `GET /api/hub/apps` está vazio (você não tem apps hoje), então o rail aparece só com o ícone de Apps até existir um app.

## Para o Ian olhar no navegador

1. **Mesa, janela larga (≥ 1250px), tema claro.** Abra `/mesa`. Esperado: coluna estreita de ícones à esquerda, o painel Workspaces/Conversas ao lado, sem o menu Início…Apps em cima da lista. Passe o mouse em cada ícone: o nome aparece à direita. Clique em cada um (Início, Habilidades, Integrações, Automações, Apps, sino, Configurações) e volte para a Mesa.
2. **Alça do painel.** No meio da borda direita do painel há um círculo com "‹". Clique: o painel some e o rail fica; o círculo passa para a borda do rail com "›". Clique de novo. Confira que arrastar a borda do painel para redimensionar continua funcionando acima e abaixo do círculo.
3. **Apps no rail.** Crie um app (Apps → "App em branco") e volte à Mesa: o tile aparece. Clique: abre como aba e o tile fica destacado com a barrinha à esquerda. Feche a aba e **arraste o tile** para a metade direita de um painel: deve abrir dividido ali.
4. **Opções do app.** Botão direito no tile → Fixar no topo, Mover para cima/baixo, Ocultar. Com dois apps, mova e veja a ordem mudar no rail; vá ao Início e confira a mesma ordem no cartão Apps e na lista da barra. Oculte um: some do rail/barra/Início e aparece na página Apps com o selo "Oculto"; "…" → "Mostrar de novo".
5. **Teclado.** Na Mesa, Tab até o rail (uma parada), ↑/↓ entre os ícones, Enter abre; num tile de app, → abre as opções, ↑/↓ dentro, Esc volta para o tile. O anel de foco deve aparecer por dentro do ícone.
6. **Preferência.** Rail → "…" (Mais) → "Mostrar a barra completa aqui": a Mesa passa a mostrar a barra expandida. No pé da barra, "Mostrar só ícones aqui" volta. O mesmo em Configurações → Endereços e fuso horário → "Barra lateral na Mesa".
7. **Barra expandida no Início**, janela de 900px de altura e depois uma janela baixa (~640px de altura): "Apps ›", "+", lista de apps, "Ver todos"; o seletor Workspaces/Conversas inteiro e a lista com pelo menos 180px; a barra rola.
8. **Janela de 900px de largura** na Mesa: rail + painel + Mesa cabem; recolha o painel se quiser mais espaço. **640px e 360px de largura**: sem rail; a gaveta do celular abre como antes, agora com a lista de apps no lugar dos chips.
9. **Tema escuro**: repita 1, 3 e 4 olhando contraste do ícone atual, do selo do sino, da dica (fundo escuro invertido) e do menu.
10. **Sino**: com uma notificação não lida, o número aparece no canto do sino do rail.

## Falta

- Nada da Etapa A. O que ficou para as próximas etapas: rail no app em tela cheia (B), "Criar com o agente" a partir do "+" do rail (E), atalhos como tiles (E).
