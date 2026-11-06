# Componentes do fork

Sistema = tokens do Tendly (`apps/web/src/styles.css`) + estas regras. Papéis e valores estão em `tokens.json` / `tokens.dark.json`; o contraste é conferido com `python3 contrast.py tokens.json` (36 pares, 0 falhas AA nos dois temas).
Ícones: os traços do `features/Icon.vue` (no estilo Lucide). Fontes: Instrument Sans e JetBrains Mono (OFL, embutidas). Nada de logo, ícone, cor de marca ou texto da Ratoeira.

**Regras que valem para todos**
- **Foco:** o anel global de `styles.css:516` (`2px solid var(--focus)`, offset 2px) nunca é desligado. Um campo dentro de um invólucro sem borda própria passa o anel para o invólucro (`:focus-within` ou `:has(input:focus-visible)`).
- **Alvos de toque:** 44px com `pointer:coarse`. Fonte de campo `--input-text` (16px no mínimo, para o iOS não dar zoom).
- **Movimento:** `--duration-*` + `--ease-out`; `prefers-reduced-motion` zera tudo (`styles.css:717`).
- **Texto:** em inglês no código, via `t()`, com pt-BR em `i18n/pt-BR.json` (indentação de 1 espaço).
- **Confirmações:** na própria tela (o primeiro clique arma, o segundo confirma), nunca `window.confirm`.
- **Pesos de texto:** `--muted` para texto secundário (4.5:1). `--faint` só para ícones, contadores grandes, placeholder e desabilitado (3:1), nunca para frase que precise ser lida.
- **Bordas:** `--line-input` em bordas de campo (3:1); `--line` e `--line-strong` só em divisórias e cartões.

---

```
Botão
  variantes  .primary-button, .secondary-button, .small-button (+ .primary / .danger), .icon-button, .link-button
  tamanhos   small 28px, padrão 34–36px, 44px em toque
  estados    default, hover (--accent-hover / --fill-hover), active, focus-visible (anel global), disabled (.6 + not-allowed), ocupado (rótulo vira "Salvando…" e o botão fica disabled)
  tokens     primário bg --accent / texto --on-accent (contraste ok); perigo --danger-ink sobre --danger-soft; raio --radius-sm
  a11y       <button type="button"> sempre que não for submit; ícone sozinho leva aria-label e title; aria-pressed em botões de alternar
  usado em   todas as telas
```

```
Composer
  variantes  Início ("O que a gente faz agora?"), nova conversa, resposta (ChatSessionPane do upstream)
  partes     textarea, chips de contexto, seletores (agente, pasta; M1: conta, modelo, esforço, permissão), anexo, ditado (M2), enviar
  estados    vazio (enviar desabilitado), digitando, enviando, erro (inline-error abaixo), conta obrigatória (aviso com link para Preferências)
  tokens     cartão --elevated, borda --line-input, raio --radius-lg, anel no :focus-within
  teclado    Enter envia, Shift+Enter quebra linha, Esc sai do foco
  a11y       textarea com aria-label; seletores são <select> nativos com rótulo; o ditado anuncia "gravando" em aria-live
  usado em   S01, S05
```

```
Seletor (chip com menu)
  variantes  <select> nativo dentro de .home-chip (Início); ModelPicker/ModelSelection do upstream (conversa)
  estados    fechado, aberto, desabilitado, carregando (lista vazia + "Carregando…")
  extra M1   cada conta mostra o uso de 5h e da semana (QuotaMeter do AccountsDialog, em versão compacta)
  a11y       nativo onde der, para o teclado e o leitor funcionarem
  usado em   S01, S05
```

```
Chip de contexto
  variantes  arquivo ("+ nome"), app ("+ nome do app", caminho apps/<slug>/), conversa (M2, link colado)
  estados    sugerido (contorno tracejado --line-input), adicionado (preenchido --fill), removível (× com aria-label)
  tokens     raio --radius-full, texto --text-xs
  a11y       <button>; adicionar e remover anunciam a mudança
  usado em   S05
```

