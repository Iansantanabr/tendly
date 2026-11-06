# Recon map: Ratoeira (web, desktop e celular pelo navegador)

Escopo: o ambiente de trabalho com agentes (Início, Mesa, Conversas, notificações, automações, integrações, habilidades, arquivos com histórico e publicação, apps). Multiusuário fica registrado, mas fora deste ciclo.
Para: Ian (uso próprio, CarSoul e outros projetos), num fork do Tendly (`~/tendly-src/tendly`, branch `ian`). Mac agora, VPS depois.
Data: 2026-11-05

Estudo funcional, clean-room: só fontes públicas (vídeo e prints da página e do vídeo). Nada de código, API ou conta da Ratoeira foi acessado. Os prints ficam em `replica/screens/` (fora do git) e não entram no produto.

## Fontes

| # | fonte | onde | observação |
| --- | --- | --- | --- |
| 1 | vídeo de apresentação (transcrição automática) | `~/Desktop/[Portuguese (auto-generated)] a Ratoeira tá mudando…[DownSub.com].txt` | demonstração ao vivo; fala de beta fechado, VPS, multiusuário e celular |
| 2 | prints da landing page (mockups) | `replica/screens/P01–P08` | usuária fictícia "Marina"; marcadores numerados explicando a Mesa |
| 3 | prints do app real tirados do vídeo | `replica/screens/P09–P33` | usuário "dudu", org DobraLabs |
| 4 | descrição detalhada de cada print | `replica/screens/INDEX.md` | feita a partir dos prints |
| 5 | página de venda e comunidade | link na descrição do vídeo (não acessado) | preço e acesso, não muda o escopo |

Sem help center, changelog, API pública nem conta própria: o mapa vem do vídeo e dos prints. As telas que nenhum print mostra estão marcadas como "não visto".

## Core loop

Pedir algo a um agente (Claude Code ou Codex, usando a assinatura da pessoa) num lugar que fica ligado o tempo todo. Ver o agente trabalhar ao lado dos arquivos e apps que ele cria. Ser avisado quando termina ou precisa de resposta. Publicar ou automatizar o resultado sem sair dali.

## Telas

Coluna "fork" = como está hoje no fork. ✅ existe · ◐ parcial · ✗ falta.

