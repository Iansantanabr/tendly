# Refino das telas (2026-11-10)

Levantamento em Chrome (1440, 1180 e 375 px) das 11 páginas, com /frontend-design
e /ui-ux-pro-max. Direção: a do GCore (funcional, tokens de `styles.css`, verde
só para ação principal e para "onde você está"). Decisões tomadas com o Ian:

| # | Problema | Decisão |
|---|---|---|
| 1 | Explorador de arquivos aberto em todas as páginas | Só na Mesa; o botão do topo ainda abre |
| 2 | "‹ Voltar à Mesa" ao lado de todo título | Some no computador; no celular fica a seta. Esc continua voltando |
| 3 | Topo diz "Canvas de workspace compartilhado › CarSoul" em toda página | Fora da Mesa, o nome da página; na Mesa, "Mesa › projeto" |
| 4 | Uso com fonte mono, rótulos em 3 linhas, "+16408.0%" | Fonte do app, números tabulares, rótulo numa linha, variação curta |
| 5 | Cada página com uma largura; título e botões mudam de lugar | Mesma margem e largura máxima; ações sempre à direita do cabeçalho |
| 6 | Habilidades: um botão verde por linha, caminho mono longo | Botões secundários; caminho menor, cinza, cortado no meio |
| 7 | Início: 5 seletores que quebram e cortam | Agente e projeto à mostra; conta, esforço e aprovação em "Ajustes" |
| 8 | Celular: telas vazando a 375 px | Nada vaza; alvos de 44 px |
| 9 | `git/status` 400 em todo carregamento (workspace oculto sem git) | Não pedir status de pasta que não é repositório |

## Feito

Tudo acima, conferido no Chrome a 1440, 1180 e 375 px, claro: nada vaza, nem dentro das páginas. Testes da web 1043.
O 400 de `git/status` ainda aparece uma vez ao abrir a página (é como o app descobre que a pasta não é Git), mas não se repete a cada poucos segundos.

Ficou para depois: o celular não tem título próprio nas páginas que já o mostram no topo (Uso, Configurações; é de propósito); o nome das habilidades segue em fonte mono (é um identificador).