```
Item de conversa (barra Conversas e Início)
  variantes  não lida (bolinha --accent + negrito), esperando você (selo --warn-ink/--warn-soft; M1: botão "Responder"), rodando (indicador animado), rotina (M1, ícone timer), sua
  estados    hover --fill-hover, selecionada (.current), foco
  conteúdo   título, agente · pasta, tempo relativo (shortAgo)
  a11y       linha inteira é um <button>; o estado vai no texto, não só na cor ("não lida", "esperando")
  usado em   S01, S04
```

```
Card de seção do Início
  variantes  lista (Rodando agora, Arquivos, Últimas conversas), tiles (Apps), ação (M1: "Continuar …")
  estados    vazio (frase curta + uma ação), cheio, carregando (esqueleto com --fill)
  tokens     --elevated, borda --line, raio --radius-lg, --shadow-sm
  usado em   S01
```

```
Painel com abas (Mesa)
  upstream   Canvas.vue / LayoutNode; tipos agent_chat, editor, terminal, git_diff, file_preview, app
  estados    ativo, arrastando (alvo de encaixe), dividido, maximizado, conflito de layout (faixa com "Carregar layout do servidor")
  M2         espaço nomeado: nome na barra da Mesa, menu para salvar, renomear e abrir
  a11y       role=tab / tablist do upstream; atalhos do upstream
  usado em   S02
```

```
Cabeçalho de arquivo
  botões     baixar, histórico (relógio), publicar (globo), recarregar, salvar; markdown: Renderizado/Original
  estados    sujo (●), salvando, conflito (faixa de confirmação)
  a11y       ícones com aria-label; aria-pressed nos botões que abrem painel
  usado em   S07
```

```
Painel de histórico
  partes     lista de versões (autor: Você / Agente · conversa / Fora do Tendly; tempo; tamanho) + detalhe (legenda, diff GitDiffLines, Ver esta versão, Restaurar)
  estados    vazio ("Ainda não há versões…"), carregando, versão escolhida, rascunho sujo (Restaurar pede segundo clique), restaurando, erro
  M1         o autor "Agente" vira link que abre a conversa
  M5         mensagem curta por versão de agente: na linha (uma linha, reticências, texto todo no title, --muted) e no detalhe ("O agente disse …")
  a11y       lista com aria-current na versão escolhida; o diff tem texto +/− além da cor
  usado em   S08
```

```
Painel de publicar
  partes     link (campo só leitura + Copiar + Abrir), Quem vê (rádio), senha, Quando atualiza (rádio), nome do link, Atualizar agora, Despublicar, Salvar/Publicar, dica de rede, lista "Todos os arquivos publicados"
  estados    não publicado, publicado, sujo, ocupado, confirmando despublicação, erro
  M1         "Gerar" senha (12 caracteres de crypto.getRandomValues, mostrada uma vez); "Pedir pro agente" (abre conversa com o caminho e o objetivo)
  regra      grupos de rádio com nome único por painel
  a11y       fieldset + legend em cada grupo; senha com autocomplete=new-password
  usado em   S09
```

```
Linha de automação
  variantes  script, agente
  partes     ícone do tipo, nome, descrição, frequência + cron + "próxima: …", projeto, selo de resultado, interruptor, Rodar agora, Histórico, Editar no chat, Editar, Excluir
  estados    ligada, desligada, rodando (atualiza a cada 3 s), deu certo, falhou, não rodou ainda, confirmando exclusão
  a11y       interruptor = <button role="switch" aria-checked>; selo com texto, não só cor
  usado em   S11
```

```
Selo de status (pílula)
  variantes  ok (--success-ink/--success-soft), atenção (--warning-ink/--warning-soft), erro (--danger-ink/--danger-soft), neutro (--text-muted/--fill)
  tokens     raio --radius-full, --text-xs, peso 600
  regra      sempre com palavra ("Conectado", "Precisa autorizar"); a cor só reforça
  usado em   S11, S12, S13
```

