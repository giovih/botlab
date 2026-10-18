#!/usr/bin/env bash
# Aggiorna BotLab all'ultima versione mantenendo bot e dati.
set -euo pipefail
cd "$HOME/botlab" && git pull --ff-only
sudo docker build -t botlab-sandbox ./sandbox
sudo docker compose up -d --build
echo "Aggiornato."
