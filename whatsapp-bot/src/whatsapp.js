import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { cleanProfileLocks, getReceivers } from "./utils.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEND_GAP_MS = Number(process.env.SEND_GAP_MS || 1500);
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 60_000);
const UNHEALTHY_EXIT_MS = Number(process.env.UNHEALTHY_EXIT_MS || 10 * 60_000);
// After a fresh QR scan WhatsApp Web does a full initial sync before the client
// becomes usable. That can take far longer than UNHEALTHY_EXIT_MS, so the
// watchdog gets a longer leash until the first `ready` of this process.
const INITIAL_SYNC_GRACE_MS = Number(process.env.INITIAL_SYNC_GRACE_MS || 30 * 60_000);
// How long a queued alert waits for the client to become ready before giving up.
const READY_WAIT_MS = Number(process.env.READY_WAIT_MS || 15 * 60_000);
const REINIT_DELAY_MS = 10_000;

// Memory guard. Chromium's WhatsApp Web renderer grows steadily over days; when the
// container's total footprint stays above MAX_MEM_MB we exit so Docker restarts us.
// The session lives in wwebjs_auth, so a restart costs ~30s and no QR re-scan.
// V8 heap cap for the WhatsApp Web renderer. 0 (default) = no cap. A cap
// saves a little in steady state but a fresh-link sync of a real account can
// exceed it, and when V8 hits the ceiling it aborts the renderer: the page
// reloads, the sync restarts from zero, and the bot never reaches ready.
const RENDERER_HEAP_MB = Number(process.env.RENDERER_HEAP_MB || 0);
const MAX_MEM_MB = Number(process.env.MAX_MEM_MB || 0); // 0 = disabled
const MEM_STRIKES_BEFORE_EXIT = Number(process.env.MEM_STRIKES_BEFORE_EXIT || 3);
const PROTOCOL_TIMEOUT_MS = Number(process.env.PROTOCOL_TIMEOUT_MS || 300_000);

export const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, "..", "wwebjs_auth"),
    clientId: "whatsapp-webhook-client"
  }),
  puppeteer: {
    headless: true,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      ...(RENDERER_HEAP_MB > 0 ? [`--js-flags=--max-old-space-size=${RENDERER_HEAP_MB}`] : []),
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-accelerated-2d-canvas",
      "--disable-backgrounding-occluded-windows",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium"
  }
});

export let qrGenerated = false;
export let ready = false;
let everReady = false;
let lastHealthyAt = Date.now();
let shuttingDown = false;

export function healthSnapshot() {
  return {
    ready,
    qrGenerated,
    unhealthyForSeconds: ready ? 0 : Math.round((Date.now() - lastHealthyAt) / 1000),
    memoryMB: lastMemMB,
    memoryLimitMB: MAX_MEM_MB || null,
    queued: queueDepth
  };
}

client.on("qr", qr => {
  qrGenerated = true;
  ready = false;
  console.log("\n📱 SCAN QR CODE:\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated");
  qrGenerated = false;
  // Sync starts now. Give it the full grace window from this point.
  lastHealthyAt = Date.now();
  if (!everReady) console.log("⏳ Waiting for WhatsApp Web to finish syncing — this can take several minutes on a fresh link");
});

client.on("auth_failure", msg => {
  console.error("❌ WhatsApp auth failure:", msg);
  ready = false;
  // The stored session is no longer valid — a fresh QR scan is required.
  // Re-initialize so the QR is emitted to the logs instead of sitting idle.
  scheduleReinit();
});

client.on("ready", () => {
  console.log("✅ WhatsApp client READY");
  ready = true;
  everReady = true;
  qrGenerated = false;
  lastHealthyAt = Date.now();
});

client.on("disconnected", reason => {
  console.log("⚠️ WhatsApp disconnected — reconnecting...", reason || "");
  ready = false;
  scheduleReinit();
});

// `disconnected` and `auth_failure` can both fire for one event. Two overlapping
// initialize() calls launch two Chromiums on the same profile, which never
// reaches `ready`. Coalesce them so only one reinit is ever pending.
let reinitTimer = null;

function scheduleReinit() {
  if (shuttingDown) return;
  if (reinitTimer) {
    console.log("ℹ️ Reinit already scheduled — skipping duplicate");
    return;
  }
  cleanProfileLocks();
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    safeInitialize();
  }, REINIT_DELAY_MS);
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

export async function sendMessageToReceivers(hostname, message) {
  const receivers = getReceivers(hostname);

  if (!receivers.length) {
    console.log("⚠️ No receivers for:", hostname);
    return;
  }

  if (!ready) {
    // Sending before `ready` fails with "Cannot read properties of undefined
    // (reading 'getChat')" — the page helpers aren't injected yet. Hold the
    // alert until the client is usable rather than dropping it.
    console.log(`⏳ WhatsApp not ready — holding alert for ${hostname}`);
    const becameReady = await waitForReady(READY_WAIT_MS);
    if (!becameReady) {
      console.error(`❌ Gave up waiting for WhatsApp — alert dropped for ${hostname}`);
      return;
    }
  }

  for (const number of receivers) {
    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;

    try {
      const isRegistered = await client.isRegisteredUser(chatId);

      if (!isRegistered) {
        console.log("❌ Not registered:", chatId);
        continue;
      }

      const response = await client.sendMessage(chatId, message, { sendSeen: false });
      const msgId = response?.id?.id || "unknown_id";
      console.log(`✅ Sent to ${chatId} (ID: ${msgId})`);
    } catch (err) {
      if (err.message && err.message.includes('markedUnread')) {
        console.log(`✅ Sent to ${chatId} (Success, but ignored known WhatsApp Web parsing bug)`);
      } else {
        console.error("❌ Send failed", chatId, err.message);
      }
    }

    await new Promise(r => setTimeout(r, SEND_GAP_MS));
  }
}