```
Card de habilidade e de integração
  partes     nome (mono na habilidade), origem, descrição em 2 linhas, ações
  M1         habilidade: Usar no chat, Ver (SKILL.md em painel), filtro por pasta; integração: "Autorizar no claude.ai ↗" abre em nova aba com rel=noopener
  estados    vazio por grupo, carregando ("Verificando…" com o tempo da última checagem), erro inline
  usado em   S12, S13
```

```
Tile de app
  variantes  8 cores (--app-<cor> sobre --app-<cor>-soft, 4.5:1 nos dois temas), tamanhos 20 / 28 / 40px
  conteúdo   1–2 letras, peso 700
  a11y       decorativo (aria-hidden); o nome do app vai em texto ao lado ou no aria-label do botão
  usado em   barra lateral, S01, S14, aba da Mesa
```

```
Cabeçalho de app
  partes     tile, nome, caminho do código (mono, --text-muted), Chat, Recarregar, Abrir em nova aba
  estados    carregando (sobreposição), erro com "Tentar de novo", app sumiu ("Remover aba")
  regra      iframe com sandbox (scripts, same-origin, forms, modals, downloads, popups); o app precisa funcionar em 360px
  usado em   S15
```

```
Contador (badge)
  variantes  .count-badge (total, --faint), .unread-badge (não lidas, --accent)
  a11y       o número vem junto de texto acessível ("3 não lidas")
  usado em   barra lateral, S04
```

```
Interruptor
  estados    on (--accent), off (--line-input), foco (anel), desabilitado
  a11y       role=switch, aria-checked, Espaço/Enter alternam
  usado em   S11, M3 (receber notificações neste aparelho)
```

```
Aviso inline
  variantes  .inline-notice (informação), .inline-error (erro, role=alert)
  usado em   todas as páginas do hub
```

```
Página do hub
  base       PageShell do upstream: voltar (Esc), título, subtítulo, ações à direita, fundo opaco com animação de entrada
  largura    760–820px de conteúdo; em painel estreito empilha
  usado em   S10–S14, Configurações
```

### Novos nos próximos marcos

```
Botão de ditado (M2)
  estados    parado, ouvindo (anel pulsando, desliga com reduced-motion), sem suporte (some), desligado nas Configurações (some; M4), negado (dica para liberar o microfone)
  regra      a primeira vez avisa que o áudio passa pelo serviço do navegador
  a11y       aria-pressed; o texto reconhecido entra no textarea e pode ser editado antes de enviar
```

```
Espaços da Mesa (M2)
  partes     nome do espaço ativo, menu: Salvar como…, Renomear, Abrir outro, Excluir (confirmação na tela)
  estados    sem espaço (Mesa livre), espaço aberto, alterado desde que foi salvo (●)
```

```
Aparelho para notificações (M3, feito: Configurações → Notificações, `NotificationsPanel.vue` + `PushDeviceList.vue`)
  partes     "Receber notificações neste aparelho" (interruptor), lista de aparelhos com Remover (dois cliques, na tela), "Enviar teste"
  estados    sem HTTPS (explica e aponta o Tailscale, botão para Acesso remoto), iPhone fora da Tela de Início ("adicione primeiro"),
             navegador sem push, permissão negada, desligado, inscrito (selo "Este aparelho"), ocupado, falhou (erro na tela)
  aparelho   nome curto (iPhone, Android · Chrome), serviço (Google, Apple, Mozilla), adicionado em, última entrega, tentativas falhas seguidas
  tokens     cartão --surface / borda --line / raio --radius-lg; interruptor --line-input → --accent; selo --ok-ink sobre --ok-soft; aviso .inline-notice
  a11y       <input type=checkbox role=switch> dentro do <label>; resultado do teste em role=status; erros em role=alert; 44px em toque
```

