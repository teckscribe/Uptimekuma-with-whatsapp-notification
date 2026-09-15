import express from "express";
import { watchHostMap } from "./utils.js";
import { initWhatsApp, closeWhatsApp, enqueueSend, healthSnapshot } from "./whatsapp.js";

const PORT = process.env.PORT || 3000;
const HOOK_TOKEN = process.env.HOOK_TOKEN || "change_this_token";

// Uptime Kuma heartbeat status codes
const STATUS = { 0: "DOWN", 1: "UP", 2: "PENDING", 3: "MAINTENANCE" };
// Only these produce a WhatsApp alert. PENDING is a retry window and MAINTENANCE is
// planned — alerting on either sends false "power failure" messages to field staff.
const ALERT_ON = new Set(["UP", "DOWN"]);

const app = express();
app.use(express.json());

// Initialize systems
watchHostMap();
initWhatsApp();

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n⚠️ Received ${signal}, shutting down gracefully...`);
  await closeWhatsApp();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

function getHostname(body) {
  return (
    body.monitor?.name ||
    body.monitor?.hostname ||
    body.monitor?.url ||
    "UNKNOWN"
  ).trim();
}

// Uptime Kuma sends heartbeat.time as UTC "YYYY-MM-DD HH:mm:ss.SSS".
// Use it rather than the current clock, so a delayed or retried webhook still
// reports when the outage actually happened.
function heartbeatDate(heartbeat) {
  const raw = heartbeat?.time;
  if (!raw) return new Date();
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Message format
function formatKSEBMessage(hostname, statusText, heartbeat) {
  const emoji = statusText === "UP" ? "🟢" : "🛑";

  const time = heartbeatDate(heartbeat).toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  return `KSEB Power ${statusText} ${emoji} at ${hostname}\n${time}`;
}

// Webhook endpoint
app.post("/uptime-kuma", (req, res) => {
  const token = req.headers["x-hook-token"];

  if (token !== HOOK_TOKEN) {
    console.log("❌ Unauthorized webhook attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body;
    const hostname = getHostname(body);
    const statusText = STATUS[body.heartbeat?.status] ?? "UNKNOWN";

    if (!ALERT_ON.has(statusText)) {
      console.log(`ℹ️ Ignoring ${statusText} for ${hostname}`);
      return res.json({ ok: true, skipped: statusText });
    }

    // Hand off to the send queue; the reply doesn't wait on WhatsApp.
    enqueueSend(hostname, formatKSEBMessage(hostname, statusText, body.heartbeat));

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Error" });
    }
  }
});

// Health check
app.get("/health", (req, res) => {
  const snapshot = healthSnapshot();
  res.json({
    status: snapshot.ready ? "ok" : "degraded",
    whatsappReady: snapshot.ready,
    ...snapshot,
    time: new Date().toISOString()
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🤖 Bot running on port ${PORT}`);
});
