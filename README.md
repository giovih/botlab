# 🤖 BotLab

Crea bot AI (Gemini) che hanno **ognuno il proprio computer Linux**: possono fare ricerche sul web
ed eseguire comandi nel terminale. Tutto **gratis**: Oracle Cloud Free + Gemini free tier.

## Cosa c'è dentro
- `server/` – il cervello: collega Gemini agli strumenti (terminale, ricerca, pagine web) e mostra l'app.
- `sandbox/` – il "mini PC" di ogni bot (Ubuntu in un container Docker isolato, 1 GB RAM / 1 CPU).
- `searxng/` – motore di ricerca privato e gratuito usato dai bot.
- Caddy – HTTPS automatico e gratuito con un indirizzo tipo `https://1-2-3-4.sslip.io`.

---

## Installazione (circa 20 minuti, una volta sola)

### 1. Chiave Gemini (gratis)
1. Vai su **https://aistudio.google.com/apikey** e accedi con Google.
2. Premi **Create API key** e copia la chiave (inizia con `AIza…`). Tienila da parte.

### 2. Server Oracle Cloud (gratis per sempre)
1. Registrati su **https://www.oracle.com/cloud/free/** (chiede la carta solo per verifica, non addebita nulla
   finché resti sulle risorse "Always Free").
2. Nel menu: **Compute → Instances → Create instance**.
   - **Image**: *Canonical Ubuntu 24.04*.
   - **Shape**: premi *Change shape* → **Ampere** → `VM.Standard.A1.Flex`, 4 OCPU e 24 GB (tutto "Always Free").
   - **SSH keys**: lascia *Generate a key pair* e premi **Save private key** (non serve usarla se usi Cloud Shell).
   - Premi **Create**. Se dice "Out of capacity", riprova più tardi o cambia "Availability domain".
3. **Apri le porte web**: nella pagina dell'istanza clicca la **Subnet** → **Security Lists** → *Default Security List*
   → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, Destination port **80** → Add
   - ripeti con porta **443**

### 3. Installa BotLab (un solo comando)
1. Nella pagina dell'istanza, copia l'**IP pubblico**.
2. In alto a destra nella console Oracle apri **Cloud Shell** (icona `>_`) e collegati:
   ```
   ssh -i chiave.key ubuntu@IP_PUBBLICO
   ```
   (prima carica la chiave salvata dal menu di Cloud Shell → *Upload*, poi `chmod 600 chiave.key`;
   oppure usa qualsiasi terminale/app SSH dal PC, es. Termius da telefono).
3. Incolla questo comando e premi Invio:
   ```
   curl -fsSL https://raw.githubusercontent.com/giovih/botlab/main/install.sh | bash
   ```
4. Ti chiede la **chiave Gemini** e una **password** a tua scelta (senza spazi). Ci mette 5–10 minuti.
   Alla fine ti scrive l'indirizzo, tipo `https://123-45-67-89.sslip.io` (oppure `…nip.io`).
   **Aprilo dal telefono**, metti la password, fatto!
   (Su iPhone: Condividi → *Aggiungi a Home* per averla come app.)

### Se qualcosa non va
- **L'indirizzo non si apre**: quasi sempre mancano le porte 80/443 nella *Security List* (passo 2.3).
  Aggiungile e aspetta 2–3 minuti: il certificato HTTPS si sistema da solo.
- **"Gemini non disponibile"**: hai finito la quota gratuita del momento; riprova dopo qualche minuto.
  BotLab prova da solo più modelli Gemini gratuiti uno dopo l'altro.
- **Vedere cosa succede** (per chi vuole): `cd ~/botlab && sudo docker compose logs -f server`
- **Cambiare password o chiave**: `nano ~/botlab/.env`, salva, poi `bash ~/botlab/aggiorna.sh`.

---

## Come si usa
- **+ Nuovo** → dai un nome e (se vuoi) una personalità, es. *"Sei un esperto di Python"*.
- Scrivi al bot: *"Cerca le ultime notizie su SpaceX e salvale in un file"*, *"Installa ffmpeg e dimmi la versione"*…
  Vedrai in nero ogni comando che esegue e ogni ricerca che fa (toccali per vedere l'output).
- Il pulsante **💬 Chat / ⌨️ Terminale** ti fa usare direttamente il terminale del bot.
- 🧹 cancella la conversazione (i file restano), 🗑 elimina il bot e il suo computer.

## Sicurezza: 5 tentativi
Se qualcuno sbaglia la password **5 volte**, il suo dispositivo (la sua connessione internet) viene
**bloccato per sempre**: non potrà più entrare, nemmeno con la password giusta.
Se inserisci la password giusta prima del quinto errore, il contatore si azzera.

Se ti blocchi da solo, collegati al server (come al passo 3) e scrivi:
```
bash ~/botlab/sblocca.sh
```

## Aggiornare
```
bash ~/botlab/aggiorna.sh
```

## Limiti del gratis
- Oracle può spegnere le istanze gratuite che restano **quasi inutilizzate per 7 giorni**. Se succede, riaccendila
  dalla console (Instances → Start): bot e file restano.
- Gemini free ha un limite di richieste al minuto/giorno: se lo superi il bot aspetta e riprova, oppure ti dice di riprovare più tardi.
- I bot possono fare tutto **dentro** il loro computer, ma sono isolati dal server e tra loro.
- Non dare la password ad altri: chi entra può usare i bot (e la tua quota Gemini).
