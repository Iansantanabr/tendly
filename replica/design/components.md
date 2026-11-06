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
  M1         o autor "Agente" vira link que abre a conversa; M5: mensagem curta por versão
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
  estados    parado, ouvindo (anel pulsando, desliga com reduced-motion), sem suporte (some), negado (dica para liberar o microfone)
  regra      a primeira vez avisa que o áudio passa pelo serviço do navegador
  a11y       aria-pressed; o texto reconhecido entra no textarea e pode ser editado antes de enviar
```

```
Espaços da Mesa (M2)
  partes     nome do espaço ativo, menu: Salvar como…, Renomear, Abrir outro, Excluir (confirmação na tela)
  estados    sem espaço (Mesa livre), espaço aberto, alterado desde que foi salvo (●)
```

```
Aparelho para notificações (M3)
  partes     "Receber notificações neste aparelho" (interruptor), lista de aparelhos com Remover, "Enviar teste"
  estados    sem HTTPS (explica e aponta o Tailscale), permissão negada, inscrito, falhou
```

Fora deste sistema: modais, menus de contexto, árvore de arquivos, terminal e chat são do upstream e seguem como estão.