| ID | tela | como chegar | propósito | componentes-chave | estados vistos | fork |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | Início | `/` | ponto de partida | saudação, status dos agentes, composer (conta, modelo, esforço, permissão, pasta, anexo, ditado), sugestões, "Continuar…", cards Rodando agora / Arquivos / Últimas conversas / Apps / Abertas no celular / Compartilhadas | vazio, cheio | ◐ |
| S02 | Mesa | `/mesa` | área de trabalho em grade | painéis com abas (conversa, arquivo, app), dividir arrastando, layout salvo como "espaço" | 2×2, 3+2, foco | ✅ (espaço nomeado ◐) |
| S03 | Barra lateral Arquivos | aba na Mesa | navegar arquivos | busca, upload, "Sincronizado há N min", árvore, rodapé "N não lidas · N rodando" | cheio | ✅ |
| S04 | Barra lateral Conversas | aba na Mesa | triagem de conversas | Esperando tua resposta (+ Responder), Rodando agora, Não lidas (+ Marcar todas), Tuas conversas, Rotinas recentes, Compartilhadas contigo | não lidas, rodando | ◐ |
| S05 | Painel de conversa | aba na Mesa | conversar com o agente | tool calls colapsáveis, status ao vivo, rodapé conta·modelo·esforço·permissão, chips de contexto, anel de uso, timer, fila/agora, mensagem fixada | rodando, concluído | ✅ (ditado ✗, fixar ✗) |
| S06 | Conversa compartilhada | Compartilhar na conversa | várias pessoas e agentes no mesmo chat | presença, mensagens por autor, "Claude · pra Caio", @menções, "Entre nós", link de conversa como contexto | compartilhado | ✗ (fora do ciclo) |
| S07 | Painel de arquivo | clicar num arquivo | ler/editar | Editar, Renderizado/Original, recarregar, histórico, publicar, link, abrir fora, baixar | renderizado | ✅ |
| S08 | Histórico do arquivo | relógio no arquivo | ver quem mudou e voltar | lista autor + mensagem + tempo, diff, "Ver o arquivo como estava" | versão antiga | ✅ |
| S09 | Publicar | globo no arquivo | link para fora | link com nome, Quem vê (time / senha + Gerar / qualquer um), Atualiza (quando eu mandar / sozinho), Pedir pro agente, Publicar | senha | ✅ (Gerar ✗, Pedir pro agente ✗) |
| S10 | Notificações | sino | o que terminou ou espera você | lista, não lidas, marcar lidas | não visto aberto | ✅ |
| S11 | Automações | `/automacoes` | rotinas agendadas | toggle, cron + próxima, comando, último resultado, Log, Editar com o chat, Nova; seção Do time; inventário de jobs do servidor | ligada, desligada, nunca rodou | ✅ (Do time ✗, inventário ✗) |
| S12 | Integrações | `/integracoes` | o que o agente alcança | conectores (origem, host, status, Autorizar), Testar de novo, Fora de uso, chaves sem registro, 1Password, MCPs por pessoa | conectado, precisa autorizar | ◐ |
| S13 | Habilidades | `/habilidades` | catálogo de skills | busca, filtro por pasta, contagem, card (nome, agente, descrição, origem, Ver, Usar no chat) | cheio | ◐ |
| S14 | Apps (catálogo) | "Apps ›" | apps do time | Adicionar atalho, Criar com o agente, cards com rota, "Criar um app", Apps nas áreas (no ar · hash) | cheio | ✗ (Fase 4) |
| S15 | App aberto | tile do app | app feito pelo agente | cabeçalho (tile, nome, Conversar, Abrir na Mesa, recarregar, link, abrir fora), selo papel e "código em apps/…", bottom-nav em painel estreito | foco, painel | ✗ (Fase 4) |
| S16 | Configurações · Contas de IA (tua) | Configurações | contas pessoais | por provedor, várias contas, uso 5h/semana, Padrão, Remover, Adicionar | cheio | ✅ (Tendly) |
| S17 | Configurações · Organização | Configurações | time | Pessoas, Contas de IA da org (quem pode usar), Padrão do chat, Ditado, E-mail, Segurança, Endereços, Publicados | só Contas da org visto | ✗ (fora do ciclo, exceto Endereços/Publicados) |
| S18 | Celular | mesmo endereço no celular | uso fora do computador | conversas em tempo real, áudio, abas, sino com push | não visto | ◐ |

18 telas (S06 e S17 fora deste ciclo).

## Fluxos