```
Endereços e fuso horário (M4, feito: Configurações → Endereços e fuso horário, `AddressesPanel.vue`)
  partes     três cartões: Fuso horário (busca + lista de fusos, "Lá agora é …", Salvar), Endereço dos links publicados (campo + exemplo de link + Salvar), Ditado (interruptor)
  fuso       <input type=search> filtra um <select size=7> nativo; cada opção mostra "America / Sao Paulo (UTC−03:00)"; a busca ignora acento, maiúsculas e "_";
             o fuso escolhido nunca some da lista; avisa quando o relógio da máquina está em outro fuso (VPS em UTC)
  endereço   só https e só o domínio; o erro aparece enquanto digita (role=alert, aria-invalid) e o botão fica desabilitado; vazio = endereço do próprio Tendly
  estados    carregando (tudo desabilitado), limpo (Salvar desabilitado), alterado, salvando, salvo ("Salvo. …" some em 2,5 s), erro do servidor na tela
  regra      cada cartão salva só o seu campo; o interruptor do ditado vale na hora e volta ao estado real se falhar
  tokens     cartão --surface / borda --line / raio --radius-lg; campos com borda --line-input e fonte --input-text; "salvo" em --ok-ink
  a11y       <label> em todo campo; resultado da busca em role=status; interruptor = <input type=checkbox role=switch>; 44px em toque
```

```
Dica "Instalar o app" (M3, `InstallHint.vue`)
  onde       Início (dispensável, "Agora não" fica guardado no aparelho) e Configurações → Notificações (fixa)
  variantes  botão "Instalar" (Chrome no Android, usa o diálogo do navegador), passos do iPhone (Compartilhar → Adicionar à Tela de Início), menu do navegador
  regra      só em tela de toque e fora do app instalado; no Android só com HTTPS
  tokens     --elevated, borda --line, raio --radius-lg, ícone --accent-ink sobre --accent-soft
```

```
Página "Sem conexão" (M3, dentro do service worker)
  quando     o aparelho pede uma página e o servidor não responde; nada é servido do cache para fingir que funciona
  partes     título, uma frase (internet, Tailscale, servidor ligado), "Tentar de novo"
  regra      cores copiadas dos tokens claro/escuro (o worker não carrega o styles.css); texto em pt-BR ou inglês, pelo idioma do app
```

### M5

```
Seção recolhida (M5: "Fora de uso" nas Integrações, "Jobs do servidor" nas Automações)
  base       <details> nativo, fechado; <summary> com seta (gira 90° aberta), nome e contador
  regra      o que custa consultar só é pedido ao abrir (jobs do servidor); a seta não anima com reduced-motion
  tokens     summary --muted / hover --fill-hover; contador --fill + --muted, raio --radius-full
  a11y       teclado e leitor de tela do próprio <details>; 44px em toque
```

```
Linha de integração (M5: `IntegrationRow.vue`, a mesma nas duas listas)
  partes     ícone, nome, tag do plugin, transporte · destino (mono), dica de autorização ou motivo da falha, selo de status
  estados    conectado, precisa autorizar, falhou, não verificado; fora de uso: "Não configurado" ou "Desativado"
```

```
Chaves encontradas em .env (M5, `EnvKeysSection.vue`)
  partes     título + contador de chaves, dica (só nomes, nunca valores; guarde cópia num gerenciador de senhas), por projeto: cartão com um arquivo por linha
  arquivo    caminho (mono), "Chaves" (nomes com cara de credencial, --ink, peso 600) e "Outras variáveis" (--muted): a diferença vem escrita, não só na cor
  estados    procurando, nenhum arquivo, lista, projeto com mais arquivos do que o mostrado, erro na tela
  regra      nenhum botão abre conversa
```

