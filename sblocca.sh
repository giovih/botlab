#!/usr/bin/env bash
# Sblocca tutti i dispositivi bloccati per troppe password sbagliate.
set -euo pipefail
cd "$HOME/botlab"
sudo rm -f data/bloccati.json
sudo docker compose restart server >/dev/null
echo "Tutti i dispositivi sono stati sbloccati."
