// WhatsApp transport built on Baileys: a direct implementation of the
// WhatsApp Web WebSocket protocol. No Chromium, no Puppeteer, no page to
// inject into. The whole client is a single Node process of ~100MB.
//
// Session credentials live in AUTH_DIR (bind-mounted). They are a linked
// *device*: never copy them to a second machine.
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getReceivers } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "..", "auth");
const SEND_GAP_MS = Number(process.env.SEND_GAP_MS || 1500);
// How long a queued alert waits for the connection before being dropped.
const READY_WAIT_MS = Number(process.env.READY_WAIT_MS || 5 * 60_000);
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 60_000);
// Baileys reconnects on its own with backoff; this is the backstop if it never
// gets back to "open" - exit and let Docker restart the container.
const UNHEALTHY_EXIT_MS = Number(process.env.UNHEALTHY_EXIT_MS || 10 * 60_000);
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_MEM_MB = Number(process.env.MAX_MEM_MB || 0); // 0 = disabled
const MEM_STRIKES_BEFORE_EXIT = Number(process.env.MEM_STRIKES_BEFORE_EXIT || 3);

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" });

let sock = null;
export let ready = false;
export let qrGenerated = false;
let connectedAs = null;
let lastHealthyAt = Date.now();
let shuttingDown = false;
let connecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let reconnectAllowed = true;

export function healthSnapshot() {
  return {
    ready,
    qrGenerated,
    connectedAs,
    unhealthyForSeconds: ready ? 0 : Math.round((Date.now() - lastHealthyAt) / 1000),
    memoryMB: lastMemMB,
    memoryLimitMB: MAX_MEM_MB || null,
    queued: queueDepth
  };
}

// ------------------------
// Connection
// ------------------------

async function connect() {
  if (shuttingDown || connecting) return;
  connecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // Falls back to the bundled version if the lookup fails (offline).
    const { version } = await fetchLatestBaileysVersion();

    // Drop any previous socket before creating a new one, or its listeners
    // keep firing alongside the new socket ("QR storm" symptom).
    if (sock) {
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
        sock.end(undefined);
      } catch { /* already dead */ }
      sock = null;
    }

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", onConnectionUpdate);
  } finally {
    connecting = false;
  }
}

function onConnectionUpdate({ connection, lastDisconnect, qr }) {
  if (qr) {
    qrGenerated = true;
    ready = false;
    console.log("\n📱 SCAN QR CODE:\n");
    qrcode.generate(qr, { small: true });
  }

  if (connection === "connecting") {
    console.log("🔌 Connecting to WhatsApp...");
  }

  if (connection === "open") {
    ready = true;
    qrGenerated = false;
    reconnectAttempts = 0;
    lastHealthyAt = Date.now();
    connectedAs = sock?.user?.id?.split(":")[0] || null;
    console.log(`✅ WhatsApp connected as ${connectedAs}`);
  }

  if (connection === "close") {
    ready = false;
    const code = lastDisconnect?.error?.output?.statusCode;
    const reason = DisconnectReason[code] || code || "unknown";
    console.log(`⚠️ WhatsApp connection closed (${reason})`);

    if (code === DisconnectReason.loggedOut) {
      // WhatsApp invalidated the session (unlinked from the phone, or banned).
      // Clear it so the next connect produces a QR instead of looping.
      console.error("❌ Session logged out by WhatsApp - a fresh QR scan is required");
      clearAuthDir();
      scheduleReconnect(0);
    } else if (code === DisconnectReason.connectionReplaced) {
      // Another machine is using these credentials. Reconnecting would just
      // fight it. Stop and say so.
      reconnectAllowed = false;
      console.error("❌ Another instance took over this session. Stop the other machine, then restart this container.");
    } else if (code === DisconnectReason.restartRequired) {
      // Normal right after pairing: WhatsApp asks for one reconnect.
      scheduleReconnect(0);
    } else {
      scheduleReconnect();
    }
  }
}

