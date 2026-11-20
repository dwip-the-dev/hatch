# Hatch 🐣

> **Zero-VPS, self-hosted localhost-to-edge tunneling system** powered by a single Cloudflare Worker, an SQLite-backed Durable Object, and an async Python/Bash CLI.

Hatch allows you to instantly expose local development servers to public HTTPS custom subdomains (`temp1.yourdomain.com` through `temp5.yourdomain.com`) without third-party tunnel daemons, subscription fees, or inbound port forwarding. It operates seamlessly through double-NAT, carrier-grade NAT (CGNAT), and restrictive home firewalls.

---

## Architecture

```text
                                       CLOUDFLARE EDGE (Free Tier Native)
                                 ┌──────────────────────────────────────────────┐
                                 │ Cloudflare Worker (Router & Auth Gate)       │
                                 │                  │                           │
Public Visitor                   │                  ▼                           │
┌──────────────┐   HTTPS Req     │      ┌───────────────────────┐               │
│ Web Browser  │ ───────────────>│      │ Durable Object Hub    │               │
│ or Webhook   │ <───────────────│      │ (SQLite State +       │               │
└──────────────┘   HTTPS Res     │      │  WS Hibernation API)  │               │
                                 └──────┴───────────┬───────────┴───────────────┘
                                                    ▲
                                     Outbound WSS   │  (Bypasses CGNAT & Firewalls,
                                     Keepalive Ping │   Survives Idle at $0 Cost)
                                                    ▼
                                 ┌──────────────────────────────────────────────┐
                                 │ Hatch Local Client Daemon (Python + Bash)    │
                                 │ ├── Request Multiplexer                      │
                                 │ ├── Live ANSI Inspector & Replay Engine      │
                                 │ └── Local HTTP / WebSocket Forwarder         │
                                 └──────────────────┬───────────────────────────┘
                                                    │
                                                    ▼
                                        ┌───────────────────────┐
                                        │ Local Dev Server      │
                                        │ http://127.0.0.1:3000 │
                                        └───────────────────────┘
```

---

## Comparison: Hatch vs. Alternatives

| Feature | Hatch | ngrok (Free) | cloudflared (Named Tunnels) |
| :--- | :--- | :--- | :--- |
| **Hosting Infrastructure** | Serverless (Cloudflare Worker) | Proprietary Cloud | Cloudflare Edge Daemon |
| **Monthly Cost** | **$0** (Free Cloudflare Tier) | Freemium ($8+/mo for custom domains) | Free |
| **Custom Subdomains** | **Yes** (`temp1`–`temp5` or custom) | 1 ephemeral or static domain | Yes |
| **Concurrent Tunnels** | **Unlimited concurrent** (dynamic on-demand slots) | 1 tunnel | Unlimited |
| **Double-NAT Traversal** | **Yes** (Outbound WebSocket) | Yes | Yes |
| **Compute Cost While Idle** | **$0** (Durable Object Hibernation) | N/A | Daemon memory footprint |
| **Data Privacy** | **100% User-Controlled** (Runs in your CF account) | Routed through ngrok servers | Routed through Cloudflare edge |
| **WebSockets & HMR** | **Yes** (Vite, Next.js, WebSockets) | Yes | Yes |
| **Edge Access Gate (`--lock`)** | **Yes** (HTTP Basic Auth & Cookie Form) | Basic Auth (Paid tier) | Cloudflare Access (Zero Trust config) |
| **Path Filtering (`--only`)** | **Yes** (Drop unauthorized paths at edge) | Paid feature | Cloudflare WAF rules |
| **Non-HTTP TCP / SSH** | No (Focused on HTTP & WebSockets) | TCP tunnels (Paid) | **Yes** (Use `cloudflared` for raw SSH/TCP) |

---

## Project Structure

```text
hatch/
├── README.md                    # Setup, DNS, and usage guide
├── LICENSE                      # Open-source MIT license
├── .gitignore                   # Ignore builds, venvs, secrets
├── worker/                      # Cloudflare Worker & Durable Object edge hub
│   ├── package.json             # Scripts & worker dependencies
│   ├── tsconfig.json            # TypeScript configuration
│   ├── wrangler.toml            # SQLite Durable Object configuration
│   ├── .dev.vars.example        # Local development secrets template
│   └── src/
│       ├── index.ts             # Worker routing, auth middleware & slot dispatcher
│       ├── hub.ts               # Durable Object: slot allocation & WS hibernation
│       ├── protocol.ts          # Framing types, header sanitization & crypto
│       └── pages.ts             # Dark-mode HTML error & password gate pages
└── cli/                         # Local client
    ├── install.sh               # One-command installer (isolated venv + symlink)
    ├── requirements.txt         # Dependencies (aiohttp, websockets)
    ├── bin/hatch                # Executable Bash entrypoint
    └── src/
        ├── __init__.py
        ├── cli.py               # Argument parser & command dispatcher
        ├── config.py            # Local config manager (~/.config/hatch/config.json)
        ├── tunnel.py            # Async WebSocket multiplexer & local forwarder
        └── inspector.py         # Live terminal inspector & hotkey replay engine
```

