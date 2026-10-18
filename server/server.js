// BotLab: bot AI (Gemini) ognuno con il proprio mini PC (container Docker).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const PASSWORD = process.env.BOTLAB_PASSWORD || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// Modelli provati in ordine: se uno non esiste più o ha finito la quota gratuita si passa al successivo
const MODELS = (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-2.5-flash,gemini-flash-lite-latest,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
let MODEL = MODELS[0];
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const SEARX_URL = process.env.SEARX_URL || "http://searxng:8080";
const DATA_DIR = process.env.DATA_DIR || "./data";
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "botlab-sandbox";
const MAX_STEPS = Number(process.env.MAX_STEPS || 15);
const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "public");
const NOVNC_DIR = process.env.NOVNC_DIR || "/app/novnc"; // visore dello schermo (copiato dal mini PC)

const BOTS_FILE = path.join(DATA_DIR, "bots.json");
const HIST_DIR = path.join(DATA_DIR, "history");
await fs.mkdir(HIST_DIR, { recursive: true });

// ---------- archivio ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, value) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}
const loadBots = () => readJson(BOTS_FILE, []);
const saveBots = (bots) => writeJson(BOTS_FILE, bots);
const histFile = (id) => path.join(HIST_DIR, `${id}.json`);
const loadHistory = (id) => readJson(histFile(id), []);
const saveHistory = (id, h) => writeJson(histFile(id), h);

// ---------- docker ----------
function run(cmd, args, { timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.killed ? "timeout" : err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const containerName = (id) => `botlab-${id}`;

const BOT_NETWORK = process.env.BOT_NETWORK || "botlab-bots";
let networkReady = false;
async function ensureNetwork() {
  if (networkReady) return;
  if ((await run("docker", ["network", "inspect", BOT_NETWORK])).code !== 0) {
    // rete solo per i bot: hanno internet ma non possono parlarsi tra loro
    await run("docker", ["network", "create", "--subnet", process.env.BOT_SUBNET || "172.31.250.0/24",
      "-o", "com.docker.network.bridge.enable_icc=false", "--label", "botlab=1", BOT_NETWORK]);
  }
  networkReady = true;
}

async function ensureContainer(id) {
  const name = containerName(id);
  await ensureNetwork();
  const st = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  if (st.code === 0) {
    if (st.stdout.trim() !== "true") await run("docker", ["start", name]);
    return;
  }
  const r = await run("docker", [
    "run", "-d", "--name", name, "--hostname", `bot-${id.slice(0, 6)}`,
    "--memory", process.env.BOT_MEMORY || "2g",
    "--shm-size", "512m", // Chromium ha bisogno di memoria condivisa
    "--cpus", process.env.BOT_CPUS || "1",
    "--pids-limit", "256",
    "--restart", "unless-stopped",
    "--label", "botlab=1",
    "--network", BOT_NETWORK,
    // DNS pubblici: così i bot non usano il DNS interno di Oracle (che è bloccato per loro)
    ...(process.env.BOT_DNS || "1.1.1.1,8.8.8.8").split(",").flatMap((d) => ["--dns", d.trim()]),
    "--security-opt", "no-new-privileges",
    ...(process.env.BOT_DOCKER_ARGS || "").split(" ").filter(Boolean),
    SANDBOX_IMAGE,
  ]);
  if (r.code !== 0) throw new Error("Impossibile creare il mini PC: " + r.stderr);
}

function clip(s, n = 8000) {
  return s.length > n ? s.slice(0, n / 2) + `\n...[tagliati ${s.length - n} caratteri]...\n` + s.slice(-n / 2) : s;
}

async function execInBot(id, command, timeoutSec = 60) {
  await ensureContainer(id);
  const secs = Math.min(Math.max(Math.round(timeoutSec) || 60, 1), 300);
  // "timeout" ferma il comando dentro il mini PC, il timer esterno è solo una sicurezza
  const r = await run("docker", ["exec", "-w", "/root", containerName(id), "timeout", "-k", "5", String(secs), "bash", "-lc", command], {
    timeout: (secs + 15) * 1000,
  });
  const out = { exit_code: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr, 3000) };
  if (r.code === 124 || r.code === 137 || r.code === "timeout") out.note = `Comando interrotto dopo ${secs} secondi`;
  return out;
}

// ---------- strumenti ----------
const tools = [{
  functionDeclarations: [
    {
      name: "run_command",
      description: "Esegue un comando bash nel tuo computer Linux personale (Ubuntu, sei root, hai internet). Puoi installare pacchetti con apt o pip, scrivere file, eseguire script.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Comando bash da eseguire" },
          timeout_seconds: { type: "integer", description: "Tempo massimo (default 60, max 300)" },
        },
        required: ["command"],
      },
    },
    {
      name: "web_search",
      description: "Cerca sul web e restituisce titoli, link e anteprime dei risultati.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "fetch_url",
      description: "Scarica una pagina web e restituisce il suo testo.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    {
      name: "apri_browser",
      description: "Apre Chromium sul tuo schermo (visibile in diretta all'utente) all'indirizzo indicato. Se è già aperto apre una nuova scheda. Restituisce una foto dello schermo.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Indirizzo da aprire, es. https://www.google.com" } },
      },
    },
    {
      name: "guarda_schermo",
      description: "Fa una foto del tuo schermo (1280x800) per vedere cosa c'è.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "usa_computer",
      description: "Usa mouse e tastiera sul tuo schermo. Le coordinate x,y sono in pixel della foto dello schermo (0,0 = in alto a sinistra, max 1280x800). Dopo l'azione ricevi una nuova foto dello schermo.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "double_click", "right_click", "move", "type", "key", "scroll", "wait"], description: "click/double_click/right_click/move usano x,y; type scrive 'text'; key preme tasti in 'text' (es. 'Return', 'ctrl+l', 'ctrl+t', 'Tab'); scroll usa direction e amount; wait aspetta 'amount' secondi" },
          x: { type: "integer" },
          y: { type: "integer" },
          text: { type: "string" },
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "integer" },
        },
        required: ["action"],
      },
    },
  ],
}];