```
F01 Pedir algo do Início e acompanhar na Mesa
    S01 (digitar, Enter) -> S02/S05 abre a conversa rodando -> S10 avisa ao terminar
    happy path: 2 cliques (digitar + enviar; abrir a notificação)
    edge: conta sem login, várias contas sem padrão, sem projeto
    fork: ✅ (Fase 1)

F02 Responder o que está esperando
    S04 "Esperando tua resposta" -> Responder -> S05
    happy path: 1 clique
    edge: aprovação de ferramenta pendente
    fork: ◐ (sem botão Responder inline)

F03 Usar um arquivo aberto como contexto
    S07 arquivo aberto -> S05 chip "+ arquivo" -> enviar
    happy path: 1 clique
    fork: ✅ arquivos · ✗ apps

F04 Ver o que o agente mudou e voltar atrás
    S07 -> relógio -> S08 escolher versão -> diff -> Restaurar
    happy path: 3 cliques
    edge: rascunho não salvo, arquivo binário ou grande
    fork: ✅ (Fase 3)

F05 Publicar para um cliente com senha
    S07 -> globo -> S09 Com senha -> (Gerar) -> Publicar -> Copiar link
    happy path: 4 cliques
    edge: slug ocupado, página com assets, link fora da rede
    fork: ✅ (sem Gerar; sem domínio próprio)

F06 Criar uma rotina pela conversa
    S05 "toda manhã às 8 faça X" -> agente usa a ferramenta -> S11 aparece ligada -> roda -> S10 avisa -> S04 Rotinas recentes
    happy path: 1 mensagem
    edge: Mac dormindo no horário, conta sem login, script falha
    fork: ✅ ferramenta e notificação · ✗ seção Rotinas recentes

F07 Ver integrações e autorizar a que falta
    S12 -> Testar de novo -> "Autorizar no claude.ai"
    happy path: 2 cliques
    fork: ◐ (sem link direto)

F08 Achar e usar uma habilidade
    S13 buscar -> Usar no chat -> S05 com a skill no composer
    happy path: 2 cliques
    fork: ◐ (sem Usar no chat)

F09 Criar um app com o agente e mudar o app conversando
    S14 Criar um app -> S05 conversa guiada -> app aparece em S14 e na sidebar -> S15 -> Conversar -> pedir mudança -> recarregar
    happy path: 3 cliques + conversa
    edge: app quebra, dados do app, app em painel estreito
    fork: ✗ (Fase 4)

F10 Continuar no celular
    S18 abrir o mesmo endereço -> conversa -> mandar áudio -> push quando terminar
    fork: ◐ (layout mobile do Tendly; sem push, sem PWA, sem ditado)

F11 Trabalhar junto na mesma conversa
    S05 Compartilhar -> escolher pessoa e papel -> S06 -> Entre nós / @menção
    fork: ✗ (fora do ciclo)
```

## Componentes

| componente | variantes | estados | usado em |
| --- | --- | --- | --- |
| Composer | início, nova conversa, resposta | vazio, digitando, enviando, fila | S01, S05, S06 |
| Seletor de conta/modelo/esforço/permissão/pasta | chip com menu | aberto, desabilitado | S01, S05 |
| Chip de contexto | arquivo, app, conversa | sugerido, adicionado | S05 |
| Item de conversa | não lida, esperando, rodando, compartilhada, rotina | hover, selecionada | S04, S01 |
| Card de seção do Início | lista, tiles | vazio, cheio | S01 |
| Painel com abas | conversa, arquivo, app | ativo, arrastando, dividido | S02 |
| Barra do arquivo | texto, HTML, markdown, mídia | sujo, salvando | S07 |
| Painel de histórico | lista + diff | versão escolhida, restaurando | S08 |
| Painel/modal de publicar | não publicado, publicado | senha, congelado, confirmando | S09 |
| Linha de automação | script, agente | ligada, desligada, rodando, falhou, nunca rodou | S11 |
| Pílula de status | conectado, precisa autorizar, falhou, desconhecido | — | S12 |
| Card de habilidade | por origem | — | S13 |
| Tile de app | letra + cor | — | S01, S14, sidebar |
| Cabeçalho de app | foco, painel | — | S15 |
| Badge de contagem | não lidas, total | — | sidebar, S04 |
| Toggle | on/off | — | S11 |

## Modelo de dados inferido