// ------------------------
// Init + watchdog
// ------------------------

// Container-wide memory, which includes every Chromium process. cgroup v2 first,
// v1 as a fallback; returns null when neither is readable (e.g. running outside Docker).
//
// The raw usage counter includes reclaimable page cache, which the kernel drops
// under pressure and is not memory our processes actually hold. Subtract
// inactive_file, the same way `docker stats` reports it, or a busy filesystem
// looks like a leak.
function readStatField(file, field) {
  try {
    const line = fs.readFileSync(file, "utf8")
      .split("\n")
      .find(l => l.startsWith(field + " "));
    const value = line ? Number(line.split(/\s+/)[1]) : NaN;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function containerMemoryMB() {
  const sources = [
    { usage: "/sys/fs/cgroup/memory.current", stat: "/sys/fs/cgroup/memory.stat", field: "inactive_file" },
    { usage: "/sys/fs/cgroup/memory/memory.usage_in_bytes", stat: "/sys/fs/cgroup/memory/memory.stat", field: "total_inactive_file" }
  ];

  for (const { usage, stat, field } of sources) {
    try {
      const total = Number(fs.readFileSync(usage, "utf8").trim());
      if (!Number.isFinite(total) || total <= 0) continue;
      const cache = readStatField(stat, field);
      return Math.round(Math.max(total - cache, 0) / 1024 / 1024);
    } catch { /* try the next one */ }
  }
  return null;
}

let memStrikes = 0;
let lastMemMB = null;

export function memoryMB() {
  return lastMemMB;
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

function safeInitialize() {
  if (shuttingDown) return;
  client.initialize().catch(err => {
    console.error(`❌ initialize failed: ${err.message} — restarting container in 5s`);
    ready = false;
    cleanProfileLocks();
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  });
}

// The common failure mode is Node staying alive while the Puppeteer session dies,
// which `restart: unless-stopped` cannot see. Poll the real state and exit if it
// stays bad, so Docker restarts us.
async function watchdogTick() {
  if (shuttingDown) return;

  if (qrGenerated) {
    // Waiting on a human to scan — not a fault, don't restart out from under them.
    lastHealthyAt = Date.now();
    return;
  }

  try {
    const state = await client.getState();
    if (state === "CONNECTED") {
      // Connected is not the same as usable: the page helpers that sending
      // depends on are only injected when the `ready` event fires. Refresh the
      // health clock here, but leave `ready` to that event.
      lastHealthyAt = Date.now();
      return;
    }
    console.log("⚠️ WhatsApp state:", state);
  } catch (err) {
    console.log("⚠️ Watchdog could not read state:", err.message);
  }

  ready = false;
  const downMs = Date.now() - lastHealthyAt;
  const limitMs = everReady ? UNHEALTHY_EXIT_MS : INITIAL_SYNC_GRACE_MS;
  if (downMs > limitMs) {
    console.error(`❌ WhatsApp unhealthy for ${Math.round(downMs / 1000)}s — exiting for a container restart`);
    process.exit(1);
  }
}

function memoryTick() {
  lastMemMB = containerMemoryMB();
  if (lastMemMB === null || !MAX_MEM_MB) return;

  // A fresh link pulls the whole account down and peaks well above steady
  // state. Restarting for memory during that window just restarts the sync.
  // Leave it to the hard mem_limit until the first `ready`.
  if (!everReady) {
    memStrikes = 0;
    return;
  }

  if (lastMemMB < MAX_MEM_MB) {
    memStrikes = 0;
    return;
  }

  memStrikes++;
  console.log(`⚠️ Memory ${lastMemMB}MB over limit ${MAX_MEM_MB}MB (strike ${memStrikes}/${MEM_STRIKES_BEFORE_EXIT})`);

  if (memStrikes < MEM_STRIKES_BEFORE_EXIT) return;
  if (queueDepth > 0) {
    console.log("⏳ Holding restart — alerts still queued");
    return;
  }

  console.error(`❌ Memory ${lastMemMB}MB — exiting for a container restart`);
  process.exit(1);
}

export function initWhatsApp() {
  safeInitialize();
  const timer = setInterval(() => { watchdogTick(); memoryTick(); }, WATCHDOG_INTERVAL_MS);
  timer.unref();
}

export async function closeWhatsApp() {
  shuttingDown = true;
  try {
    await client.destroy();
    console.log("✅ WhatsApp client closed");
  } catch (e) {
    console.log("⚠️ Error closing client:", e.message);
  }
}
