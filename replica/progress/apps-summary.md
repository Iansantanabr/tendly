# Apps A–E: resumo para o Ian

Cinco etapas do `replica/plan-apps.md`, feitas pelo piloto automático entre 2026-11-06 e 2026-11-07, cada uma commitada e testada sem navegador. Detalhe por etapa em `replica/progress/AppsA.md` … `AppsE.md` (e os `.done`).

## O que mudou

- **A · Rail e barra.** Na Mesa a navegação vira uma coluna de ícones (Início, Mesa, Habilidades, Integrações, Automações, Apps, os tiles dos apps, sino, Reportar, Configurações); o painel Workspaces/Conversas fica ao lado com alça de recolher. Nas páginas, a barra expandida tem "Apps ›", "+", até 8 apps e "Ver todos". Ordem dos apps (fixar, mover, ocultar) no menu "…" de cada tile, guardada nas configurações. Preferência "Barra lateral na Mesa: ícones | expandida".
- **B · Tela cheia e o loop.** `/apps/<workspace>/<slug>` com cabeçalho (Conversar, Abrir na Mesa, recarregar, copiar link, abrir fora, "código em apps/<slug>/"). Conversar abre uma coluna de chat ao lado, com o app como chip. O app recarrega sozinho 600 ms depois do agente parar de escrever ("Atualizado agora · Desfazer"). Erros do app no cabeçalho → "Pedir correção" preenche o composer (nunca envia).
- **C · Ponte e permissões.** O app roda numa moldura com origem própria (não é mais a página do Tendly; não chama a API). Tudo passa por `postMessage` (`sdk.js`). `app.json` pede permissões (`sessions:read`, `files:read`, `automations:read`, `notify`, `agent:draft`) que você aceita ou recusa uma vez. `tendly.host`: contexto para o chat ("App · tela"), abrir conversa/arquivo/app/URL, rascunho no chat, notificação, toast, tema e tamanho.
- **D · Dados de verdade.** Coleções com revisão (`tendly.db.collection`), ao vivo entre painéis e com o agente (`subscribe`), arquivos enviados (`tendly.files`), exportar/importar JSON e CSV no "…" do cabeçalho, ferramentas `tendly_app_records_*` para o agente.
- **E · O construtor.** "Criar com o agente" com uma frase, sete modelos (Em branco, Kanban/CRM, Tabela, Calendário, Painel com gráficos, Formulário + lista, Editor de documentos), nome/letra/cor sugeridos; o app nasce pronto do modelo, abre na Mesa com uma conversa ao lado e a primeira mensagem escrita (você envia). Kit de UI servido pelo Tendly (`kit.css` + `kit.js`): barra lateral que vira barra inferior, kanban com arrastar, tabela com filtro, cartões, pílulas, modal, toast, estados, gráficos, calendário, com as cores do Tendly, claro e escuro. "Versões" no cabeçalho: cada rajada de mudanças vira uma versão, com "Voltar o app para esta versão". Atalhos (nome, URL, letra, cor) no catálogo, no rail e no Início, abrindo em painel quando o site deixa (checado no servidor) ou em aba nova, dizendo por quê. Cards do catálogo com rota, "Atualizado há X" e selo de erros; apps quebrados com "Pedir correção". `GET …/diagnostics` para o agente conferir o app sem navegador.

## Como usar

1. **Criar um app:** Apps (ícone de grade, ou "+" no rail / na barra) → escreva uma frase ("quadro com meus leads por etapa") → o modelo, o nome, a letra e a cor se preenchem; ajuste se quiser → Criar. A Mesa abre com o app à esquerda e a conversa à direita, com a primeira mensagem pronta no composer. Leia, ajuste e envie.
2. **Evoluir:** no app, Conversar (tela cheia ou painel). Peça mudanças; o app recarrega sozinho. "Desfazer" no aviso volta a última rajada; "Versões" volta para qualquer ponto.
3. **Quebrou:** "N erros" no cabeçalho → Pedir correção. No catálogo, o card também mostra o selo e o botão. Um app que o Tendly nem consegue ler aparece no catálogo com o motivo e "Pedir correção".
4. **Dados:** o agente usa coleções (`tendly.db`) para listas e `tendly.data` para configurações; "…" no cabeçalho exporta/importa. Peça ao agente para "trabalhar nos dados" ("sugira resposta para cada lead novo"): ele tem ferramentas para isso.
5. **Atalhos:** Apps → Atalhos → Adicionar atalho (nome, endereço, letra, cor). O tile aparece no rail e no Início.
6. **Skill:** copie a versão nova para o Claude Code (esta rodada não escreve fora do repositório):
   ```
   cp ~/tendly-src/tendly/skills/tendly-apps/SKILL.md ~/.claude/skills/tendly-apps/SKILL.md
   ```
   Sem isso o agente não conhece o kit, os modelos, as versões e o `diagnostics`.