```
Cofre do 1Password (M5, `VaultSection.vue`)
  estados    CLI ausente (como instalar: comando do Homebrew no Mac + link do guia), sem login ("Listar cofres": é o botão que faz o 1Password pedir aprovação, nunca a abertura da página),
             com login (endereço da conta, selo "conta de serviço", nomes dos cofres em pílulas), erro em frase fixa traduzida
  regra      só leitura: nenhum campo de texto, nenhum lugar para colar token; a dica da conta de serviço aparece sempre
  tokens     cartão --surface / --line / --radius-lg; selo ok --ok sobre --ok-soft, sem login --warn-ink sobre --warn-soft
```

```
Job do servidor (M5, `ServerJobs.vue`)
  partes     nome, "Desativado" quando for, Frequência (mono, nos termos do sistema: cron ou chaves do launchd), Próxima execução (systemd), Comando (mono, quebra linha, segredos como ***)
  grupos     crontab, systemd timers, LaunchAgents, cada um com contador
  estados    fechado (nada consultado), olhando, vazio ("Nada agendado foi encontrado em: …"), lista, erro; "Verificar de novo"
```

```
Mensagem fixada (M5, `PinnedMessageBar.vue` + `PinMessageButton.vue`)
  barra      acima da linha do tempo: alfinete (--accent), a mensagem em uma linha, "Desafixar"; clicar no texto abre a mensagem inteira (aria-expanded, rolável)
  botão      alfinete embaixo de cada mensagem sua, ao lado de Copiar (aria-pressed; --accent quando é a fixada; --danger se falhar)
  estados    nada fixado (a barra não existe), fixada, aberta, desafixando, erro na barra
  regra      uma por conversa; fora das prévias; 44px em toque na barra (o botão segue os 32px do Copiar do upstream)
```

```
Reportar um problema (M5, `ReportProblem.vue`)
  onde       rodapé da barra lateral, grudado embaixo (margin-top:auto), com linha --fill-hover em cima
  estados    parado, "Abrindo…" (desabilitado), erro embaixo do botão (role=alert)
  regra      só age no clique; a primeira vez cria o app, as seguintes só abrem
  app        página própria (não usa os tokens do Tendly: roda num iframe): formulário, lista com Aberto/Resolvido, remover em dois cliques, pt/en pelo navegador, claro/escuro
```

### Apps A (rail e barra)

```
Rail de ícones (Apps A, `IconRail.vue`; só na Mesa, janela ≥ 761px, preferência "Ícones")
  coluna     56px, fundo --glass-side, borda direita --glass-edge; a grade do shell ganha a coluna com a classe .hub-rail-on
  partes     páginas (Início, Mesa, Habilidades, Integrações, Automações) · divisória · Apps (catálogo) · tiles dos apps (rolam sozinhos, mínimo de 2 visíveis)
             · pé: sino com selo, Reportar um problema, Mais (Todas as sessões, Uso, Sistema, "Mostrar a barra completa aqui"), Configurações
  item       40×40 (44 em toque), raio --radius-md; ícone 19px --muted; hover --fill + --ink; atual --selected + --accent (aria-current)
  tile       AppTile 28px; app em foco: --elevated + contorno --line-strong + barra --accent à esquerda; app com aba aberta: bolinha --accent
  selo       sino: pílula --accent / --on-accent, "99+" acima de 99; o número também vai no aria-label ("Notificações, 3 não lidas")
  dica       o nome ao lado do ícone (hover, ou foco pelo teclado), fundo --ink e texto --bg; desenhada no body para a rolagem não cortar
  menu       sai à direita do item, --surface / --line / --shadow-lg, 220px; fecha com Esc, ←, Tab, clique fora ou ao redimensionar
  teclado    uma parada de Tab (tabindex itinerante); ↑ ↓ andam e dão a volta, Home/End, Enter abre; → / tecla de menu / Shift+F10 num app abre as opções
  arrastar   o tile leva `application/tendly-pane` (o mesmo de uma conversa arrastada): soltar numa borda de painel divide ali
  a11y       <nav aria-label> com role=toolbar vertical dentro; todo botão com aria-label; anel de foco por dentro do item (outline-offset -2px)
  estados    sem apps (só o ícone Apps), muitos apps (rolagem), janela baixa (o rail inteiro rola), reportando (aria-busy), erro (aviso no menu, role=alert)
```

