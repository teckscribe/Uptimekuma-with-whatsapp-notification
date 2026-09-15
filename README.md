# Docker Stack: Uptime Kuma + WhatsApp Incident Alerting

A containerized power and network infrastructure monitoring stack with automated real-time incident alerting via WhatsApp.

---

## Architecture Overview

- **`uptime-kuma` (Port 3001)**: Official image pinned to `2.0.2`. Probes network devices and power status via ICMP Ping and HTTP. Alerts are dispatched via webhooks.
- **`whatsapp-bot` (Port 3000)**: Headless WhatsApp Web client (via Puppeteer & Chromium) that receives Uptime Kuma webhooks, formats incident timestamps in Indian Standard Time (`Asia/Kolkata`), and sends alerts sequentially with queue flood protection.
- **`whatsapp-ui` (Port 3002)**: Web dashboard for operations teams to dynamically configure which mobile numbers receive alerts for specific monitors.

---

## Directory Structure

```text
├── docker-compose.yml             # Service definitions and memory constraints
├── .env.example                   # Template for environment secrets
├── .gitignore                     # Prevents leaking session keys, DBs, and numbers
├── commands.txt                   # Useful operational Docker commands
├── scripts/
│   ├── backup.sh                  # Snapshot Kuma data + host_map + .env
│   ├── restore.sh                 # Restore a snapshot on any machine
│   ├── save-image.sh              # Save the pinned Kuma image to a file
│   └── load-image.sh              # Load it on an offline machine
├── images/                        # (Ignored) Saved Docker images, ~150MB
├── backups/                       # (Ignored) Backup archives
├── uptime-kuma-data/              # (Ignored) SQLite database and persistent data
└── whatsapp-bot/
    ├── Dockerfile                 # Bot container definition
    ├── Dockerfile.ui              # Lightweight UI container definition
    ├── config/
    │   ├── host_map.example.json  # Template for monitor-to-phone mapping
    │   └── host_map.json          # (Ignored) Active monitor-to-phone routing
    ├── package.json               # Node.js dependencies
    ├── public/                    # Dashboard web assets
    ├── src/                       # Bot logic and UI backend
    └── wwebjs_auth/               # (Ignored) Persistent WhatsApp session credentials
```

---

## Quick Start Setup

### 1. Clone the Repository
```bash
git clone <your-repository-url> docker-stack
cd docker-stack
```

### 2. Configure Environment Variables
Copy the sample environment file and set your secure webhook secret token:
```bash
cp .env.example .env
```
Edit `.env`:
```env
HOOK_TOKEN=your_secure_random_token_here
```

### 3. Initialize the Notification Routing Table

**Restoring from a backup** — copy your saved routing table into place:
```bash
cp /path/to/backup/host_map.json ./whatsapp-bot/config/host_map.json
```

**Starting fresh** — copy the sample instead:
```bash
cp ./whatsapp-bot/config/host_map.example.json ./whatsapp-bot/config/host_map.json
```

This step is safe to do before *or* after the stack is running. If the file is
missing at first start, the bot seeds one from the example and logs a warning;
dropping your real `host_map.json` into `whatsapp-bot/config/` at any later
point is picked up automatically within a few seconds — no restart needed.

### 4. Build and Start the Stack
```bash
docker compose up -d --build
```

---

## Pairing WhatsApp

To pair the bot with your WhatsApp account:

1. View the container logs to display the terminal QR code:
   ```bash
   docker compose logs -f whatsapp-bot
   ```
2. Open WhatsApp on your phone $\rightarrow$ **Linked Devices** $\rightarrow$ **Link a Device**.
3. Scan the QR code displayed in the terminal.
4. Once authenticated, the bot will log:
   ```text
   ✅ WhatsApp authenticated
   ✅ WhatsApp client READY
   ```

---

## Configuring Uptime Kuma

### Webhook Notification Setup
1. Open Uptime Kuma in your browser at `http://<server-ip>:3001`.
2. Navigate to **Settings** $\rightarrow$ **Notifications** $\rightarrow$ **Setup Notification**.
3. Select **Webhook** and configure:
   - **Post URL**: `http://whatsapp-bot:3000/uptime-kuma`
   - **Custom Headers**:
     ```json
     {
       "x-hook-token": "your_secure_random_token_here"
     }
     ```