```
Conversation  id, title, agent (claude_code|codex), account_id, model, effort, permission,
              folder, status (running|waiting|done|failed), last_turn_at, seen_at, pinned_message_id
              evidence: S04 seções, S05 rodapé, S10   confidence: high
              fork: sessões do Tendly + session_activity (hub.db)

Notification  id, kind (turn_done|turn_failed|waiting|automation_done|automation_failed|mention),
              conversation_id, title, body, created_at, read_at
              evidence: sino, vídeo "o agente terminou e tá esperando"   confidence: high
              fork: notifications (hub.db)

Automation    id, name, description, kind (script|agent), cron, timezone, folder, command | prompt,
              account_id, enabled, owner_id
              evidence: S11   confidence: high   fork: automations (sem owner)
AutomationRun id, automation_id, started_at, finished_at, status, exit_code, output_tail, conversation_id
              evidence: Log, "deu certo há X"   confidence: high   fork: automation_runs

FileVersion   id, folder, path, blob, author (pessoa|agente|auto-sync), conversation_id, message, created_at
              evidence: S08 ("Claude, pela conversa da Marina", "auto-sync (vps)")   confidence: high
              fork: file_versions (sem message)

Publication   slug, folder, path, visibility (team|password|public), password_hash, mode (frozen|live), domain
              evidence: S09, Configurações > Endereços/Publicados   confidence: high
              fork: publications (sem domain)

Integration   name, source (claude_account|user|project|codex), host, status, owner_id, in_use
              evidence: S12   confidence: medium (Fora de uso e por pessoa são guesses de campo)
              fork: só em memória (catálogo)

Skill         name, description, agent, origin folder   evidence: S13   confidence: high   fork: catálogo

App           slug, name, letter, color, description, route, code_path, published_hash, access
              evidence: S14, S15 ("código em apps/pipeline/", "No ar · hash")   confidence: medium
              fork: ✗ (Fase 4: apps/<slug>/app.json)
AppData       app_slug, key, value(json)   evidence: apps guardam estado (Pipeline, Conteúdo)   confidence: guess

Account       id, provider, kind (personal|org), label, usage_5h, usage_week, is_default, allowed_people
              evidence: S16, S17   confidence: high   fork: perfis do Tendly (sem org)

Person/Share  (fora do ciclo) person, role, folder permissions, conversation share (read|join), private note "Entre nós"
              evidence: S06, S17, vídeo   confidence: medium
```

Relações: Conversation 1-n Notification · Automation 1-n AutomationRun · AutomationRun 0-1 Conversation · FileVersion n-0..1 Conversation · Publication 1-1 arquivo · App 1-n AppData · Account 1-n Conversation.

## Matriz de funcionalidades

Ver `features.csv` (95 linhas). Prioridade: must 39, should 28, could 28. Situação no fork: 36 sim, 13 parciais, 36 faltam, 10 fora (skip).

Musts que faltam: os 5 itens de Apps (Fase 4) e rodar 24h num servidor (etapa VPS).

Shoulds que faltam ou estão parciais, por ordem de valor:
1. Ditado por voz no composer
2. Seção Rotinas recentes na barra de Conversas
3. "Pedir pro agente" no Publicar (e nos outros pontos complexos)
4. "Usar no chat" nas Habilidades + filtro por pasta
5. Botão "Continuar" e card Apps no Início
6. Composer do Início com conta/modelo/esforço/permissão
7. Celular: PWA instalável + push
8. Markdown publicado renderizado
9. Colar link de conversa como contexto
10. Espaços da Mesa com nome; link "Autorizar no claude.ai"

## Fora do escopo

- **Multiusuário** (compartilhar conversa, Entre nós, presença, @menções, Pessoas, permissões por pasta, contas da organização, automações e MCPs "do time"): decidido "só eu, por enquanto"; volta na etapa VPS.
- **Apps do negócio da Dobra** (Conteúdo, Pipeline, Sessões, Workshop, Reportes): são conteúdo deles. O fork entrega a plataforma para você criar os seus.
- **Comunidade, cursos, receitas e skills pagas** da Ratos de IA.
- **Marca e visual da Ratoeira** (nome, rato, frases de status, paleta bege/amarelo): o fork segue o visual do Tendly.
- **Instalação como SaaS**: fora; o equivalente é a etapa VPS do próprio fork.

## Tamanho

Telas 18 (16 no ciclo), fluxos 11, entidades 12.

Partes difíceis:
1. **Apps personalizados**: novo tipo de painel, iframe com sandbox, API de dados e a skill que ensina o agente.
2. **Celular de verdade**: PWA, Web Push com o servidor ligado, ditado com gravação de áudio e transcrição.
3. **Rodar 24h na VPS com publicação por domínio**: HTTPS, systemd, backup e domínio próprio.

Multiusuário (ficou fora) seria a parte mais difícil de todas.

Tamanho do que falta no ciclo: **M**. A Fase 4 cabe em alguns dias; os shoulds, em uma ou duas semanas; a VPS é uma etapa à parte.

Próximo passo: `/replica-architect`, focado na Fase 4 (Apps) e nos shoulds de maior valor.