```
Alça do painel (Apps A, dentro do `IconRail.vue`)
  o que é    o controle de recolher do painel Workspaces/Conversas, que na Mesa é a coluna ao lado do rail
  onde       círculo de 22px na borda direita do painel, a meia altura; com o painel recolhido fica na borda do rail
  estados    aberto ("‹", aria-expanded=true), recolhido ("›"); hover --ink + --line-strong; alvo de 44px em toque
```

```
Lista de apps na barra (Apps A, `SidebarApps.vue`; barra expandida e gaveta do celular)
  partes     cabeçalho "Apps ›" (leva ao catálogo) + "+" (catálogo com o cursor no formulário), até 8 linhas tile 20px + nome, "Ver todos" (com o total quando há mais)
  linha      30px (44 em toque), hover --fill; "…" aparece no hover/foco (sempre em toque); arrastável para a Mesa
  estados    sem apps (só o cabeçalho), 1–8, mais de 8, menu aberto embaixo da linha
```

```
Opções do app (Apps A, `AppOrderMenu.vue`; no rail, na lista da barra e na página Apps)
  itens      Fixar no topo / Desafixar · Mover para cima · Mover para baixo · Ocultar / Mostrar de novo
  regras     mover troca com o vizinho do mesmo grupo (fixados entre si, o resto entre si) e desabilita na ponta; ocultar tira do rail, da barra e do Início
             (continua na página Apps, com o selo "Oculto"); a mudança aparece na hora e volta se o servidor recusar (erro embaixo, role=alert)
  teclado    ↑ ↓ Home End dentro do menu; depois de mover, o foco fica no mesmo item ou no oposto
  tokens     item 30px (44 em toque), --text-sm, hover --fill; anel de foco por dentro
```

```
Barra lateral na Mesa (Apps A, cartão em `AddressesPanel.vue`)
  o que é    dois rádios, Ícones (padrão) e Expandida, cada um com uma frase; salva ao escolher; "Salvando…", "Salvo. A Mesa já mostra assim.", erro inline
  atalhos    rail → Mais → "Mostrar a barra completa aqui"; pé da barra expandida na Mesa → "Mostrar só ícones aqui" (escondido na gaveta do celular)
```

```
Cabeçalho de app (Apps B, `AppView.vue`; no painel da Mesa e na tela cheia)
  partes     tile + nome · caminho do código · [N erros] · Conversar · [Abrir na Mesa] · recarregar · copiar link · abrir fora
             tela cheia: tile 24px, nome --text-md, 44px de altura, o caminho é o botão "código em apps/<slug>/" (mostra a pasta no painel de arquivos)
             painel: tile 20px, nome --text-sm, 34px, o caminho é texto em --mono; sem "Abrir na Mesa"
  botões     Conversar e Abrir na Mesa = small-button com ícone + rótulo; os demais = icon-button; todos com aria-label e title
             Conversar em tela cheia: aria-pressed + variante primary enquanto a coluna está aberta
             copiar link: vira "check" por 2,5 s e anuncia "Link copiado" (role=status); falha → faixa --danger-soft com o motivo
  estreito   o cabeçalho é um container (`app-view`): ≤ 620px os rótulos somem (ficam nome acessível e title), ≤ 420px o caminho some;
             as ações quebram para uma segunda linha em vez de serem cortadas (360px); toque: alvos de 44px
  estados    carregando ("Carregando…" sobre a moldura), app sumiu (painel: Remover aba · tela cheia: Ver todos os apps; + Tentar de novo),
             app.json quebrado (o motivo do servidor), lista de apps ilegível (erro + Tentar de novo)
```