function scheduleReconnect(delayMs) {
  if (shuttingDown || !reconnectAllowed || reconnectTimer) return;
  const wait = delayMs ?? Math.min(MAX_RECONNECT_DELAY_MS, 3_000 * (reconnectAttempts + 1));
  reconnectAttempts++;
  if (wait > 0) console.log(`🔁 Reconnecting in ${wait / 1000}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(err => {
      console.error("❌ Connect failed:", err.message);
      scheduleReconnect();
    });
  }, wait);
}

// AUTH_DIR is a bind mount, so the directory itself cannot be removed -
// empty it instead.
function clearAuthDir() {
  try {
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
    }
  } catch (err) {
    console.error("⚠️ Could not clear auth dir:", err.message);
  }
}

// ------------------------
// Send queue
// ------------------------
// Every webhook funnels through one chain, so the SEND_GAP_MS pacing holds even
// when a real outage makes Uptime Kuma fire many webhooks at once.
let sendQueue = Promise.resolve();
let queueDepth = 0;

export function enqueueSend(hostname, message) {
  queueDepth++;
  sendQueue = sendQueue
    .then(() => sendMessageToReceivers(hostname, message))
    .catch(err => console.error("❌ Queued send failed:", hostname, err.message))
    .finally(() => { queueDepth--; });
  return sendQueue;
}

export function pendingSends() {
  return queueDepth;
}

function waitForReady(timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (ready) { clearInterval(poll); resolve(true); }
      else if (shuttingDown || Date.now() - started > timeoutMs) { clearInterval(poll); resolve(false); }
    }, 2000);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function sendMessageToReceivers(hostname, message) {
  const receivers = getReceivers(hostname);

  if (!receivers.length) {
    console.log("⚠️ No receivers for:", hostname);
    return;
  }

  if (!ready) {
    console.log(`⏳ WhatsApp not connected - holding alert for ${hostname}`);
    const becameReady = await waitForReady(READY_WAIT_MS);
    if (!becameReady) {
      console.error(`❌ Gave up waiting for WhatsApp - alert dropped for ${hostname}`);
      return;
    }
  }

  for (const number of receivers) {
    // Accept "91xxxxxxxxxx", "91xxxxxxxxxx@c.us" (old format) or a full JID.
    const digits = String(number).replace(/@.*$/, "").replace(/\D/g, "");

    try {
      const [lookup] = await sock.onWhatsApp(digits);
      if (!lookup?.exists) {
        console.log("❌ Not registered on WhatsApp:", digits);
        continue;
      }

      const sent = await sock.sendMessage(lookup.jid, { text: message });
      console.log(`✅ Sent to ${digits} (ID: ${sent?.key?.id || "unknown_id"})`);
    } catch (err) {
      console.error("❌ Send failed", digits, err.message);
    }

    await sleep(SEND_GAP_MS);
  }
}

// ------------------------
// Watchdogs
// ------------------------

function readStatField(file, field) {
  try {
    const line = fs.readFileSync(file, "utf8").split("\n").find(l => l.startsWith(field + " "));
    const value = line ? Number(line.split(/\s+/)[1]) : NaN;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

// Container memory minus reclaimable page cache, as `docker stats` reports it.
function containerMemoryMB() {
  const sources = [
    { usage: "/sys/fs/cgroup/memory.current", stat: "/sys/fs/cgroup/memory.stat", field: "inactive_file" },
    { usage: "/sys/fs/cgroup/memory/memory.usage_in_bytes", stat: "/sys/fs/cgroup/memory/memory.stat", field: "total_inactive_file" }
  ];
  for (const { usage, stat, field } of sources) {
    try {
      const total = Number(fs.readFileSync(usage, "utf8").trim());
      if (!Number.isFinite(total) || total <= 0) continue;
      return Math.round(Math.max(total - readStatField(stat, field), 0) / 1024 / 1024);
    } catch { /* try the next one */ }
  }
  return null;
}

let memStrikes = 0;
let lastMemMB = null;

function livenessTick() {
  if (shuttingDown) return;

  if (ready || qrGenerated) {
    // Connected, or waiting on a human to scan - neither is a fault.
    lastHealthyAt = Date.now();
    return;
  }

  const downMs = Date.now() - lastHealthyAt;
  if (downMs > UNHEALTHY_EXIT_MS) {
    console.error(`❌ WhatsApp disconnected for ${Math.round(downMs / 1000)}s - exiting for a container restart`);
    process.exit(1);
  }
}

function memoryTick() {
  lastMemMB = containerMemoryMB();
  if (lastMemMB === null || !MAX_MEM_MB) return;

  if (lastMemMB < MAX_MEM_MB) {
    memStrikes = 0;
    return;
  }

  memStrikes++;
  console.log(`⚠️ Memory ${lastMemMB}MB over limit ${MAX_MEM_MB}MB (strike ${memStrikes}/${MEM_STRIKES_BEFORE_EXIT})`);
  if (memStrikes < MEM_STRIKES_BEFORE_EXIT) return;
  if (queueDepth > 0) {
    console.log("⏳ Holding restart - alerts still queued");
    return;
  }
  console.error(`❌ Memory ${lastMemMB}MB - exiting for a container restart`);
  process.exit(1);
}

// ------------------------
// Lifecycle
// ------------------------

export function initWhatsApp() {
  connect().catch(err => {
    console.error("❌ Initial connect failed:", err.message);
    scheduleReconnect();
  });
  setInterval(() => { livenessTick(); memoryTick(); }, WATCHDOG_INTERVAL_MS).unref();
}

export async function closeWhatsApp() {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    // end(), not logout(): logout would invalidate the session on the
    // WhatsApp side and force a QR re-scan on the next start.
    sock?.end(undefined);
    console.log("✅ WhatsApp connection closed");
  } catch (e) {
    console.log("⚠️ Error closing connection:", e.message);
  }
}
