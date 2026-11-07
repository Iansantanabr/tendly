# Próximas melhorias do GCore

Escrito em 2026-11-07, depois das etapas A–E de apps e da troca do nome visível.

## Onde estamos

- Matriz (`features.csv`): 96 feitas, 8 parciais, 8 não feitas, 10 fora do escopo (multiusuário e conteúdo da Ratoeira).
- Upstream: o Tendly original continua na v0.1.113, a mesma base do fork. Não há atualização para trazer.
- Uso real: você já tem um app, **Gestor de Conteúdo** (`content-calendar`), sem erros. Ele foi feito com a skill antiga: a instalada em `~/.claude/skills/tendly-apps/` tem 141 linhas e não conhece kit, coleções, holdReload nem permissões. A do repositório (v2) tem 418.
- Risco principal: nada das etapas A–E foi visto num navegador. Os testes passam, mas o autopilot não tinha navegador e não podia abrir conversas.

## Fase 1: consolidar o que já existe (agora, curto)

| # | O quê | Por quê | Quem |
|---|---|---|---|
| 1.1 | Instalar a skill v2 (`cp skills/tendly-apps/SKILL.md ~/.claude/skills/tendly-apps/`) | Sem ela o agente faz apps do jeito antigo: sem kit, sem coleções, manda "aperte recarregar" | eu, com seu OK (fora do repositório) |
| 1.2 | Conferência no navegador de A–E, com conserto do que quebrar | Roteiro em `progress/apps-summary.md`: rail, tela cheia, ponte e permissões, coleções, os 7 modelos, versões, atalhos, erros com "Pedir correção". Tema claro e escuro, 360px. Apps de teste só na pasta oculta | eu, no navegador do app |
| 1.3 | Rodar o ciclo completo com o agente uma vez | Criar com o agente → mensagem → agente muda → recarrega → versões. É a única coisa que gasta uso; nunca rodou | você clica em enviar; eu acompanho |
| 1.4 | Celular de verdade e Safari | Arrastar do kanban segurando, barra inferior, app instalado, abrir link de dentro do app (pode virar pop-up bloqueado) | você no aparelho, pelo Tailscale |
| 1.5 | Trazer o Gestor de Conteúdo para o kit e as coleções (opcional) | Ganha versões, atualização ao vivo e o visual do GCore | o agente, numa conversa sua |

Tamanho: S (1 dia).

## Fase 2: troca do nome, parte 2

Grupos 1 e 2 de `replica/rename-gcore.md`: textos que o agente lê, ferramentas `gcore_*` e SDK `gcore.*` (com `tendly_*` e `tendly.*` como apelido, para o Gestor de Conteúdo não quebrar), skill `gcore-apps`. Melhor fazer logo depois de 1.1, antes de criar mais apps.

Tamanho: S. Pode rodar no autopilot.

## Fase 3: VPS (o "rodar 24h", única linha "must" que falta)

O kit está pronto em `deploy/`: unit systemd, Caddyfile, backup e receita. Falta:

- **Você:** escolher e contratar o servidor, o domínio e o DNS (dois nomes: o do GCore e o das publicações), e decidir o e-mail.
- **Eu, com você acompanhando:** instalar pela receita, já com o nome novo nos bastidores (grupos 3 e 4 da troca: comando `gcore`, `~/.gcore`, variáveis `GCORE_*`); levar `hub.db`, histórico e workspaces do Mac; HTTPS; testar.
- Isso destrava: push no celular por HTTPS, publicações com domínio próprio (hoje parcial), automações que rodam com o Mac desligado, e a segurança com 2FA.
- **Decidir:** o Mac continua como segunda máquina (pareamento já existe) ou só a VPS?

Tamanho: M. Precisa de você para contas, pagamentos e DNS.

## Fase 4: apps com servidor (Etapa F)

Ações no servidor, webhooks, jobs, segredos e logs por app (`plan-apps.md`, Etapa F). Depende da Fase 3: webhook precisa de endereço público e job precisa de máquina ligada. É a parte mais arriscada, porque o app passa a rodar código no servidor, por isso roda com você olhando e não no autopilot.

Tamanho: L.

## Fase 5: parciais que valem a pena

- Configurações → Padrão do chat (conta, modelo, esforço e permissão padrão no Início).
- Integrações: registrar uma chave achada no `.env` pelo chat (hoje só lista os nomes).
- Versão publicada do app por commit (P28): publicar um app como página, que hoje só serve arquivos.

Tamanho: S cada. Bons para o autopilot.

## Fase 6: multiusuário (depois da VPS)

Login e pessoas, compartilhar conversa (só ler ou pode entrar), "Entre nós", @menção com notificação, permissões por pasta, card "Compartilhadas contigo", automações e contas do time. Mexe na base do servidor (hoje um token só).

Tamanho: L–XL. Precisa de outra rodada de recon e arquitetura antes.

## Deixado de lado por enquanto

- Card "Abertas no celular" e ícone do aparelho de origem: precisam sincronizar abas entre aparelhos. Pouco valor para uma pessoa só.
- Orquestração e "conversa infinita": as ferramentas `tendly_spawn`/`tendly_session` já deixam um agente chamar outros. Falta tela, e não há referência visual para seguir.

## Ordem recomendada

1.1 → 1.2 → 2 → 1.3/1.4 → 3 → 5 (no autopilot, enquanto a VPS é preparada) → 4 → 6.