```
Aviso de atualização (Apps B, dentro do `AppView.vue`)
  onde       pílula no canto inferior esquerdo da moldura (--elevated, --line, --shadow-md, --radius-full, --text-sm), role=status aria-live=polite
  variantes  "Atualizado agora · Desfazer" (some em 60 s) · "Voltando os arquivos…" · "Mudança desfeita · Refazer" (+ "alguns arquivos ficaram como estão", com a lista no title)
             · "Tem uma versão nova pronta · Recarregar agora" (o app segurou o recarregar; fica até recarregar) · erro do desfazer em --danger-ink
  ações      text-button; "×" dispensa; o title do texto lista os arquivos mudados; sem animação com prefers-reduced-motion
```

```
Erros do app (Apps B, dentro do `AppView.vue`)
  selo       botão "N erros" (small-button danger, ícone info) no cabeçalho, só quando há erro; aria-expanded
  lista      faixa abaixo do cabeçalho, até 45% da altura, rolagem própria; cada erro: tipo (Erro · Promise rejeitada · console.error · Arquivo não carregou) ×n,
             mensagem (pre-wrap, até ~6 linhas), arquivo:linha:coluna em --mono; cartões --danger-soft / --danger-line
  rodapé     "Nada é enviado até você apertar enviar na conversa." · Limpar · Pedir correção (primary) · fechar; Esc fecha e devolve o foco ao selo
  regra      a lista zera quando uma página do app carrega de novo; no máximo 50 erros, repetido conta no mesmo
```

```
Coluna de conversa (Apps B, `AppFullPage.vue`)
  o que é    a conversa sobre o app, à direita do app em tela cheia; largura 320px até (página − 360px), padrão 420px, lembrada no navegador
  barra      44px: ícone + título da conversa · Nova conversa sobre este app (+) · Levar para a Mesa · Fechar (Esc)
  divisória  role=separator vertical, focável: arrastar, ou ← → (24px), Home/End; 7px de alvo (15px em toque); durante o arrasto a moldura não recebe o ponteiro
  estreito   página < 680px: a conversa cobre o app (position absolute) e não há divisória; fechar mostra o app de novo
  estados    começando ("Iniciando…"), sem conversa (texto + "Nova conversa"), não deu para começar (inline-error), conversa aberta (SessionPane comum)
```

### Apps C (ponte e permissões)

```
Cartão de permissões (Apps C, `AppPermissions.vue`, dentro do `AppView.vue`)
  quando     1ª abertura de um app que pede algo: no lugar do app (layout gate; o app só carrega depois da resposta)
             a lista do app cresceu, ou botão "Permissões" do cabeçalho: faixa acima do app (layout strip, até 60% da altura, rolagem própria)
  partes     ícone shield + título ("{app} pede a sua permissão" · "O que {app} pode fazer") · "Este app quer:" · lista · nota · botões
             linha da lista: o que a permissão deixa fazer, em frase (--text-sm, --sunken, --border, --radius-sm);
             depois de alguma resposta, cada linha traz o estado: Permitido (--ok-ink) · Recusado (--danger-ink) · Novo (--accent-ink)
  botões     pergunta nova: Recusar (small-button) · Permitir (small-button primary, por último); Recusar mantém o que já estava permitido
             já respondido: Retirar tudo · Permitir tudo (só o que mudaria algo) + fechar (icon-button); Esc fecha e devolve o foco ao botão do cabeçalho
  gate       cartão centrado, largura máx. 480px, --elevated, --border, --radius-lg, --shadow-card; cabe em 360px (min-width 0, texto quebra)
  estados    salvando (os dois botões desabilitados), erro ao salvar (faixa --danger-soft, role=alert)
  toque      botões com 44px em pointer: coarse
```

