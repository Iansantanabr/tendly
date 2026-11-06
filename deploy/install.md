# Instalar o Tendly (fork do Ian) numa VPS Ubuntu

Receita escrita **para o Claude Code seguir**, do começo ao fim, numa VPS nova (Ubuntu 24.04 ou 22.04, x64 ou arm64), conectado por SSH com um usuário que tem `sudo`. O Ian acompanha e faz só o que depende das contas dele.

Arquivos deste kit (`deploy/`):

| arquivo | vai para | o que é |
| --- | --- | --- |
| `tendly.service` | `/etc/systemd/system/` | o servidor, com usuário próprio e sandbox |
| `tendly.env.example` | `/etc/tendly/tendly.env` | token de acesso e endereços (0600, root) |
| `Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS: domínio do app e domínio dos publicados |
| `backup.sh` | `/usr/local/bin/tendly-backup` | backup diário do `~/.tendly` |
| `tendly-backup.service`, `.timer` | `/etc/systemd/system/` | roda o backup todo dia |
| `backup.env.example` | `/etc/tendly/backup.env` | opcional: dias guardados e cópia fora da máquina (restic) |

## Regras para quem segue a receita

- Siga na ordem. Cada passo termina com um **Confira**: se o resultado não for o esperado, pare, mostre a saída e resolva antes de continuar.
- Não abra nenhuma porta além de 22, 80 e 443. O Tendly escuta só em `127.0.0.1:28789`; quem atende a internet é o Caddy.
- O token de acesso nunca vai para o repositório, para um commit ou para um log. Mostre-o ao Ian **uma vez**, para ele guardar no gerenciador de senhas.
- Não crie nem altere registros de DNS, não compre nada, não entre em conta nenhuma: isso é do Ian (lista abaixo).
- Não inicie conversas de agente nem automações de agente para "testar": gasta o uso das contas dele. Os testes desta receita usam só `curl`.
- Não apague dados: ao restaurar, o que existe é movido para o lado, nunca removido.
- Este kit foi escrito e revisado num Mac, sem uma VPS para rodar. O passo 8 (`systemd-analyze verify`) e o passo 9 (`caddy validate`) são a primeira vez que o systemd e o Caddy leem estes arquivos: leve os avisos deles a sério e corrija o arquivo, não o aviso.

## O que o Ian entrega antes de começar

1. **A VPS**: Ubuntu 24.04 LTS, 2 vCPU e 4 GB de RAM no mínimo (8 GB se for compilar nela), 40 GB de disco. IP público. Acesso SSH por chave.
2. **Dois nomes de domínio** (podem ser subdomínios do mesmo domínio):
   - `APP_DOMAIN`, o app. Exemplo: `tendly.seudominio.com.br`.
   - `PUB_DOMAIN`, só as páginas publicadas. Exemplo: `pub.seudominio.com.br`. O ideal é um domínio registrado **diferente** do app (por exemplo `seudominio.link`): assim nem o cookie de sessão do app chega às páginas publicadas. Com subdomínios do mesmo domínio continua seguro (o servidor não aceita esse nome como origem da API e as páginas saem com CSP), só com uma camada a menos.
3. **Registros de DNS** criados por ele, apontando para o IP da VPS, antes do passo 9:
   - `A  APP_DOMAIN → IPv4 da VPS` e `A  PUB_DOMAIN → IPv4 da VPS`;
   - `AAAA` para os dois, só se a VPS tiver IPv6 (um AAAA errado faz o certificado falhar).
4. **Um e-mail** para o Let's Encrypt e para o Web Push (`EMAIL`).
5. **De onde vem o binário** (passo 5): do CI do fork ou compilado na VPS.
6. **Se os dados do Mac vêm junto** (passo 7). Se vierem, a pasta do usuário do serviço na VPS é `/Users/iansantana` (o mesmo caminho do Mac); se não, `/home/tendly`. O motivo está em `FORK.md`, "Do Mac para a VPS".
7. Na hora do passo 4: **entrar nas contas** do Claude e do Codex (abre um link no navegador dele).

Defina no shell, para os comandos abaixo:

```bash
APP_DOMAIN=tendly.seudominio.com.br
PUB_DOMAIN=pub.seudominio.com.br
EMAIL=voce@seudominio.com.br
T_HOME=/home/tendly            # ou /Users/iansantana, se os dados do Mac vêm junto
```

## 1. Conferir a máquina

```bash
lsb_release -ds; uname -m; nproc; free -h; df -h /
curl -4 -s https://ifconfig.me; echo
getent ahostsv4 "$APP_DOMAIN" | head -1; getent ahostsv4 "$PUB_DOMAIN" | head -1
```

**Confira:** Ubuntu 22.04 ou 24.04; `x86_64` ou `aarch64`; os dois nomes já resolvem para o IP público desta máquina. Se o DNS ainda não resolve, dá para seguir até o passo 8 e esperar antes do 9.

## 2. Sistema, firewall e atualizações automáticas

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git gnupg sqlite3 rsync unzip ufw unattended-upgrades restic openssl
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# Firewall: só SSH, HTTP e HTTPS. O SSH é liberado ANTES de ligar.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443          # tcp e udp (HTTP/3)
sudo ufw --force enable
sudo ufw status verbose
```