## O que conferir no navegador (nada disso foi visto numa tela)

Recarregue as abas do Tendly antes. Janela larga, tema claro, depois escuro; e um painel estreito (~360px) e o celular pelo Tailscale.

1. **Apps:** o painel "Criar com o agente". Digite "quadro com meus leads por etapa": o modelo pula para Kanban/CRM, o nome vira "Quadro Leads Etapa", a letra "Q", a cor violeta. Troque o modelo e a cor; edite o nome (a letra acompanha até você editá-la). Criar.
2. **Mesa:** o app à esquerda (kanban com três colunas vazias), a conversa à direita com a mensagem pronta e o chip do app. Envie se quiser testar o agente. Sem enviar, use o app: "Novo cartão", arrastar entre colunas (mouse e, no celular, segurando), ← → com o cartão em foco, lista com pílulas e filtro, editar, apagar com confirmação na própria página. Painel estreito: a barra lateral do app vira barra inferior.
3. **Os outros modelos:** criar um de cada (Tabela, Calendário, Painel, Formulário, Documentos, Em branco) e mexer: nenhum erro no cabeçalho; tema escuro; 360px.
4. **Versões:** depois de algumas mudanças do agente (ou de você salvar um arquivo do app pelo painel de arquivos), "Versões" no cabeçalho: a lista com autor, frase do agente, quando e arquivos; "Voltar o app para esta versão" → confirmação na linha → o app recarrega como estava; a versão nova aparece no topo como sua.
5. **Erros:** quebre o app de propósito (um `throw` no index.html pelo painel de arquivos): "1 erro" no cabeçalho e, no catálogo, o selo "1 erro · Pedir correção" (pode levar uns segundos; o card lê a lista de novo ao abrir a página). Clique: o app abre na Mesa com a conversa ao lado e os erros no composer.
6. **App quebrado:** estrague o `app.json` (JSON inválido): o catálogo mostra o card laranja com o motivo e "Pedir correção" → conversa na Mesa com o problema escrito. Conserte o arquivo.
7. **Atalhos:** adicione `https://example.com` (abre em painel) e `https://github.com` (recusa embutir → aba nova com o aviso dizendo por quê). Tiles no rail (com a setinha no canto) e no Início; editar e remover (confirmação na linha). Pelo Tailscale (https), um atalho `http://` não-loopback abre em aba com o aviso de conteúdo misto.
8. **Rail:** o "+" depois dos tiles leva ao catálogo com o cursor na frase. Teclado: Tab até o rail, setas passam pelos atalhos e pelo "+".
9. **/design:** a seção "App kit" mostra o demo do kit emoldurado; 360px / 640px / largura cheia; tema escuro acompanha o do Tendly. Abrir numa aba.
10. **Barra lateral (bf0f3f0):** Início com janela baixa: o seletor Workspaces/Conversas inteiro, listas com ≥ 180px, a barra rola.

## O que ficou de fora (de propósito)

- Etapa F (apps com servidor): não começou; é para fazer com você acompanhando.
- Publicar app para o time e papéis por pessoa: depois da VPS.
- Nenhuma conversa de agente foi aberta nas rodadas: o loop "pedir mudança → ver mudado" com o agente de verdade é o seu primeiro teste.

## Conferido no navegador (2026-11-07)

Chrome de verdade (o navegador embutido do app Claude bloqueia molduras isoladas sem `allow-same-origin`, que é como os apps rodam desde a Etapa C; lá o app aparece em branco). Apps de teste na pasta oculta, apagados no fim.

- **Funcionou:** os sete modelos sem erro; kanban (novo cartão no modal, arrastar entre colunas, continua depois de recarregar); "1 erro" no cabeçalho com a lista e "Pedir correção"; cartão de permissão Permitir/Recusar; app.json quebrado vira card laranja no catálogo; selo de erros no card; atalho que embute abre em painel, o que recusa abre em aba nova com o aviso; tiles dos atalhos no rail; Versões; tema escuro; o Gestor de Conteúdo.
- **Corrigido:** no celular/painel estreito o app ocupava 208px e a barra inferior metade da altura (container query tentando mudar o próprio `t-app`); botão "Novo cartão" fora da tela no kanban estreito (`.t-page` sem coluna `minmax(0,1fr)`); modelos só em inglês (agora `templates/pt-BR/`, escolhidos pelo idioma do GCore); nome sugerido "Blank"; eixo do gráfico vazio "1 · 1 · 0"; "Novembro De 2026".
- **Ficou para depois:** ícone do logo ainda é um "T"; abrir um atalho muda o workspace do topo para "Conversations"; motivo do app quebrado em inglês ("app.json is not valid JSON…"); rota do card mostra o id do workspace. Não testado: arrastar com o dedo num celular real, Safari, o ciclo com o agente.