```
Botão Permissões no cabeçalho do app (Apps C, `AppView.vue`)
  quando     só para app que pede alguma permissão, e só depois da primeira resposta
  forma      small-button com ícone shield + "Permissões"; aria-expanded; ≤ 620px fica só o ícone (aria-label e title continuam)
```

```
Chip de contexto do app (Apps C; `open-context.ts` + `app-context.ts`, desenhado pelo composer do upstream)
  texto      "+ App" quando o app não disse nada; "+ App · tela" depois de tendly.host.setContext({view})
  anexado    o chip anexado acompanha a tela do app (o nome muda sozinho); a mensagem enviada leva, embaixo de apps/<slug>/,
             "Screen: …", "Selected: …", "Summary: …", ditas como palavras do app
  limites    tela 80 caracteres · seleção 500 · resumo 2000; some quando o app recarrega ou fecha
```

```
Aviso de app no sino (Apps C, `InboxPage.vue`)
  linha      título "App: título" em negrito · "Aviso de um app · corpo" · idade; o ponto usa a cor padrão dos avisos (--accent)
  clique     marca como lido e abre o app em tela cheia (só links /apps/<workspace>/<slug> são seguidos)
```

### Apps D (dados: exportar e importar)

```
Menu "…" do cabeçalho do app (Apps D, `AppView.vue`)
  onde       último botão do cabeçalho (icon-button, ícone more), no painel da Mesa e na tela cheia; aria-haspopup=menu, aria-expanded
  menu       abre embaixo do botão, alinhado à direita: --elevated, --line, --radius-md, --shadow-md, largura 180–260px, acima da moldura (z-index 6)
  itens      "Exportar dados…" (ícone download) · "Importar dados…" (ícone upload); linhas de 30px (44px em pointer: coarse), --text-sm, hover --fill
  teclado    ↓ no botão abre; ao abrir o foco vai para o 1º item; ↑ ↓ Home End andam; Esc fecha e devolve o foco ao botão; Tab fecha; clique fora fecha
```

```
Painel de dados do app (Apps D, `AppDataPanel.vue`, faixa acima do app como a de permissões)
  forma      faixa --surface com borda embaixo, até 70% da altura com rolagem própria; conteúdo com largura máx. 520px; cabe em 360px (min-width 0)
  cabeçalho  ícone (download | upload) + título ("Exportar dados de {app}" · "Importar dados para {app}") + fechar (icon-button); Esc fecha e devolve o foco ao "…"
  exportar   Coleção (select: "leads · 12 registros") · Formato (2 opções em cartão: JSON "Tudo, do jeito que está guardado…" · CSV "Uma coluna por campo…") · botão Exportar (small-button primary)
             estados: carregando a lista · app sem coleções ("…não há o que exportar") · exportando (botão desabilitado) · "{arquivo} salvo" (--ok-ink, role=status)
  importar   Arquivo (input file .json/.csv) · Para a coleção (texto com sugestões das que existem; embaixo "Ela tem N registros hoje." ou "Uma coleção nova."; nome inválido em --danger-ink)
             · Registros que já estão lá (2 opções em cartão: Manter · Remover antes) · botão Importar (desabilitado sem arquivo e coleção)
  confirmar  "Remover antes" numa coleção com registros: no lugar do rodapé aparece a faixa --danger-soft "Isso remove os N registros de {coleção} antes de importar. Não dá para desfazer."
             com Cancelar e "Remover e importar" (small-button danger); nunca window.confirm; mudar arquivo, coleção ou opção desfaz a pergunta
  resultado  "{n} registros adicionados." · "… e {m} atualizados." · "{n} registros substituídos por {m}." (--ok-ink); erro do servidor em faixa --danger-soft (role=alert), com a linha do arquivo
  campos     borda --line-input, --radius-sm, --text-md; opção marcada: --elevated com borda --line-input; foco: o anel global
  toque      botões, campos e opções com 44px em pointer: coarse
```

Fora deste sistema: modais, menus de contexto, árvore de arquivos, terminal e chat são do upstream e seguem como estão.