**Confira:** `ufw status` mostra `Status: active` e só as regras 22/tcp, 80/tcp e 443 (v4 e v6). A sessão SSH continua viva. Se o provedor tiver firewall próprio (Hetzner, DigitalOcean, AWS…), peça ao Ian para deixar as mesmas três portas lá.

Opcional, só se o Ian pedir: desligar login por senha no SSH (`PasswordAuthentication no` em `/etc/ssh/sshd_config.d/`), depois de confirmar que a chave dele entra.

## 3. Usuário do serviço

Sem senha, sem `sudo`. Os agentes rodam comandos como este usuário e não conseguem virar root.

```bash
sudo mkdir -p "$(dirname "$T_HOME")"
sudo adduser --disabled-password --gecos "Tendly" --home "$T_HOME" tendly
sudo chmod 750 "$T_HOME"
id tendly; getent passwd tendly | cut -d: -f6
```

**Confira:** o usuário existe, a pasta é `$T_HOME` e ele **não** está nos grupos `sudo` nem `admin`.

## 4. Node, Claude Code e Codex

O servidor chama `node` (auxiliares), `claude` e `codex`. Node vem do pacote do sistema; as duas CLIs ficam na pasta do usuário, para poderem se atualizar sozinhas.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
node --version      # v24.x

sudo -u tendly -H bash -lc '
  set -e
  mkdir -p ~/.npm-global ~/.local/bin
  npm config set prefix ~/.npm-global
  npm install -g @openai/codex
  curl -fsSL https://claude.ai/install.sh | bash
'
# O mesmo PATH que o tendly.service usa:
sudo -u tendly -H env PATH="$T_HOME/.local/bin:$T_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
  sh -c 'command -v node claude codex && claude --version && codex --version'
