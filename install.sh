#!/usr/bin/env bash
# Installazione automatica di BotLab su un server Ubuntu (es. Oracle Cloud Free).
# Uso:  curl -fsSL https://raw.githubusercontent.com/giovih/botlab/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/giovih/botlab.git"
BRANCH="${BRANCH:-main}"
DIR="$HOME/botlab"
BOT_SUBNET="172.31.250.0/24"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ask() {
  local v=""
  while [ -z "$v" ]; do
    printf '%s ' "$1" >&2
    if ! read -r v </dev/tty; then echo "Non riesco a leggere la risposta: esegui lo script da un terminale." >&2; exit 1; fi
    v="${v//[$'\t\r ']/}"
  done
  printf '%s' "$v"
}

say "Installo Docker e git (se mancano)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
command -v git >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq git; }
sudo systemctl enable --now docker >/dev/null 2>&1 || true

say "Apro le porte 80 e 443 nel firewall interno di Ubuntu"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1 || true; fi

say "Proteggo il server dai bot"
# I bot non possono raggiungere i servizi interni di Oracle (metadati) né la rete privata.
sudo tee /usr/local/sbin/botlab-firewall >/dev/null <<FW
#!/bin/sh
for d in 169.254.0.0/16 10.0.0.0/8 192.168.0.0/16; do
  iptables -C DOCKER-USER -s $BOT_SUBNET -d \$d -j DROP 2>/dev/null || iptables -I DOCKER-USER -s $BOT_SUBNET -d \$d -j DROP
done
FW
sudo chmod +x /usr/local/sbin/botlab-firewall
sudo tee /etc/systemd/system/botlab-firewall.service >/dev/null <<'UNIT'
[Unit]
Description=BotLab: blocca l'accesso dei bot alla rete interna
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/botlab-firewall
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload >/dev/null 2>&1 || true
sudo systemctl enable --now botlab-firewall.service >/dev/null 2>&1 || sudo /usr/local/sbin/botlab-firewall

say "Scarico BotLab"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  say "Configurazione"
  echo "Ti servono due cose: la chiave Gemini (da https://aistudio.google.com/apikey) e una password a tua scelta."
  GEMINI_API_KEY="${GEMINI_API_KEY:-$(ask "Incolla la chiave Gemini e premi Invio:")}"
  BOTLAB_PASSWORD="${BOTLAB_PASSWORD:-$(ask "Scegli una password per entrare nell'app (senza spazi) e premi Invio:")}"
  IP="${PUBLIC_IP:-}"
  [ -n "$IP" ] || IP=$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || true)
  if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    IP=$(ask "Non riesco a trovare l'IP pubblico: scrivilo tu (lo trovi nella pagina dell'istanza Oracle):")
  fi
  umask 077
  # valori tra apici singoli: così simboli come $ o # nella password non danno problemi
  GEMINI_API_KEY="${GEMINI_API_KEY//\'/}"; BOTLAB_PASSWORD="${BOTLAB_PASSWORD//\'/}"
  cat > .env <<ENV
GEMINI_API_KEY='$GEMINI_API_KEY'
BOTLAB_PASSWORD='$BOTLAB_PASSWORD'
DOMAIN=${IP//./-}.sslip.io
DOMAIN2=${IP//./-}.nip.io
BOT_MEMORY=1g
BOT_CPUS=1
ENV
fi
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
DOMAIN2=$(grep '^DOMAIN2=' .env | cut -d= -f2)

say "Preparo il mini PC dei bot (qualche minuto la prima volta)"
sudo docker build -q -t botlab-sandbox ./sandbox >/dev/null

say "Avvio BotLab"
sudo docker compose up -d --build

say "Attendo il certificato HTTPS (fino a 3 minuti)"
URL=""
for _ in $(seq 1 36); do
  for d in "$DOMAIN" "$DOMAIN2"; do
    if curl -fs -o /dev/null --max-time 5 "https://$d/"; then URL="https://$d"; break 2; fi
  done
  sleep 5
done

if [ -n "$URL" ]; then
  say "Fatto! 🎉"
  echo "Apri sul telefono o sul PC:  $URL"
  echo "e inserisci la password che hai scelto."
else
  say "BotLab è avviato, ma il certificato HTTPS non è ancora pronto."
  echo "Prova ad aprire tra qualche minuto:  https://$DOMAIN  oppure  https://$DOMAIN2"
  echo "Se non si apre mai, controlla di aver aperto le porte 80 e 443 nella Security List di Oracle (vedi la guida)."
fi
