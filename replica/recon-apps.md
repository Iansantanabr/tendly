# Recon: Apps (construtor de apps + barra de ícones)

Recorte do recon principal (`recon.md`), só sobre Apps. Clean-room: estuda o que o app faz e como a pessoa usa, a partir dos prints e da transcrição. Não copia código, marca nem visual.

## Fontes

| # | fonte | onde | o que dá |
|---|---|---|---|
| 1 | transcrição do vídeo | `~/Desktop/[Portuguese (auto-generated)] a Ratoeira tá mudando…txt` (trechos ~272–365, 490–500, 676–780, 985–1000) | como os apps nascem, mudam e são usados |
| 2 | mockups da landing | `screens/P01, P04, P08` | rail com tiles, app como painel "APP", app em tela cheia com papel e "código em apps/…" |
| 3 | prints do app real | `screens/P02, P09–P13, P28–P33` | catálogo, app aberto, apps no painel, contexto do app no chat |

## O que a fonte diz (resumo)

- "Área 100% customizável onde tu cria teus aplicativos, teus programinhas", para criar "um CRMzinho, um app de vendas, um app de rotinas". O agente já sabe como criar (é o nosso skill `tendly-apps`).
- Os apps "ficam todos aqui [Início] ou na barra da esquerda também pra acessar rapidamente".
- Na Mesa, uma faixa de apps abertos embaixo ("posso deixar recolhidinho"). Dá para arrastar um app para o lado e montar app + chats em grade.
- O chat "sabe que eu tô com o aplicativo de conteúdo aberto. Se eu clico aqui, ele já puxa o contexto do aplicativo que eu tô vendo". No P32 o chip diz **"Sessões · Quadro"**: o app conta ao Tendly a tela em que está, não só o nome.
- **"Conversar"** abre um chat ao lado do app em modo foco. Serve tanto para trabalhar *dentro* do app quanto para pedir mudanças *no* app: "não gostei que pra editar o post tem que dar dois cliques… ele altera… eu recarrego o aplicativo e já tá mudado".
- Os apps rodam "na mesma VPS", com dados e integrações reais:
  - Sessões lê as sessões do Claude/Codex da máquina;
  - Pipeline recebe leads do WhatsApp/e-mail, com o agente sugerindo resposta;
  - Monitoramento checa a VPS e manda e-mail;
  - Conteúdo tem a Bancada com "Salvar e renderizar".

  Ou seja, os apps têm lado servidor, não são só HTML estático.
- "Se tu pede um aplicativo ele cria ali mesmo, tu não precisa criar conta em lugar nenhum, já bota o aplicativo direto no ar."
- "Apps nas áreas" (P28): "o agente de quem administra publica sozinho quando termina de criar ou mudar um app… Quem acessa cada um tu define em Pessoas." Cada app publicado mostra "No ar · <hash>".

## Telas

| ID | tela | como chega | o que tem | estados vistos | fork hoje |
|---|---|---|---|---|---|
| S14 | Catálogo de apps (P28) | "Apps ›" na barra | título + subtítulo; **Adicionar atalho**; **Criar com o agente**; cards (tile, nome, descrição de 2–4 linhas, rota `/pipeline/`); card "+ Criar um app" ("abre uma conversa na Mesa"); seção "Apps nas áreas" (No ar · hash) | cheio | ◐ cards e criar; sem atalho, rota ou publicados |
| S15 | App em tela cheia (P08, P29–P31) | tile na barra ou no catálogo | rail global à esquerda; cabeçalho fino: tile + nome, **Conversar**, **Abrir na Mesa**, recarregar, copiar link, abrir fora. P08 também mostra o selo "Marina · admin", "código em apps/pipeline/" e "Apps" | foco | ✗ (só como painel) |
| S15b | App como painel da Mesa (P04, P09, P11, P13, P32) | arrastar, ou "Abrir na Mesa" | aba com ícone de grade + nome; várias abas de apps no mesmo painel (Sessões, Reportes, Pipeline, Workshop); ícones do painel: recarregar, link, abrir fora, conversar, "…" | painel estreito, app vira navegação inferior (P13) | ◐ |
| S15c | Conversar com o app (P29, P32, P33) | botão Conversar | o painel "Nova conversa" abre ao lado com o chip "Sessões · Quadro ×"; composer completo | — | ◐ (chip só com o nome) |
| S16 | Rail de ícones (P02, P08, P29, P31) | barra recolhida | logo; Início, Mesa, Habilidades, Integrações, Automações; divisória; **tile de cada app**, com o app aberto destacado; embaixo: sino com número, Reportar, Configurações, Tema, avatar | app ativo destacado | ✗ (recolher esconde tudo) |
| S17 | Barra expandida com Apps (P01, P10, P17, P28) | padrão no Início | "Apps ›" (leva ao catálogo) + "+"; lista vertical de até ~8 apps (tile + nome); "Ver todos" | — | ◐ (chips em grade, sem "Ver todos" nem "+") |

