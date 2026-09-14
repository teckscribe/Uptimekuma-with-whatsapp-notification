import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST_MAP_PATH = path.join(__dirname, "..", "host_map.json");

let HOST_MAP = {};

export function loadHostMap() {
  try {
    HOST_MAP = JSON.parse(fs.readFileSync(HOST_MAP_PATH, "utf8"));
    console.log("✅ host_map.json loaded");
  } catch (err) {
    console.error("❌ host_map.json load failed:", err.message);
    HOST_MAP = {};
  }
}

export function watchHostMap() {
  loadHostMap();
  fs.watchFile(HOST_MAP_PATH, () => {
    console.log("📁 host_map.json changed → reloading");
    loadHostMap();
  });
}

export function getReceivers(hostname) {
  if (!hostname) return HOST_MAP["default"] || [];

  const cleanHost = hostname.trim().toLowerCase();
  const normalizedMap = {};

  for (const key in HOST_MAP) {
    normalizedMap[key.trim().toLowerCase()] = HOST_MAP[key];
  }

  return normalizedMap[cleanHost] || HOST_MAP["default"] || [];
}

export function cleanProfileLocks() {
  const authPath = path.join(__dirname, "..", "wwebjs_auth");

  if (!fs.existsSync(authPath)) {
    console.log("ℹ️ No auth folder yet");
    return;
  }

  const lockPatterns = [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort"
  ];

  function cleanDir(dir) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });

      for (const item of items) {
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
          cleanDir(fullPath);
        } else if (lockPatterns.some(p => item.name.includes(p))) {
          try {
            fs.unlinkSync(fullPath);
            console.log("🔓 Removed lock:", fullPath);
          } catch (e) {
            console.log("⚠️ Could not remove:", fullPath, e.message);
          }
        }
      }
    } catch (e) {
      console.log("ℹ️ Could not read:", dir);
    }
  }

  cleanDir(authPath);
  console.log("✅ Lock file cleanup complete");
}