async function searx(query) {
  const res = await fetch(`${SEARX_URL}/search?format=json&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`ricerca fallita (${res.status})`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content || "").slice(0, 300) }));
}

// Riserva: versione HTML semplice di DuckDuckGo
async function duckduckgo(query) {
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
  });
  const html = await res.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html)) && out.length < 8;) {
    let url = m[1].replace(/&amp;/g, "&");
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3]).slice(0, 300) });
  }
  return out;
}

async function webSearch(query) {
  let results = [];
  try { results = await searx(query); } catch (e) { console.warn("SearXNG:", e.message); }
  if (!results.length) {
    try { results = await duckduckgo(query); } catch (e) { console.warn("DuckDuckGo:", e.message); }
  }
  if (!results.length) return { results: [], note: "Nessun risultato. Prova parole diverse o usa fetch_url su un sito specifico." };
  return { results: results.slice(0, 8) };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) return { error: "URL non valido" };
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "Mozilla/5.0 BotLab" } });
  const type = res.headers.get("content-type") || "";
  const body = await res.text();
  return { status: res.status, text: clip(type.includes("html") ? htmlToText(body) : body, 12000) };
}

// ---------- schermo del bot (desktop con Chromium) ----------
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const xdo = (id, ...args) => run("docker", ["exec", containerName(id), "xdotool", ...args], { timeout: 30000 });

async function fotoSchermo(id) {
  await ensureContainer(id);
  const r = await run("docker", ["exec", containerName(id), "sh", "-c", "scrot -o -q 60 /tmp/schermo.jpg && base64 -w0 /tmp/schermo.jpg"], { timeout: 20000 });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error("impossibile fotografare lo schermo " + r.stderr.trim());
  return r.stdout.trim();
}

async function apriBrowser(id, url) {
  await ensureContainer(id);
  url = String(url || "").trim();
  if (url && !/^(https?|about|data|file):/i.test(url)) url = "https://" + url;
  const r = await run("docker", ["exec", "-d", containerName(id), "chromium", ...(url ? [url] : [])]);
  if (r.code !== 0) return { error: "impossibile aprire il browser: " + r.stderr.trim() };
  await pausa(4000);
  return { ok: true, url, _foto: await fotoSchermo(id) };
}

async function usaComputer(id, a) {
  await ensureContainer(id);
  const x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
  const punto = Number.isFinite(x) && Number.isFinite(y) ? ["mousemove", String(x), String(y)] : [];
  const quanti = String(Math.min(Math.max(Math.round(Number(a.amount)) || 5, 1), 30));
  let r;
  switch (a.action) {
    case "click": r = await xdo(id, ...punto, "click", "1"); break;
    case "double_click": r = await xdo(id, ...punto, "click", "--repeat", "2", "1"); break;
    case "right_click": r = await xdo(id, ...punto, "click", "3"); break;
    case "move":
      if (!punto.length) return { error: "servono x e y" };
      r = await xdo(id, ...punto); break;
    case "type": r = await xdo(id, "type", "--delay", "20", "--", String(a.text ?? "")); break;
    case "key": r = await xdo(id, "key", "--", ...String(a.text || "").split(/\s+/).filter(Boolean)); break;
    case "scroll": r = await xdo(id, ...punto, "click", "--repeat", quanti, a.direction === "up" ? "4" : "5"); break;
    case "wait": await pausa(Math.min(Number(quanti), 15) * 1000); break;
    default: return { error: "azione sconosciuta: " + a.action };
  }
  if (r && r.code !== 0) return { error: r.stderr.trim() || "azione non riuscita" };
  await pausa(1200);
  return { ok: true, _foto: await fotoSchermo(id) };
}

async function callTool(botId, name, args) {
  try {
    if (name === "run_command") return await execInBot(botId, String(args.command || ""), Number(args.timeout_seconds) || 60);
    if (name === "web_search") return await webSearch(String(args.query || ""));
    if (name === "fetch_url") return await fetchUrl(String(args.url || ""));
    if (name === "apri_browser") return await apriBrowser(botId, args.url);
    if (name === "guarda_schermo") return { ok: true, _foto: await fotoSchermo(botId) };
    if (name === "usa_computer") return await usaComputer(botId, args);
    return { error: "strumento sconosciuto" };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------- Gemini ----------
function systemPrompt(bot) {
  return [
    `Sei "${bot.name}", un assistente AI con un tuo computer Linux personale.`,
    "Usa gli strumenti quando servono: run_command per il terminale, web_search e fetch_url per le ricerche.",
    "Hai anche uno schermo 1280x800 con un desktop e il browser Chromium, che l'utente può guardare in diretta.",
    "Per usare i siti come una persona (cliccare, compilare moduli, guardare pagine) usa apri_browser, usa_computer e guarda_schermo:",
    "dopo ogni azione ricevi una foto dello schermo; le coordinate x,y sono i pixel della foto. Per leggere solo il testo di una pagina fetch_url è più veloce.",
    "I programmi grafici avviati con run_command compaiono sullo schermo; avviali in background (con &) così il comando non resta bloccato.",
    "Lavora passo per passo, controlla i risultati e alla fine rispondi in modo chiaro. Rispondi nella lingua dell'utente.",
    bot.instructions ? `\nIstruzioni del tuo creatore:\n${bot.instructions}` : "",
  ].join("\n");
}

async function geminiCall(model, bot, contents) {
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt(bot) }] }, contents, tools }),
      signal: AbortSignal.timeout(120000),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 404) return { skip: true, error: data.error?.message || "modello non trovato" };
    if (res.status === 429 || res.status >= 500) {
      // limite del piano gratuito o server occupato: aspetta e riprova
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); continue; }
      return { skip: true, error: data.error?.message || `Errore Gemini ${res.status}` };
    }
    if (!res.ok) throw new Error(data.error?.message || `Errore Gemini ${res.status}`);
    const cand = data.candidates?.[0];
    if (!cand?.content?.parts?.length) {
      if (cand?.finishReason === "MALFORMED_FUNCTION_CALL" && attempt < 2) continue;
      throw new Error("Gemini non ha risposto (" + (cand?.finishReason || data.promptFeedback?.blockReason || "sconosciuto") + ")");
    }
    return { content: cand.content };
  }
}

// Le foto dello schermo pesano: nella cronologia tengo solo le ultime
function togliVecchieFoto(history, tieni = 2) {
  let viste = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i].parts || [];
    if (!parts.some((p) => p.inlineData)) continue;
    if (++viste > tieni) history[i].parts = parts.filter((p) => !p.inlineData);
  }
}

// Manda a Gemini solo la parte recente della conversazione (risparmia quota),
// iniziando sempre da un messaggio scritto dall'utente.
function recent(contents, max = Number(process.env.MAX_HISTORY || 40)) {
  if (contents.length <= max) return contents;
  let i = contents.length - max;
  while (i < contents.length - 1 && !(contents[i].role === "user" && contents[i].parts?.some((p) => p.text))) i++;
  return contents.slice(i);
}

async function gemini(bot, contents) {
  contents = recent(contents);
  const order = [MODEL, ...MODELS.filter((m) => m !== MODEL)];
  let lastError = "";
  for (const model of order) {
    const r = await geminiCall(model, bot, contents);
    if (r.content) {
      if (model !== MODEL) console.log(`Passo al modello ${model}`);
      MODEL = model;
      return r.content;
    }
    console.warn(`Modello ${model} non disponibile: ${r.error}`);
    lastError = r.error;
  }
  throw new Error("Gemini non disponibile al momento (limite gratuito?). Riprova tra qualche minuto. Dettaglio: " + lastError);
}

const busy = new Set();
// Cosa sta facendo ogni bot adesso, e le sue ultime azioni (per il pannello "PC")
const attivita = new Map(); // id -> { ora: {name,args,da} | null, storico: [...] }
function segnaAttivita(id, name, args) {
  const a = attivita.get(id) || { ora: null, storico: [] };
  a.ora = name ? { name, args, da: Date.now() } : null;
  if (name) { a.storico.unshift({ name, args, quando: Date.now() }); a.storico.length = Math.min(a.storico.length, 30); }
  attivita.set(id, a);
}

// Fotografia del computer del bot: risorse, processi, file
async function statoPc(id) {
  await ensureContainer(id);
  const name = containerName(id);
  const [stats, ps, files, disco] = await Promise.all([
    run("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}", name], { timeout: 15000 }),
    run("docker", ["exec", name, "ps", "-eo", "pid,etime,pcpu,pmem,args", "--sort=-pcpu"], { timeout: 10000 }),
    run("docker", ["exec", name, "find", "/root", "-maxdepth", "4", "-not", "-path", "*/.*", "-printf", "%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%P\n"], { timeout: 10000 }),
    run("docker", ["exec", name, "du", "-sh", "/root"], { timeout: 10000 }),
  ]);
  const [cpu, mem, memPerc] = stats.stdout.trim().split("|");
  const processi = ps.stdout.trim().split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, tempo, cpu, mem, ...cmd]) => ({ pid, tempo, cpu, mem, cmd: cmd.join(" ") }))
    .filter((p) => p.cmd && !/^(sleep infinity|ps -eo|runc|timeout -k 5 |du -sh|find \/root|socat STDIO|\[)/.test(p.cmd))
    .slice(0, 40);
  // Chromium apre tanti processi con percorsi lunghissimi: li raggruppo in una riga sola
  const chrome = processi.filter((p) => /\/chrome(\s|$)/.test(p.cmd));
  if (chrome.length) {
    const cpu = chrome.reduce((t, p) => t + Number(p.cpu || 0), 0).toFixed(1);
    const mem = chrome.reduce((t, p) => t + Number(p.mem || 0), 0).toFixed(1);
    processi.splice(processi.indexOf(chrome[0]), 0, { pid: chrome[0].pid, tempo: chrome[0].tempo, cpu, mem, cmd: `Chromium (${chrome.length} processi)` });
  }
  const visibili = processi.filter((p) => !chrome.includes(p)).slice(0, 15)
    .map((p) => ({ ...p, cmd: p.cmd.replace(/^\/usr\/bin\/python3 \/usr\/bin\/websockify.*/, "schermo in diretta (websockify)") }));
  const elenco = files.stdout.split("\n").filter(Boolean).slice(0, 400).map((l) => {
    const [tipo, size, data, ...p] = l.split("\t");
    return { dir: tipo === "d", size: Number(size), data, path: p.join("\t") };
  }).filter((f) => f.path).sort((a, b) => a.path.localeCompare(b.path));
  const a = attivita.get(id) || { ora: null, storico: [] };
  return {
    acceso: stats.code === 0,
    cpu: cpu || "?", memoria: mem || "?", memoriaPerc: memPerc || "?",
    disco: (disco.stdout.split("\t")[0] || "?").trim(),
    lavora: busy.has(id), ora: a.ora, storico: a.storico,
    processi: visibili, file: elenco,
  };
}

async function leggiFile(id, rel) {
  const p = path.posix.normalize("/root/" + String(rel || ""));
  if (!p.startsWith("/root/")) return { error: "percorso non valido" };
  await ensureContainer(id);
  // niente shell: il percorso arriva come argomento, quindi non può eseguire comandi
  const r = await run("docker", ["exec", containerName(id), "head", "-c", "200000", "--", p], { timeout: 15000 });
  if (r.code !== 0) return { error: r.stderr.trim() || "impossibile leggere il file" };
  if (r.stdout.includes("\0")) return { path: p, binario: true };
  return { path: p, testo: r.stdout };
}

async function chat(bot, text, emit) {
  const history = await loadHistory(bot.id);
  history.push({ role: "user", parts: [{ text }] });
  for (let step = 0; step < MAX_STEPS; step++) {
    const content = await gemini(bot, history);
    content.role = "model";
    history.push(content);
    await saveHistory(bot.id, history);
    const calls = content.parts.filter((p) => p.functionCall);
    for (const p of content.parts) if (p.text && !p.thought) emit({ type: "text", text: p.text });
    if (!calls.length) return;
    const responses = [], foto = [];
    for (const { functionCall: fc } of calls) {
      emit({ type: "tool", name: fc.name, args: fc.args || {} });
      segnaAttivita(bot.id, fc.name, fc.args || {});
      const result = await callTool(bot.id, fc.name, fc.args || {}).finally(() => segnaAttivita(bot.id, null));
      const { _foto, ...risposta } = result;
      if (_foto) { risposta.foto = "foto dello schermo allegata"; foto.push(_foto); }
      emit({ type: "tool_result", name: fc.name, result: risposta });
      responses.push({ functionResponse: { name: fc.name, response: risposta } });
    }
    // le foto dello schermo vanno a Gemini come immagini, dopo le risposte degli strumenti
    for (const data of foto.splice(0)) responses.push({ inlineData: { mimeType: "image/jpeg", data } });
    history.push({ role: "user", parts: responses });
    togliVecchieFoto(history);
    await saveHistory(bot.id, history);
  }
  emit({ type: "text", text: "_(Mi fermo qui: troppi passaggi di fila. Scrivimi \"continua\" per proseguire.)_" });
}

// Converte la cronologia Gemini in messaggi per l'interfaccia
function toUi(history) {
  const out = [];
  for (const c of history) {
    for (const p of c.parts || []) {
      if (p.text && !p.thought) out.push({ type: c.role === "user" ? "user" : "text", text: p.text });
      else if (p.functionCall) out.push({ type: "tool", name: p.functionCall.name, args: p.functionCall.args || {} });
      else if (p.functionResponse) out.push({ type: "tool_result", name: p.functionResponse.name, result: p.functionResponse.response });
    }
  }
  return out;
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new Error("troppo grande"); }
  return s ? JSON.parse(s) : {};
}
// ---------- blocco tentativi ----------
// Dopo MAX_TENTATIVI password sbagliate quel dispositivo (indirizzo IP) viene bloccato per sempre.
// Per sbloccare: bash ~/botlab/sblocca.sh sul server.
const MAX_TENTATIVI = Number(process.env.MAX_TENTATIVI || 5);
const BLOCK_FILE = path.join(DATA_DIR, "bloccati.json");
const bloccati = await readJson(BLOCK_FILE, {}); // ip -> { tentativi, bloccato, quando }

function clientIp(req) {
  // Caddy mette l'IP vero del visitatore in X-Forwarded-For
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

function authorized(req) {
  const h = req.headers.authorization || "";
  const given = Buffer.from(h.replace(/^Bearer /, ""));
  const real = Buffer.from(PASSWORD);
  return PASSWORD && given.length === real.length && crypto.timingSafeEqual(given, real);
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let base = PUBLIC_DIR;
  if (rel.startsWith("/novnc/")) { base = NOVNC_DIR; rel = rel.slice("/novnc".length); }
  const file = path.join(base, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(base + path.sep)) return send(res, 403, { error: "no" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "non trovato" });
  }
}

// ---------- schermo in diretta ----------
// Il browser apre una WebSocket verso /schermo/ws?t=BIGLIETTO; il biglietto si ottiene con la password
// e viene girato al server VNC dentro il mini PC del bot (passando da "docker exec", niente porte aperte).
const biglietti = new Map(); // biglietto -> { id, scade }
function nuovoBiglietto(id) {
  for (const [t, b] of biglietti) if (b.scade < Date.now()) biglietti.delete(t);
  const t = crypto.randomBytes(24).toString("hex");
  biglietti.set(t, { id, scade: Date.now() + 12 * 3600 * 1000 });
  return t;
}

function collegaSchermo(req, socket, head) {
  const url = new URL(req.url, "http://x");
  const b = biglietti.get(url.searchParams.get("t") || "");
  if (url.pathname !== "/schermo/ws" || !b || b.scade < Date.now()) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  ensureContainer(b.id).then(() => {
    const child = spawn("docker", ["exec", "-i", containerName(b.id), "socat", "STDIO", "TCP:127.0.0.1:6080"]);
    const righe = [`GET / HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^x-forwarded|^x-real-ip/i.test(req.rawHeaders[i])) righe.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    child.stdin.write(righe.join("\r\n") + "\r\n\r\n");
    if (head?.length) child.stdin.write(head);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    const chiudi = () => { socket.destroy(); child.kill(); };
    socket.on("close", chiudi).on("error", chiudi);
    child.on("exit", chiudi);
    child.stdin.on("error", chiudi);
  }).catch(() => socket.destroy());
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
  const ip = clientIp(req);
  if (bloccati[ip]?.bloccato) return send(res, 403, { error: "Dispositivo bloccato: troppe password sbagliate." });
  if (!authorized(req)) {
    const b = (bloccati[ip] ||= { tentativi: 0 });
    b.tentativi++;
    b.quando = new Date().toISOString();
    if (b.tentativi >= MAX_TENTATIVI) {
      b.bloccato = true;
      console.warn(`Bloccato per sempre ${ip} dopo ${b.tentativi} password sbagliate`);
    }
    await writeJson(BLOCK_FILE, bloccati);
    if (b.bloccato) return send(res, 403, { error: "Dispositivo bloccato: troppe password sbagliate." });
    const restano = MAX_TENTATIVI - b.tentativi;
    return send(res, 401, { error: `Password sbagliata. ${restano === 1 ? "Ultimo tentativo" : `Restano ${restano} tentativi`} prima del blocco.` });
  }
  if (bloccati[ip]) { delete bloccati[ip]; await writeJson(BLOCK_FILE, bloccati); } // password giusta: azzera i tentativi

  try {
    const parts = url.pathname.split("/").filter(Boolean); // api, bots, :id, action
    const bots = await loadBots();

    // aspetto del bot: forma, colore e simbolo (scelti nell'app)
    const FORME = ["cerchio", "squircle", "quadrato", "esagono", "ottagono", "rombo", "goccia", "foglia"];
    const pulisciAvatar = (a = {}) => ({
      forma: FORME.includes(a.forma) ? a.forma : "squircle",
      colore: /^(#[0-9a-f]{6}|[a-z]{3,12})$/i.test(String(a.colore || "")) ? String(a.colore) : "grafite",
      simbolo: [...String(a.simbolo ?? "")].slice(0, 2).join(""),
    });

    if (url.pathname === "/api/ping") return send(res, 200, { ok: true, model: MODEL });

    if (parts[1] === "bots" && parts.length === 2) {
      if (req.method === "GET") return send(res, 200, bots);
      if (req.method === "POST") {
        const { name, instructions, avatar } = await readBody(req);
        if (!name?.trim()) return send(res, 400, { error: "Serve un nome" });
        const bot = { id: crypto.randomBytes(6).toString("hex"), name: name.trim().slice(0, 60), instructions: String(instructions || "").slice(0, 8000), avatar: pulisciAvatar(avatar), created: Date.now() };
        bots.push(bot);
        await saveBots(bots);
        ensureContainer(bot.id).catch((e) => console.error(e));
        return send(res, 200, bot);
      }
    }

    const bot = bots.find((b) => b.id === parts[2]);
    if (parts[1] !== "bots" || !bot) return send(res, 404, { error: "Bot non trovato" });
    const action = parts[3];

    if (!action && req.method === "PATCH") {
      const { name, instructions, avatar } = await readBody(req);
      if (name !== undefined) {
        if (!String(name).trim()) return send(res, 400, { error: "Serve un nome" });
        bot.name = String(name).trim().slice(0, 60);
      }
      if (instructions !== undefined) bot.instructions = String(instructions).slice(0, 8000);
      if (avatar !== undefined) bot.avatar = pulisciAvatar(avatar);
      await saveBots(bots);
      return send(res, 200, bot);
    }
    if (!action && req.method === "DELETE") {
      for (const [t, b] of biglietti) if (b.id === bot.id) biglietti.delete(t);
      await run("docker", ["rm", "-f", containerName(bot.id)]);
      await fs.rm(histFile(bot.id), { force: true });
      await saveBots(bots.filter((b) => b.id !== bot.id));
      return send(res, 200, { ok: true });
    }
    if (action === "messages" && req.method === "GET") return send(res, 200, toUi(await loadHistory(bot.id)));
    if (action === "reset" && req.method === "POST") {
      await fs.rm(histFile(bot.id), { force: true });
      return send(res, 200, { ok: true });
    }
    if (action === "pc" && req.method === "GET") return send(res, 200, await statoPc(bot.id));
    if (action === "schermo" && req.method === "POST") {
      await ensureContainer(bot.id);
      return send(res, 200, { biglietto: nuovoBiglietto(bot.id) });
    }
    if (action === "file" && req.method === "GET") return send(res, 200, await leggiFile(bot.id, url.searchParams.get("path")));
    if (action === "exec" && req.method === "POST") {
      const { command } = await readBody(req);
      return send(res, 200, await execInBot(bot.id, String(command || ""), 120));
    }
    if (action === "chat" && req.method === "POST") {
      const { text } = await readBody(req);
      if (!text?.trim()) return send(res, 400, { error: "Messaggio vuoto" });
      if (busy.has(bot.id)) return send(res, 409, { error: "Il bot sta già lavorando" });
      busy.add(bot.id);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      const emit = (ev) => res.write(JSON.stringify(ev) + "\n");
      try {
        await chat(bot, text.trim(), emit);
      } catch (e) {
        emit({ type: "error", error: String(e.message || e) });
      } finally {
        busy.delete(bot.id);
        emit({ type: "done" });
        res.end();
      }
      return;
    }
    send(res, 404, { error: "Richiesta sconosciuta" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
});

if (!PASSWORD || !GEMINI_KEY) console.warn("ATTENZIONE: BOTLAB_PASSWORD o GEMINI_API_KEY mancanti nel file .env");
server.on("upgrade", collegaSchermo);
server.listen(PORT, () => console.log(`BotLab in ascolto sulla porta ${PORT} (modello ${MODEL})`));