### Telas dentro dos apps

Valem como **requisitos do construtor**, não como coisas a copiar.

| app | o que o construtor precisa permitir |
|---|---|
| Conteúdo (P12, P29–P31) | navegação interna em barra lateral, que vira barra inferior em painel estreito; filtros por marca; busca ⌘K; semana/mês com arrastar; kanban com contadores; **editor visual** (Bancada) com "alterações não salvas", Desfazer, **Salvar e renderizar** (ação no servidor), subir foto, trocar cores |
| Sessões (P11, P32) | **ler dados do próprio Tendly** (as 527 sessões); kanban com arrastar; filtros; "Abrir" um card **abre a conversa na Mesa**; o chip de contexto leva a tela atual |
| Pipeline (P08) | kanban de CRM; selo do papel de quem vê; tags; leads chegando de fora (webhook/e-mail) |
| Workshop (P33) | cards com progresso; contadores; chat ao lado com contexto |
| Monitoramento, Reportes (P28) | jobs no servidor, alerta por e-mail; formulário que outras pessoas usam |

### Como a barra se comporta (P02, P10, P11, P13, P28, P29)

- **Duas colunas na Mesa.**
  - O rail (~56px) leva a navegação global: Início, Mesa, Habilidades, Integrações, Automações; um ícone de grade que leva ao catálogo; os tiles de todos os apps; e, embaixo, sino com número, Reportar, Configurações, Tema e avatar.
  - Ao lado, num painel próprio e recolhível (a seta "‹" na borda, P11), ficam as abas Arquivos/Conversas e a lista.
  - O menu global **não** ocupa altura em cima da lista. No fork hoje, os dois estão na mesma coluna, e foi isso que esmagou a lista numa janela baixa.
- **Barra expandida no Início e no catálogo** (P10, P28): os mesmos itens com nome; "Apps ›" (link para o catálogo) e "+"; a lista vertical de apps; "Ver todos".
- **App em tela cheia** (P29, P31): só o rail, com o tile do app aberto destacado.
- **Apps abertos na Mesa** ficam numa faixa de abas de um painel (P11: Sessões, Reportes, Pipeline, Workshop, Conteúdo), que pode ficar recolhida embaixo. Com um app aberto, todo composer da Mesa mostra o chip "+ Sessões" (P11).

## Fluxos

```
F09  Criar um app com o agente
     S14 "Criar com o agente" -> conversa na Mesa com o app ao lado -> o app aparece no rail -> uso
     happy path: 1 clique + 1 frase
     edge: app quebra (erro em branco), nome repetido, o agente escreve fora de apps/<slug>/

F10  Mudar um app conversando  (o loop principal)
     S15 "Conversar" -> o chat abre ao lado com o contexto "App · tela" -> pedido -> o agente edita -> o app recarrega sozinho
     happy path: 1 clique + 1 frase; hoje: 1 clique + 1 frase + recarregar à mão
     edge: o app perde o estado ao recarregar, o agente quebra o app, desfazer a mudança

F11  Trabalhar dentro do app com o agente
     S15 ação no app ("sugerir resposta", "renderizar") -> o app chama o servidor ou o agente -> o resultado volta para o app
     edge: custa uso da conta, demora, falha

F12  Ir de um app para o resto
     card "Abrir" no app Sessões -> a conversa abre na Mesa; caminho de arquivo -> abre o arquivo

F13  Acesso rápido
     rail: 1 clique no tile -> app em tela cheia; arrastar o tile para a Mesa -> painel

F14  Atalho para sistema de fora
     S14 "Adicionar atalho" -> nome + URL -> tile no rail; abre num painel, ou fora se o site não deixa embutir

F15  Publicar app para outras pessoas   (multiusuário, depois da VPS)
     o agente publica ao terminar -> "No ar · hash" -> quem acessa é definido em Pessoas
```

## Componentes novos

