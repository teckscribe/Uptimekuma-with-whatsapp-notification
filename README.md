# Docker Stack: Uptime Kuma + WhatsApp Incident Alerting

A containerized power and network infrastructure monitoring stack with automated real-time incident alerting via WhatsApp.

---

## Architecture Overview

- **`uptime-kuma` (Port 3001)**: Built directly from source. Probes network devices and power status via ICMP Ping and HTTP. Alerts are dispatched via webhooks.
- **`whatsapp-bot` (Port 3000)**: Headless WhatsApp Web client (via Puppeteer & Chromium) that receives Uptime Kuma webhooks, formats incident timestamps in Indian Standard Time (`Asia/Kolkata`), and sends alerts sequentially with queue flood protection.
- **`whatsapp-ui` (Port 3002)**: Web dashboard for operations teams to dynamically configure which mobile numbers receive alerts for specific monitors.

---

## Directory Structure

```text
├── docker-compose.yml             # Service definitions and memory constraints
├── .env.example                   # Template for environment secrets
├── .gitignore                     # Prevents leaking session keys, DBs, and numbers
├── commands.txt                   # Useful operational Docker commands
├── uptime-kuma/                   # Full source code and Dockerfile for Uptime Kuma
├── uptime-kuma-data/              # (Ignored) SQLite database and persistent data
└── whatsapp-bot/
    ├── Dockerfile                 # Bot container definition
    ├── Dockerfile.ui              # Lightweight UI container definition
    ├── host_map.example.json      # Template for monitor-to-phone mapping
    ├── host_map.json              # (Ignored) Active monitor-to-phone routing
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
Copy the sample host map to create your active routing table:
```bash
cp ./whatsapp-bot/host_map.example.json ./whatsapp-bot/host_map.json
```

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
