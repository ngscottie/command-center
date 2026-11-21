// Command Center WhatsApp reader.
// Keeps one linked-device session per connected owner (like WhatsApp Web) and forwards
// recent chat messages to the Command Center API. Read-only: it never sends messages.
import makeWASocket, { DisconnectReason, initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, isJidGroup } from "baileys";
import pino from "pino";

const API = process.env.API_URL || "https://dxuwfxtgjpefmoadwuuu.supabase.co/functions/v1/api";
const SECRET = process.env.WORKER_SECRET;
if (!SECRET) { console.error("WORKER_SECRET is not set"); process.exit(1); }
const log = pino({ level: "warn" });
const DAYS = 4;

async function call(op, body = {}) {
  const r = await fetch(`${API}/wa/worker/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-worker": SECRET }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${op} ${r.status}`);
  return r.json();
}

// Auth state kept in the API (one JSON blob per link), saved a moment after each change.
async function loadAuth(id) {
  const { auth } = await call("auth/get", { id });
  const data = auth ? JSON.parse(auth, BufferJSON.reviver) : { creds: initAuthCreds(), keys: {} };
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => call("auth/set", { id, auth: JSON.stringify({ creds: data.creds, keys: data.keys }, BufferJSON.replacer) }).catch(e => console.error("save auth", id, e.message)), 1500); };
  const keys = {
    get: async (type, ids) => {
      const out = {};
      for (const k of ids) {
        let v = data.keys[type]?.[k];
        if (v && type === "app-state-sync-key") v = proto.Message.AppStateSyncKeyData.fromObject(v);
        if (v) out[k] = v;
      }
      return out;
    },
    set: async (d) => {
      for (const type in d) { data.keys[type] ||= {}; for (const k in d[type]) { if (d[type][k]) data.keys[type][k] = d[type][k]; else delete data.keys[type][k]; } }
      save();
    },
  };
  return { state: { creds: data.creds, keys: makeCacheableSignalKeyStore(keys, log) }, save };
}

function textOf(m) {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption
    || inner.documentMessage?.caption || (inner.imageMessage ? "(sent a photo)" : "") || (inner.audioMessage ? "(sent a voice message)" : "")
    || (inner.documentMessage ? "(sent a file)" : "") || (inner.locationMessage ? "(shared a location)" : "") || "";
}

const running = new Map(); // link id -> { sock, stop }

async function start(link) {
  if (running.has(link.id)) return;
  const entry = { stopped: false, sock: null };
  running.set(link.id, entry);
  try {
    const { state, save } = await loadAuth(link.id);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({ auth: state, version, logger: log, browser: Browsers.macOS("Command Center"), markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false });
    entry.sock = sock;
    const names = new Map();
    const chatName = async (jid, pushName) => {
      if (names.has(jid)) return names.get(jid);
      let n = pushName || "+" + jid.split("@")[0];
      if (isJidGroup(jid)) { try { n = (await sock.groupMetadata(jid)).subject || n; } catch { /* keep number */ } }
      names.set(jid, n); return n;
    };
    const since = () => Date.now() / 1000 - DAYS * 86400;
    const forward = async (msgs) => {
      const rows = [];
      for (const m of msgs) {
        const jid = m.key?.remoteJid; if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
        const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0); if (!ts || ts < since()) continue;
        const text = textOf(m); if (!text) continue;
        const name = await chatName(jid, isJidGroup(jid) ? undefined : (m.key.fromMe ? undefined : m.pushName));
        rows.push({ chat_id: jid, chat_name: name, ext_id: m.key.id, sender: m.key.fromMe ? "" : (m.pushName || name), is_self: !!m.key.fromMe, text, ts });
      }
      for (let i = 0; i < rows.length; i += 200) await call("messages", { id: link.id, messages: rows.slice(i, i + 200) }).catch(e => console.error("messages", link.id, e.message));
    };
    sock.ev.on("creds.update", save);
    sock.ev.on("messages.upsert", ({ messages }) => forward(messages));
    sock.ev.on("messaging-history.set", ({ messages }) => forward(messages || []));
    sock.ev.on("connection.update", async (u) => {
      if (u.qr) await call("update", { id: link.id, status: "qr", qr: u.qr }).catch(() => {});
      if (u.connection === "open") await call("update", { id: link.id, status: "connected", qr: null, phone: sock.user?.id || "", error: null }).catch(() => {});
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        running.delete(link.id);
        if (entry.stopped) return;
        if (code === DisconnectReason.loggedOut) { await call("update", { id: link.id, status: "logged_out", error: "Signed out from the phone" }).catch(() => {}); await call("auth/set", { id: link.id, auth: "" }).catch(() => {}); }
        else setTimeout(() => start(link).catch(() => {}), 3000);
      }
    });
  } catch (e) {
    console.error("start", link.id, e.message);
    running.delete(link.id);
  }
}

async function loop() {
  try {
    const { links } = await call("poll");
    const ids = new Set(links.map(l => l.id));
    for (const l of links) if (!running.has(l.id)) start(l);
    for (const [id, e] of running) if (!ids.has(id)) { e.stopped = true; try { await e.sock?.logout(); } catch { /* already gone */ } try { e.sock?.end(); } catch { /* ignore */ } running.delete(id); }
    // keep QR screens fresh: links waiting for a scan with no live socket get restarted by the loop above
  } catch (e) { console.error("poll", e.message); }
}
setInterval(loop, 5000); loop();
// tiny health endpoint for the host
import("node:http").then(({ createServer }) => createServer((_, res) => { res.end("ok " + running.size); }).listen(process.env.PORT || 8080));
console.log("Command Center WhatsApp reader running");