---

## Step 1: Deploy the Cloudflare Edge Worker

### Prerequisites
* [Node.js](https://nodejs.org/) v18+ and `npm`
* A free [Cloudflare Account](https://dash.cloudflare.com/)

### Deployment Commands

1. **Clone the repository and install worker dependencies:**
   ```bash
   git clone https://github.com/dwip-the-dev/hatch.git
   cd hatch/worker
   npm install
   ```

2. **Authenticate with Cloudflare:**
   ```bash
   npx wrangler login
   ```

3. **Deploy the Worker:**
   ```bash
   npx wrangler deploy
   ```
   *Take note of the published Worker URL (e.g., `https://hatch-edge.<username>.workers.dev`).*

4. **Set the Master Tunnel Password:**
   Set the shared master secret required by CLI instances to connect:
   ```bash
   npx wrangler secret put TUNNEL_PASSWORD
   ```
   *Enter a strong password when prompted.*

5. **Dynamic Unlimited Concurrent Slots:**
   Hatch defaults to wildcard dynamic slot mode (`ALLOWED_SLOTS = "*"`). You can spin up as many concurrent tunnels as you need (`temp1`, `temp2`, ... `tempN`) or claim custom named slots on demand (`hatch host 3000 --slot my-feature`). Each terminal automatically claims the next free slot with zero configuration.

---

## Step 2: Configure DNS Records

Hatch supports three DNS routing setups:

### Scenario A: Your Domain is Managed by Cloudflare DNS (Recommended & Easiest)

If your domain (e.g., `example.com`) uses Cloudflare nameservers:

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Workers & Pages** → Select your `hatch-edge` worker.
3. Go to **Settings** → **Domains & Routes** → Click **+ Add** → Select **Custom Domain**.
4. Add the custom hostnames you want to reserve for your slots:
   - `temp1.example.com`
   - `temp2.example.com`
   - `temp3.example.com`
   - `temp4.example.com`
   - `temp5.example.com`
5. Cloudflare automatically provisions Universal SSL certificates and creates the appropriate DNS routing records.

---

### Scenario B: External DNS & Free Dynamic DNS Providers (deSEC, Porkbun, Namecheap, DuckDNS)

> **Important Cloudflare Architecture Constraint**: Unlike Cloudflare Pages (which supports external CNAME verification without Cloudflare nameservers), **Cloudflare Workers Custom Domains require the domain/subdomain to be an active Zone on your Cloudflare account**. A raw external CNAME in deSEC pointing directly to `*.workers.dev` will fail with an SSL handshake mismatch (error 552) because Cloudflare's edge does not hold an SSL certificate for external hostnames.

To use an external or dynamic domain like `dwip.dedyn.io` on the Cloudflare Free Plan:

1. **Add the Domain/Subdomain to Cloudflare as a Zone**:
   - In Cloudflare Dashboard, click **Add a Domain / Add a Site** → enter your domain/subdomain (e.g. `dwip.dedyn.io`).
   - Select the **Free Plan**.
   - Cloudflare will scan DNS and provide you with two assigned Cloudflare nameservers (e.g., `aria.ns.cloudflare.com` and `noah.ns.cloudflare.com`).
2. **Delegate Nameservers in your External Provider (deSEC)**:
   - In your deSEC control panel, create `NS` records delegating `dwip.dedyn.io` to the two Cloudflare nameservers.
   - Wait for Cloudflare to verify the delegation (status turns **Active**).
3. **Attach Custom Domains to Hatch**:
   - In Cloudflare Dashboard: **Workers & Pages** → `hatch-edge` → **Domains** (or **Settings** → **Domains & Routes**) → click **+ Add** → **Custom Domain**.
   - Add `temp1.dwip.dedyn.io` through `temp5.dwip.dedyn.io`.
   - Cloudflare will automatically create the proxied DNS records and issue free Universal SSL certificates.

---

### Scenario C: Zero-Domain Quickstart (`*.workers.dev` Fallback Mode)

You can test Hatch immediately with **zero custom domains** using your default Cloudflare Worker URL.

Hatch provides automatic path-based routing for `*.workers.dev`:
- `https://hatch-edge.<username>.workers.dev/_slot/temp1/`
- Or pass the header: `X-Hatch-Slot: temp1`

When using this mode, leave the **Base Domain** blank during `hatch init`.

---

## Step 3: Install the Local CLI

Run the zero-friction installer:

```bash
git clone https://github.com/dwip-the-dev/hatch.git
cd hatch
./cli/install.sh
```

The installer:
1. Creates an isolated Python virtual environment in `~/.local/share/hatch/venv`.
2. Installs dependencies (`aiohttp`, `websockets`).
3. Symlinks `hatch` into `~/.local/bin/hatch`.

*If `~/.local/bin` is not on your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your `~/.bashrc` or `~/.zshrc`.*

---

## Step 4: Configuration & Everyday Usage

### 1. Interactive Setup
Run `hatch init` to configure your endpoints:
```bash
hatch init
```
* Prompts for your **Worker URL** (e.g., `https://hatch-edge.username.workers.dev`).
* Prompts for your **Base Domain** (e.g., `example.com` or `user.dedyn.io`).
* Configuration is saved to `~/.config/hatch/config.json`. If missing, Hatch automatically prompts on launch.

---

### 2. Exposing Local Ports

#### Auto-Claim Free Slot
Expose your local development server on port 3000:
```bash
hatch host 3000
# or:
hatch host -p 3000
```
*Automatically claims the first free slot (`temp1`), logs connection details, and displays live HTTP requests.*

#### Claim a Specific Slot
```bash
hatch host 3000 --slot temp3
```

#### Multi-Tunnel Concurrency
Open multiple terminal tabs to run concurrent tunnels:
* Terminal 1: `hatch host 3000` → Claims `temp1`
* Terminal 2: `hatch host 8080` → Claims `temp2`
* Terminal 3: `hatch host 5173` → Claims `temp3`

#### Edge Password Protection (`--lock`)
Restrict public visitor access at the Cloudflare edge:
```bash
hatch host 3000 --lock secret123
```
*Visitors will be prompted with a secure dark-mode login form or HTTP Basic Authentication. Unauthenticated requests never reach your computer.*

#### Edge Path Whitelisting (`--only`)
Only expose specific endpoints (e.g., public webhooks):
```bash
hatch host 3000 --only /api/webhook
```
*Requests to any other path receive an immediate `403 Forbidden` response at the Cloudflare edge.*

---

### 3. Live Inspector & Hotkeys

While hosting, Hatch displays an interactive terminal UI:

```text
● LIVE  https://temp1.example.com  --->  http://127.0.0.1:3000  (Slot temp1 · 1/5 active)
Hotkeys: [r] Replay last request | [l] List recent requests | [Ctrl+C] Disconnect
────────────────────────────────────────────────────────────────────────────
[200] GET    /                                12ms     1.4KB
[200] GET    /assets/index.css                 8ms    24.1KB
[200] POST   /api/webhook                     34ms       82B
```

* **Press `r`**: Instantly replays the last captured request directly against your local server (`http://127.0.0.1:3000`) for debugging webhooks and API payloads.
* **Press `l`**: Displays a table of the last 15 captured requests.
* **Press `Ctrl+C`**: Cleanly terminates the WebSocket connection, releasing the slot on the edge instantly.

---

### 4. Slot Status & Diagnostic Doctor

#### Inspect Active Slots
```bash
hatch status
```
Prints a table of all slots, active connections, and protection rules.

#### Diagnostic Doctor
```bash
hatch doctor
```
Verifies local configuration, TLS reachability, edge Worker responsiveness, and `TUNNEL_PASSWORD` authentication.

---

## Step 5: Troubleshooting Matrix

| Error Code / Symptom | Root Cause | Solution |
| :--- | :--- | :--- |
| **`401 Unauthorized`** (CLI) | Invalid `TUNNEL_PASSWORD` | Ensure password entered in CLI matches `npx wrangler secret put TUNNEL_PASSWORD`. |
| **`401 Unauthorized`** (Browser) | Visitor password required | Slot was started with `--lock <password>`. Enter the password on the login screen. |
| **`409 Conflict`** | Requested slot is occupied | Another terminal is using this slot. Choose another slot with `--slot tempX` or run without `--slot` to auto-claim. |
| **`502 Bad Gateway`** | Tunnel slot offline | Start the CLI on your computer using `hatch host <port>`. |
| **`503 Service Unavailable`** | All slots occupied | Close unused CLI sessions or expand `ALLOWED_SLOTS` in `wrangler.toml` and re-deploy. |
| **`504 Gateway Timeout`** | Local server hung (>30s) | Check your local server logs to resolve timeouts or deadlocks. |
| **`Cloudflare Error 1014`** | CNAME Cross-User Ban | External domain CNAME pointed to `workers.dev` without Cloudflare for SaaS custom hostname configuration. Follow Scenario B. |
| **`Cloudflare Error 525`** | SSL handshake failure | In Cloudflare Dashboard, verify **SSL/TLS Encryption Mode** is set to **Full** or **Full (Strict)**. |
| **WebSocket disconnect (`1006`)** | Network blip or ISP NAT | Hatch automatically reconnects and sends keepalive pings every 20 seconds. |

---

## Security Best Practices & Free-Tier Limits

1. **Timing-Safe Authentication**: Master password verification and lock hashes use constant-time comparisons (`crypto.subtle.timingSafeEqual`) to prevent timing side-channel attacks.
2. **WebSocket Hibernation**: By utilizing Cloudflare's Durable Object Hibernation API (`ctx.acceptWebSocket`), Worker compute time is charged only during active frame forwarding ($0 while idle).
3. **Daily Free Quota**: The Cloudflare Workers free plan provides **100,000 requests/day**, which is more than sufficient for active daily development and webhook testing.
4. **Credential Privacy**: Never commit `.dev.vars` or store passwords in plaintext. The CLI prompts for `TUNNEL_PASSWORD` interactively via hidden input (`getpass`) or reads it from shell environment variables.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
Authored by [Dwip](https://github.com/dwip-the-dev).