| componente | variantes | estados | telas |
|---|---|---|---|
| Rail de ícones | nav, tile de app, sino com número | ativo, hover com tooltip, foco, app aberto, arrastando | S16 |
| Lista de apps na barra | linha tile + nome, "+", "Ver todos" | ativo | S17 |
| Cabeçalho de app | tela cheia, painel | carregando, com erro ("2 erros"), atualizado agora | S15, S15b |
| Card de app | app, atalho, criar, publicado | quebrado, sem descrição | S14 |
| Chip de contexto de app | nome · tela | removível | S15c |
| Selo de erros do app | — | 0 / n erros, "Pedir correção" | S15 |
| Kit de UI para apps (`kit.css` + componentes) | barra lateral do app, barra inferior, kanban, tabela, cards, filtros, modal, toast, editor | vazio, carregando, erro, escuro, 360px | dentro dos apps |

## Modelo de dados inferido

```
App            workspace_id, slug, name, letter, color, description, entry, route,
               kind (app | shortcut), url (atalho), server (opcional), permissions[],
               order/pinned, updated_at
               evidência: P28 (rota, atalho), P08 ("código em apps/…"); confiança: alta
AppRecord      app, collection, id, data(json), rev, created_at, updated_at
               evidência: kanbans e listas com arrastar (P11, P30, P32); confiança: palpite (hoje: chave/valor em JSON)
AppFile        app, path, size: fotos subidas (P31 "Subir outra foto"); confiança: média
AppContext     app, view, selection: o que o chip leva (P32 "Sessões · Quadro"); confiança: alta
AppVersion     app, hash, created_at, published: "No ar · hash" (P28); confiança: média
AppServer      app, command, port, status, logs: apps com lado servidor (transcrição); confiança: média
AppGrant       app, person, role: "Marina · admin", "Só admin" (P08, P28); depois do multiusuário
```

## O que temos hoje e o que falta

| capacidade | fork hoje | falta |
|---|---|---|
| Convenção `apps/<slug>/app.json`, arquivos estáticos servidos | ✅ | `route`, `kind: shortcut`, `server`, `permissions` |
| Painel da Mesa (iframe com sandbox) com Chat, Recarregar, Abrir fora | ✅ | recarregar sozinho quando os arquivos mudam; copiar link; erros do app |
| Catálogo com criar e scaffold (blank, issues) | ✅ | **Adicionar atalho**, rota no card, templates para escolher, "Criar com o agente" abrindo o app ao lado da conversa |
| Dados: `tendly.data` chave/valor (JSON até 1 MB) | ✅ | coleções com registros e revisão (dois painéis do mesmo app não se sobrescrevem); arquivos/fotos; aviso ao vivo de mudança |
| Chip de contexto "+ app" | ✅ nome | **tela atual e seleção** vindas do app (`tendly.host.setContext`) |
| Ponte app ↔ Tendly | ✗ | abrir conversa, arquivo ou outro app na Mesa; preencher o chat; tema; largura do painel |
| Dados do próprio Tendly no app | ✗ | leitura de sessões, arquivos e automações, com permissão declarada e aceita |
| Lado servidor do app | ✗ | processo do app (`server.mjs`) supervisionado, atrás do proxy do Tendly; ações, webhooks e jobs |
| App em tela cheia | ✗ | rota `/apps/<ws>/<slug>` com cabeçalho, Conversar (chat ao lado), Abrir na Mesa |
| Rail de ícones | ✗ | barra recolhida vira rail; tiles dos apps; arrastar tile para a Mesa |
| Versões do app | ◐ histórico por arquivo | versão do app inteiro a cada turno do agente, voltar o app todo |
| Publicar app / acesso por pessoa | ✗ | depois da VPS e do multiusuário |
| Kit de UI / visual coerente entre apps | ✗ | `kit.css` + componentes, ensinados pelo skill |

## O que não dá para clonar

- Os apps de negócio da Dobra (Conteúdo, Pipeline, Sessões, Workshop…) são conteúdo deles. O fork entrega o **construtor** e, no máximo, templates genéricos nossos (kanban, tabela, calendário, painel).
- Visual e marca deles: o kit de UI usa os tokens do Tendly.

## Tamanho

**M–L.**
- **M** para o que muda o uso no dia a dia: rail, tela cheia, ponte, recarregar sozinho, contexto, atalhos, templates.
- **L** se entrarem o lado servidor dos apps e as coleções com revisão.

Partes difíceis:
1. **Lado servidor do app:** supervisionar processos, isolar, segredos, proxy e logs.
2. **Ponte segura app ↔ Tendly:** o iframe é same-origin hoje; a ponte precisa de permissões, senão um app vira dono da API inteira.
3. **Dados concorrentes:** o mesmo app em dois painéis ou duas janelas, e o agente editando o app enquanto ele roda.
