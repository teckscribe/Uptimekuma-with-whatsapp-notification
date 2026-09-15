import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The routing table lives in a bind-mounted config directory (not a
// bind-mounted file) so a fresh clone can start before the real map is in
// place, and a backup can be dropped in at any time without touching Docker.
export const HOST_MAP_PATH = process.env.HOST_MAP_PATH || "/app/config/host_map.json";
const HOST_MAP_EXAMPLE = path.join(path.dirname(HOST_MAP_PATH), "host_map.example.json");

let HOST_MAP = {};

// First run on a fresh clone: no real map yet. Seed from the example so the
// bot starts, and say so loudly — the example numbers are placeholders.
function ensureHostMap() {
  if (fs.existsSync(HOST_MAP_PATH)) return;
  try {
    if (fs.existsSync(HOST_MAP_EXAMPLE)) {
      fs.copyFileSync(HOST_MAP_EXAMPLE, HOST_MAP_PATH);
      console.warn(`⚠️ No host_map.json found — seeded from example. Replace ${HOST_MAP_PATH} with your real routing table.`);
    } else {
      fs.writeFileSync(HOST_MAP_PATH, JSON.stringify({ default: [] }, null, 2));
      console.warn(`⚠️ No host_map.json found — created an empty one at ${HOST_MAP_PATH}.`);
    }
  } catch (err) {
    console.error("❌ Could not create host_map.json:", err.message);
  }
}

export function loadHostMap() {
  try {
    HOST_MAP = JSON.parse(fs.readFileSync(HOST_MAP_PATH, "utf8"));
    console.log(`✅ host_map.json loaded (${Object.keys(HOST_MAP).length} entries)`);
  } catch (err) {
    console.error("❌ host_map.json load failed:", err.message);
    HOST_MAP = {};
  }
}

export function watchHostMap() {
  ensureHostMap();
  loadHostMap();
  // watchFile polls, so it also picks up a file that is replaced wholesale
  // (e.g. a backup copied over the top), not just edited in place.
  fs.watchFile(HOST_MAP_PATH, { interval: 5000 }, () => {
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