4. Click **Test** and **Save**.

### 90-Day History Retention (Recommended)
To keep the SQLite database fast and prevent lock timeouts:
1. In Uptime Kuma, go to **Settings** $\rightarrow$ **General**.
2. Set **Monitor History Retention (days)** to `90`.
3. Save changes.

---

## Backup & Restore (Moving to Another Machine)

Everything that makes this deployment *yours* lives outside git and is
captured by one script:

| What | Where | Restored? |
|---|---|---|
| Uptime Kuma monitors (hostnames, IPs, intervals) | `uptime-kuma-data/kuma.db` | ✅ |
| Notification configs (email/SMTP, WhatsApp webhook) | `uptime-kuma-data/kuma.db` | ✅ |
| Kuma login user & settings | `uptime-kuma-data/kuma.db` | ✅ |
| Site → phone routing | `whatsapp-bot/config/host_map.json` | ✅ |
| Webhook token | `.env` | ✅ |
| WhatsApp session | `whatsapp-bot/wwebjs_auth/` | ❌ deliberately — see below |

### Take a backup (on the running machine)
```bash
./scripts/backup.sh
```
Writes `backups/docker-stack-backup-<timestamp>.tar.gz`. Uptime Kuma is
stopped for a few seconds so the SQLite database and its `-wal` journal are
copied consistently — copying `kuma.db` by hand while Kuma is running can
silently lose the most recent changes.

Copy the archive somewhere safe. It contains real phone numbers, your SMTP
credentials and the webhook token — treat it like a password file.

### Restore (on the new machine)
```bash
git clone <repo-url> docker-stack && cd docker-stack
./scripts/restore.sh /path/to/docker-stack-backup-<timestamp>.tar.gz
docker compose up -d --build
```
Order does not matter: the restore script works on a fresh clone before the
first start, or on a stack that is already running (it stops Kuma, swaps the
data, and starts it again). Anything already present is moved aside with a
timestamp, never deleted.

Then:
1. Open `http://<server-ip>:3001` and log in with the **original machine's** Kuma credentials — the user is part of the backup.
2. Scan a fresh QR for the WhatsApp bot (`docker compose logs -f whatsapp-bot`). The session is not carried over: it is a linked *device*, and two machines sharing one device makes WhatsApp log one of them out.

The backup is tied to the Kuma version that wrote it. Keep `docker-compose.yml`
pinned to the same Uptime Kuma release on both machines.

### Keeping the Uptime Kuma image available forever

`docker-compose.yml` pins `louislam/uptime-kuma:2.0.2`. Docker Hub tags are
normally permanent, but to be independent of it entirely, save the image once:

```bash
./scripts/save-image.sh
```

This writes `images/uptime-kuma-2.0.2.tar.gz` (~150MB — too large for git,
so keep it with your backups). On a machine that cannot pull it:

```bash
./scripts/load-image.sh /path/to/uptime-kuma-2.0.2.tar.gz
docker compose up -d
```

Optionally, also mirror it to your own GitHub container registry so it lives
under your account's *Packages*:

```bash
docker pull louislam/uptime-kuma:2.0.2
docker tag louislam/uptime-kuma:2.0.2 ghcr.io/teckscribe/uptime-kuma:2.0.2
docker login ghcr.io          # username + a Personal Access Token with write:packages
docker push ghcr.io/teckscribe/uptime-kuma:2.0.2
```

Then point the stack at it by setting `UPTIME_KUMA_IMAGE` in `.env`.

---

## Managing Routing in the Web Dashboard

Open the routing dashboard at `http://<server-ip>:3002`.
- You can add or modify monitor hostnames and assign comma-separated mobile numbers (format: country code + number, e.g. `919876543210`).
- Changes take effect dynamically without restarting the bot.

---

## Common Operational Commands

```bash
# View bot logs
docker compose logs -f whatsapp-bot

# Restart services individually
docker restart whatsapp-bot
docker restart whatsapp-ui
docker restart uptime-kuma

# Re-link a new WhatsApp number (rescan QR)
docker compose stop whatsapp-bot
rm -rf ./whatsapp-bot/wwebjs_auth
mkdir ./whatsapp-bot/wwebjs_auth
docker compose start whatsapp-bot
docker compose logs -f whatsapp-bot
```