```

**Confira:** os três caminhos aparecem (`/usr/bin/node`, `$T_HOME/.local/bin/claude`, `$T_HOME/.npm-global/bin/codex`) com as versões. Se um instalador mudou de lugar, consulte a documentação oficial da CLI e ajuste o `PATH` do `tendly.service` para onde ela ficou.

**Entrar nas contas (o Ian faz):** as contas não viajam do Mac (lá o login do Claude fica no Keychain). Duas formas:
- depois do passo 9, pela interface: Configurações → Contas → adicionar a conta e seguir o link; ou
- agora, pelo terminal: `sudo -u tendly -H env PATH=... claude` e `/login` (mostra um link para abrir em qualquer navegador e pede o código de volta); `codex login` (se oferecer login por código de dispositivo, use; senão faça um túnel SSH da porta que ele indicar).

Não continue sem perguntar ao Ian qual das duas ele prefere; não invente credenciais.

## 5. O binário do servidor

O binário já traz a interface dentro. Duas origens; use a que o Ian escolheu.

**A. Do CI do fork** (sem compilar na VPS). O Ian, no GitHub: aba Actions do fork → habilitar os workflows → **Release** → *Run workflow* → branch `ian`. O job `build` gera um artefato por plataforma (o job `npm` falha de propósito fora do upstream: não tem a credencial e não publica nada). Ele baixa o artefato `x86_64-unknown-linux-musl` (ou `aarch64-unknown-linux-musl`, conforme o `uname -m` do passo 1) e manda para a VPS, ou você baixa com `gh run download` se o `gh` estiver autenticado.

```bash
# com o .zip do artefato (ou o .tar.gz de dentro dele) em ~/
cd ~ && { unzip -o ./*linux-musl*.zip 2>/dev/null || true; }
tar xzf tendly-*-linux-musl.tar.gz
sudo install -m 0755 tendly-*-linux-musl/tendly-server /usr/local/bin/tendly-server
```

**B. Compilado na VPS** (precisa de uns 4 GB de RAM livres; com menos de 8 GB no total, crie 4 GB de swap antes: `sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`).

```bash
sudo apt -y install build-essential pkg-config
sudo -u tendly -H bash -lc '
  set -e
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . ~/.cargo/env
  export PATH="$HOME/.npm-global/bin:$PATH"
  npm install -g pnpm@10.30.3
  mkdir -p ~/src && cd ~/src
  [ -d tendly ] || git clone --branch ian https://github.com/Iansantanabr/tendly.git
  cd tendly && git pull --ff-only
  pnpm install --frozen-lockfile
  pnpm build:web
  cargo build --release --locked -p tendly-server
'
sudo install -m 0755 "$T_HOME/src/tendly/target/release/tendly-server" /usr/local/bin/tendly-server
```

Nos dois casos, o kit `deploy/` precisa estar na VPS (em B já está em `$T_HOME/src/tendly/deploy`):

```bash
[ -d "$T_HOME/src/tendly/deploy" ] || sudo -u tendly -H git clone --depth 1 --branch ian https://github.com/Iansantanabr/tendly.git "$T_HOME/src/tendly"
KIT=$T_HOME/src/tendly/deploy
/usr/local/bin/tendly-server --version
```

**Confira:** `tendly-server --version` responde `tendly 0.1.x`.

## 6. Token de acesso e endereços

```bash
sudo install -d -m 0755 /etc/tendly
sudo install -m 0600 -o root -g root "$KIT/tendly.env.example" /etc/tendly/tendly.env
TOKEN=$(openssl rand -hex 32)
sudo sed -i \
  -e "s|^TENDLY_TOKEN=.*|TENDLY_TOKEN=$TOKEN|" \
  -e "s|^TENDLY_ALLOWED_ORIGINS=.*|TENDLY_ALLOWED_ORIGINS=https://$APP_DOMAIN|" \
  -e "s|^TENDLY_PUBLIC_URL=.*|TENDLY_PUBLIC_URL=https://$APP_DOMAIN|" \
  -e "s|^TENDLY_PUSH_SUBJECT=.*|TENDLY_PUSH_SUBJECT=mailto:$EMAIL|" \
  /etc/tendly/tendly.env
sudo stat -c '%U:%G %a %n' /etc/tendly/tendly.env
sudo grep -c '^TENDLY_TOKEN=.\{64\}$' /etc/tendly/tendly.env
```

**Confira:** `root:root 600` e a contagem `1`. Mostre agora ao Ian, uma vez, o link de entrada (ele guarda o token no gerenciador de senhas): `https://APP_DOMAIN/#tendly-token=<token>`. Depois `unset TOKEN` só no fim do passo 10 (ele ainda é usado nos testes).

Por que o token é obrigatório aqui: atrás do Caddy toda requisição chega de `127.0.0.1`, e o Tendly não pede token a quem está na própria máquina **a não ser que exista um**. Sem `TENDLY_TOKEN`, a internet inteira seria "a própria máquina". O `tendly.service` se recusa a iniciar sem ele.

## 7. Dados (opcional): trazer do Mac ou restaurar um backup

Pule se a instalação começa vazia. Faça **antes** do primeiro start.

- **Do Mac:** siga `FORK.md`, "Do Mac para a VPS" (o que copiar, o que não copiar, e por que `T_HOME=/Users/iansantana`).
- **De um backup:** siga "Restaurar um backup", no fim desta receita.

**Confira:** `sudo ls -la "$T_HOME/.tendly"` mostra `tendly.db` e `hub.db` do usuário `tendly`, e **não** mostra `tendly.pid`, `server.lock`, `tailnet.json` nem a pasta `web/` (uma pasta `web/` no disco substitui a interface embutida no binário).

## 8. systemd

```bash
sed "s#/home/tendly#$T_HOME#g" "$KIT/tendly.service" | sudo tee /etc/systemd/system/tendly.service >/dev/null
sudo systemd-analyze verify /etc/systemd/system/tendly.service
sudo systemctl daemon-reload
sudo systemctl enable --now tendly
sleep 3; systemctl --no-pager --full status tendly | head -15
sudo journalctl -u tendly -n 30 --no-pager
```

**Confira (todos têm que bater):**

```bash
ss -tlnp | grep 28789                                                    # só 127.0.0.1:28789
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28789/api/health       # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28789/api/workspaces   # 401  <- sem token não entra
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:28789/api/workspaces   # 200
sudo systemd-analyze security tendly | tail -1                           # nota de exposição (quanto menor, melhor)
```

Se `/api/workspaces` sem token responder **200**, pare tudo: `sudo systemctl stop tendly`, e não siga para o Caddy até o `TENDLY_TOKEN` estar no `/etc/tendly/tendly.env`.

Se o serviço não sobe: `journalctl -u tendly -n 80`. Causas comuns: `TENDLY_TOKEN` vazio (a mensagem diz), binário da arquitetura errada, pasta `$T_HOME` com dono errado (`sudo chown -R tendly:tendly "$T_HOME"`). Se uma linha de sandbox do unit impedir uma ferramenta de funcionar, comente **só aquela linha**, anote qual foi e avise o Ian.

## 9. Caddy e HTTPS

Só depois que os dois nomes resolverem para esta máquina (passo 1).

```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt update && sudo apt -y install caddy

sed -e "s/app\.example\.com/$APP_DOMAIN/g" -e "s/pub\.example\.com/$PUB_DOMAIN/g" -e "s/you@example\.com/$EMAIL/g" \
  "$KIT/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy || sudo systemctl restart caddy
sleep 20; sudo journalctl -u caddy -n 30 --no-pager | grep -iE 'certificate|error|obtain' | tail -10
```

**Confira:** `caddy validate` diz `Valid configuration`; o log mostra `certificate obtained successfully` para os dois nomes (pode levar um minuto). Erro de certificado quase sempre é DNS: o nome não aponta para esta máquina, ou existe um AAAA errado.

## 10. Configurações do hub e verificação de fora

```bash
# Fuso das automações e endereço dos links publicados.
curl -s -X PUT http://127.0.0.1:28789/api/hub/settings \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tendly-Client: web' -H 'Content-Type: application/json' \
  -d "{\"timezone\":\"America/Sao_Paulo\",\"public_base_url\":\"https://$PUB_DOMAIN\"}"; echo
```

**Confira:** a resposta é `{"timezone":"America/Sao_Paulo","public_base_url":"https://PUB_DOMAIN","dictation":"browser"}`. (Se os dados vieram do Mac, o fuso já veio junto; o comando só confirma.)

Agora de fora, pelos nomes públicos (rode na própria VPS e, se puder, também de outra máquina):

```bash
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; echo; }
code https://$APP_DOMAIN/                          # 200  o app carrega
code https://$APP_DOMAIN/api/health                # 200
code https://$APP_DOMAIN/api/workspaces            # 401  sem token não entra
code -H "Authorization: Bearer $TOKEN" https://$APP_DOMAIN/api/hub/settings   # 200
code http://$APP_DOMAIN/                           # 308  http vira https
code https://$PUB_DOMAIN/                          # 404  o domínio dos publicados não tem app
code https://$PUB_DOMAIN/api/health                # 404  nem API
code https://$PUB_DOMAIN/api/auth                  # 404  nem login
code https://$PUB_DOMAIN/p/nao-existe/             # 404  (página "não encontrada" do Tendly)
code -H "Origin: https://$PUB_DOMAIN" -H "Authorization: Bearer $TOKEN" https://$APP_DOMAIN/api/hub/settings   # 403  página publicada não chama a API
curl -sI https://$APP_DOMAIN/ | grep -i strict-transport-security
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://$(curl -4 -s https://ifconfig.me):28789/api/health || echo "fechada (certo)"
unset TOKEN
```

**Confira:** os códigos batem com os comentários, o cabeçalho HSTS aparece, e a porta 28789 **não** responde de fora. Qualquer diferença: pare e investigue. Em especial, `200` em `https://PUB_DOMAIN/` ou em `/api/...` desse domínio significa que o Caddyfile não é o deste kit.

Depois peça ao Ian para abrir `https://APP_DOMAIN/#tendly-token=<token>` no navegador dele e conferir: a Mesa abre; Configurações → **Endereços e fuso horário** mostra o fuso e o endereço público; publicar um arquivo de teste gera um link em `https://PUB_DOMAIN/p/...` que abre numa janela anônima; Configurações → Notificações → ligar neste aparelho → "Enviar teste" (os aparelhos inscritos no Mac não valem aqui: o endereço mudou, cada um se inscreve de novo).

## 11. Backup diário

```bash
sudo install -m 0755 "$KIT/backup.sh" /usr/local/bin/tendly-backup
sed "s#/home/tendly#$T_HOME#g" "$KIT/tendly-backup.service" | sudo tee /etc/systemd/system/tendly-backup.service >/dev/null
sudo install -m 0644 "$KIT/tendly-backup.timer" /etc/systemd/system/tendly-backup.timer
bash -n /usr/local/bin/tendly-backup && echo "sintaxe ok"
sudo systemd-analyze verify /etc/systemd/system/tendly-backup.service /etc/systemd/system/tendly-backup.timer
sudo systemctl daemon-reload
sudo systemctl start tendly-backup.service          # o primeiro, agora
sudo journalctl -u tendly-backup -n 20 --no-pager
sudo -u tendly ls -la "$T_HOME/backups/tendly/"
sudo -u tendly bash /usr/local/bin/tendly-backup --check "$T_HOME/backups/tendly/$(date -u +%F)"
sudo systemctl enable --now tendly-backup.timer
systemctl list-timers tendly-backup.timer --no-pager
```

**Confira:** `sintaxe ok`; o log termina em `Done: .../AAAA-MM-DD`; a pasta de hoje tem `tendly.db`, `hub.db`, `history/`, `sessions/`, `BACKUP.txt`; o `--check` imprime `ok` para cada banco; o timer mostra a próxima execução (06:30 UTC = 03:30 em São Paulo). O `backup.sh` nunca tinha sido executado antes desta instalação (no Mac ele só foi lido): se algo falhar aqui, conserte o script e avise o Ian.

**Fora da máquina (recomendado; depende do Ian escolher o destino).** Um backup que mora no mesmo disco não salva de perder a VPS. Com um destino restic (outro servidor por SFTP, Backblaze B2, S3):

```bash
sudo install -m 0600 -o root -g root "$KIT/backup.env.example" /etc/tendly/backup.env
sudoedit /etc/tendly/backup.env                      # RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE e as chaves do destino
openssl rand -base64 32 | sudo tee /etc/tendly/restic-password >/dev/null
sudo chown root:tendly /etc/tendly/restic-password && sudo chmod 0640 /etc/tendly/restic-password
# uma vez: criar o repositório, com as mesmas variáveis
sudo -u tendly -H env $(sudo grep -v '^#' /etc/tendly/backup.env | xargs) restic init
sudo systemctl start tendly-backup.service && sudo journalctl -u tendly-backup -n 10 --no-pager   # termina em "Sent."
```

A senha do restic (`/etc/tendly/restic-password`) tem que estar guardada **também fora da VPS** (gerenciador de senhas do Ian): sem ela o backup de fora não abre.

## 12. Reinício e fim

```bash
sudo reboot
# reconecte e:
systemctl is-active tendly caddy; systemctl is-enabled tendly caddy tendly-backup.timer
curl -s -o /dev/null -w '%{http_code}\n' https://$APP_DOMAIN/api/health   # 200
```

**Confira:** tudo `active`/`enabled` e o app responde depois do boot. Entregue ao Ian um resumo: os dois endereços, onde está o token (`/etc/tendly/tendly.env`), onde ficam os backups, e qualquer linha do kit que precisou mudar.

## Dia a dia

| tarefa | comando |
| --- | --- |
| ver o log | `sudo journalctl -u tendly -f` |
| reiniciar (para as conversas em andamento) | `sudo systemctl restart tendly` |
| atualizar o binário | refaça o passo 5 e `sudo systemctl restart tendly`; a migração do `hub.db` roda sozinha no start |
| trocar o token | edite `TENDLY_TOKEN` em `/etc/tendly/tendly.env`, `sudo systemctl restart tendly`; todos os navegadores saem e entram de novo com o token novo |
| backup agora | `sudo systemctl start tendly-backup.service` |
| mudar fuso / endereço público / ditado | Configurações → Endereços e fuso horário (ou `PUT /api/hub/settings`) |
| instalar um pacote do sistema para os agentes | por SSH, com `sudo apt install …`: de dentro do Tendly ninguém vira root |

Não use `tendly-server start|stop|restart|update` na VPS: quem manda no processo é o systemd, e o fork não está no npm.

## Restaurar um backup

Serve para voltar atrás na mesma VPS ou para montar uma VPS nova (faça os passos 1 a 6 nela antes).

```bash
BACKUP=$T_HOME/backups/tendly/AAAA-MM-DD            # a pasta escolhida
# vindo do restic:  sudo -u tendly -H env $(sudo grep -v '^#' /etc/tendly/backup.env | xargs) restic restore latest --tag tendly --target "$T_HOME/restore"
#                   e então BACKUP=$T_HOME/restore$T_HOME/backups/tendly/AAAA-MM-DD

sudo -u tendly bash /usr/local/bin/tendly-backup --check "$BACKUP"     # cada banco: ok
sudo systemctl stop tendly
# O estado atual vai para o lado; nada é apagado.
[ -d "$T_HOME/.tendly" ] && sudo mv "$T_HOME/.tendly" "$T_HOME/.tendly.antes-de-restaurar-$(date -u +%Y%m%d-%H%M%S)"
sudo -u tendly rsync -a "$BACKUP"/ "$T_HOME/.tendly"/
sudo chown -R tendly:tendly "$T_HOME/.tendly" && sudo chmod 700 "$T_HOME/.tendly"
sudo systemctl start tendly
sleep 3; systemctl is-active tendly; sudo journalctl -u tendly -n 20 --no-pager
```

**Confira:** o serviço está `active`; `curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:28789/api/hub/settings` responde com o fuso e o endereço de antes; no navegador, as conversas, automações e publicados estão lá. O backup traz as conversas, os bancos, o histórico de arquivos, os publicados congelados e a chave do push; **não** traz as pastas dos projetos (ficam fora do `~/.tendly`: faça backup delas à parte, ou use git) nem o token (está em `/etc/tendly/tendly.env`). Quando o Ian confirmar que está tudo certo, a pasta `.tendly.antes-de-restaurar-*` pode ser apagada por ele.
