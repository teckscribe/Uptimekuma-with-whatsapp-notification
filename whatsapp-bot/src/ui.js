import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UI_PORT = process.env.UI_PORT || 3002;
const HOST_MAP_PATH = process.env.HOST_MAP_PATH || "/app/config/host_map.json";
const BOT_API_URL = process.env.BOT_API_URL || "http://whatsapp-bot:3000";

const app = express();
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

async function callBotApi(endpoint, method = "GET") {
  const candidates = [BOT_API_URL, "http://127.0.0.1:3000"];
  let lastError = null;
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Could not reach whatsapp-bot service");
}

// ------------------------
// File Helpers
// ------------------------

function readHostMap() {
  try {
    if (!fs.existsSync(HOST_MAP_PATH)) {
      const defaultData = { default: [] };
      fs.writeFileSync(HOST_MAP_PATH, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    return JSON.parse(fs.readFileSync(HOST_MAP_PATH, "utf8"));
  } catch (err) {
    console.error("Read error:", err);
    return {};
  }
}

function saveHostMap(data) {
  try {
    const cleaned = {};

    for (const [host, numbers] of Object.entries(data)) {
      if (!Array.isArray(numbers)) continue;

      cleaned[host] = numbers
        .map(n => String(n).replace("@c.us", "").replace(/\D/g, ""))
        .filter(n => n.length > 5);
    }

    if (!cleaned.default) cleaned.default = [];

    fs.writeFileSync(HOST_MAP_PATH, JSON.stringify(cleaned, null, 2));
    return { success: true };

  } catch (err) {
    return { error: err.message };
  }
}

// ------------------------
// API
// ------------------------

app.get("/api/hosts", (req, res) => {
  res.json(readHostMap());
});

app.post("/api/hosts", (req, res) => {
  const result = saveHostMap(req.body);
  if (result.error) {
    res.status(400).json(result);
  } else {
    res.json({ status: "saved" });
  }
});

app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const data = await callBotApi("/whatsapp/status", "GET");
    res.json(data);
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: `Cannot reach whatsapp-bot container (${err.message})`,
      qr_available: false,
      qr_data_url: null
    });
  }
});

app.post("/api/whatsapp/start-login", async (req, res) => {
  try {
    const data = await callBotApi("/whatsapp/start-login", "POST");
    res.json(data);
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: `Cannot reach whatsapp-bot container (${err.message})`,
      qr_available: false,
      qr_data_url: null
    });
  }
});

app.post("/api/whatsapp/cancel-login", async (req, res) => {
  try {
    const data = await callBotApi("/whatsapp/cancel-login", "POST");
    res.json(data);
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: `Cannot reach whatsapp-bot container (${err.message})`,
      qr_available: false,
      qr_data_url: null
    });
  }
});

app.post("/api/whatsapp/logout", async (req, res) => {
  try {
    const data = await callBotApi("/whatsapp/logout", "POST");
    res.json(data);
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: `Cannot reach whatsapp-bot container (${err.message})`,
      qr_available: false,
      qr_data_url: null
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    fileExists: fs.existsSync(HOST_MAP_PATH)
  });
});

// ------------------------

app.listen(UI_PORT, "0.0.0.0", () => {
  console.log(`📊 UI running on http://0.0.0.0:${UI_PORT}`);
});

