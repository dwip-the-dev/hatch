lets call it Hatch. # MASTER ENGINEERING PROMPT: Open-Source Self-Hosted Edge Tunneling System (Cloudflare Workers + Python/Bash CLI)

Act as a principal systems engineer and developer-experience architect. Build a complete, production-ready, open-source monorepo for **`<PROJECT_NAME>`**—a zero-VPS, self-hosted localhost-to-edge tunneling system that completely bypasses `ngrok`, `cloudflared`, and ISP double-NAT using a **single Cloudflare Worker + SQLite-backed Durable Object** on the edge and a lightweight **Bash + Python async CLI** locally.

---

## 1. Core Architectural Constraints & Design Philosophy
* **100% Public Template (Zero Personal Data):** Never hardcode any personal domains, emails, usernames, Worker URLs, or passwords anywhere in the repository. Everything user-specific must live in Cloudflare Environment Secrets/Vars or the user's local `~/.config/<PROJECT_NAME>/config.json`.
* **Single-Worker Multi-Slot Architecture:** All subdomains (e.g., `temp1` through `temp5`, or any custom list defined via an environment variable) MUST be routed through **one single Cloudflare Worker** backed by **one singleton Durable Object** (`TunnelHub`).
* **Cloudflare Free Plan Native:**
  * Use `new_sqlite_classes` in `wrangler.toml` so Durable Objects work on the Cloudflare Workers Free Plan.
  * Use the **Durable Objects WebSocket Hibernation API** (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `serializeAttachment` / `deserializeAttachment`) so idle tunnels do not burn billable compute duration.
* **Zero-Config Dynamic Slot Allocation:** Running `<PROJECT_NAME> host 3000` automatically claims the first unoccupied slot (`temp1`), printing the live HTTPS URL immediately. Running a second terminal with `<PROJECT_NAME> host 8080` automatically claims `temp2`, supporting 5+ concurrent tunnels seamlessly. Closing a terminal immediately releases its slot.
* **Strict Password Authentication:** Every tunnel connection requires a shared `TUNNEL_PASSWORD` stored as a Cloudflare Worker Secret. The CLI must prompt for the password interactively (hidden input) before connecting unless overridden by an explicit environment variable. Compare secrets in constant time on the Worker.

---

## 2. Repository Structure
Generate the complete, runnable repository with the exact structure below:

```text
<PROJECT_NAME>/
├── README.md                    # Exhaustive setup, DNS (CNAME/TXT), Cloudflare & CLI guide
├── LICENSE                      # MIT License
├── .gitignore                   # Ignores node_modules, .venv, .dev.vars, local configs
├── worker/
│   ├── package.json             # Wrangler scripts + Cloudflare One-Click Deploy metadata
│   ├── tsconfig.json
│   ├── wrangler.toml            # Generic placeholder name, SQLite DO migration, ALLOWED_SLOTS var
│   ├── .dev.vars.example        # Template for local TUNNEL_PASSWORD testing
│   └── src/
│       ├── index.ts             # Worker router, auth middleware, public traffic dispatcher
│       ├── hub.ts               # Durable Object (TunnelHub): slot tracking, WS hibernation, multiplexing
│       ├── protocol.ts          # Shared JSON/binary framing types & hop-by-hop header sanitizer
│       └── pages.ts             # Clean minimal HTML error pages (502 Offline, 503 Full, 401 Lock Gate)
└── cli/
    ├── install.sh               # One-command installer (creates isolated venv + symlinks CLI to ~/.local/bin)
    ├── requirements.txt         # Minimal dependencies (websockets, aiohttp)
    ├── bin/<PROJECT_NAME>       # Bash entrypoint handling flexible flags & invoking Python daemon
    └── src/
        ├── __init__.py
        ├── cli.py               # Argument parser, `init`, `status`, `doctor`, `host` commands
        ├── config.py            # Reads/writes ~/.config/<PROJECT_NAME>/config.json (Worker URL + base domain)
        ├── tunnel.py            # Async WebSocket multiplexer, local HTTP forwarder, auto-reconnect
        └── inspector.py         # Live ANSI terminal request log + in-memory last-50 request store & hotkey replay
```

---

## 3. Detailed Technical Specifications

### A. Cloudflare Edge Switchboard (`worker/`)
1. **Configuration (`wrangler.toml` & Secrets):**
   * `TUNNEL_PASSWORD` (Secret): Master password required by the CLI to register a tunnel.
   * `ALLOWED_SLOTS` (Env Var, default `"temp1,temp2,temp3,temp4,temp5"`): Comma-separated pool of subdomain prefixes managed by this Worker. Also allow an optional `"*"` mode to accept any subdomain dynamically.
2. **Control Plane Endpoints (Protected by `X-Tunnel-Password` using constant-time comparison):**
   * `GET /_tunnel/connect` (WebSocket Upgrade):
     * Accepts optional query params: `?slot=<name>`, `?lock=<visitor_password>`, `?only=<path_prefix>`.
     * Inspects active hibernated sockets via `this.ctx.getWebSockets()`.
     * If `slot` is omitted, auto-assigns the first unused slot from `ALLOWED_SLOTS`. Returns `409 Conflict` if a requested slot is busy, `503 Service Unavailable` if all slots are full, and `401 Unauthorized` on bad password.
     * Persists `{ slot, lockHash, onlyPrefix, connectedAt }` on the socket via `serializeAttachment()` so metadata survives hibernation.
     * Immediately sends `{ "type": "assigned", "slot": "<slot>", "activeCount": <n>, "maxSlots": <m> }` upon connect.
   * `GET /_tunnel/status`: Returns JSON showing all configured slots, which ones are currently active/free, and uptime—used by `<PROJECT_NAME> status` and `<PROJECT_NAME> doctor`.
3. **Public Traffic Plane (Incoming Visitor Requests):**
   * Extracts target slot from the incoming `Host` header subdomain (also supports a fallback path/header mode for testing directly on `*.workers.dev` before custom domains are configured).
   * **Edge Protections (Executed Before Tunneling):**
     * If the slot was started with `--only /api/webhook`, immediately return `403 Forbidden` at the edge for any path not matching the prefix.
     * If the slot was started with `--lock <pass>`, enforce HTTP Basic Auth (or signed cookie login page) at the edge before forwarding bytes to the user's PC.
   * **Request/Response Multiplexing:**
     * Generates a UUID `reqId`, forwards serialized method, path + query, sanitized headers (stripping hop-by-hop headers and preserving `X-Forwarded-For` / `X-Forwarded-Host`), and base64/binary chunked body over the target slot's WebSocket.
     * Awaits the correlated `reqId` response frame with a 30-second timeout (`504 Gateway Timeout` if local server hangs).
     * Supports **WebSocket passthrough** (`ws_open`, `ws_frame`, `ws_close` multiplexed frames) so Vite/Next.js HMR and real-time apps work through the tunnel.
     * Includes a brief 3-second reconnect grace buffer if a CLI socket drops mid-request during minor Wi-Fi blips.
   * **Clean Error Pages (`pages.ts`):** Crisp, dark-mode minimal status pages for `502 Slot Offline`, `503 All Slots Occupied`, and `504 Local Timeout`.

### B. Local Client (`cli/` — Bash + Python)
1. **Flexible Command Syntax (Handled by Bash wrapper + Python CLI):**
   * Must seamlessly accept both natural and flag-based syntax:
     * `<PROJECT_NAME> init` — Interactive first-time setup prompting for the user's **Cloudflare Worker URL** (e.g., `https://my-tunnel.username.workers.dev` or `https://temp1.example.com`) and their **base custom domain** (e.g., `example.com` or `myname.dedyn.io`), saving them to `~/.config/<PROJECT_NAME>/config.json`.
     * `<PROJECT_NAME> host 3000` AND `<PROJECT_NAME> -host -p 3000` — Auto-claims the next free slot (`temp1`..`temp5`) and forwards to `127.0.0.1:3000`.
     * `<PROJECT_NAME> host 3000 --slot temp3` (or `-s temp3`) — Claims a specific slot.
     * `<PROJECT_NAME> host 3000 --lock mysecret` — Adds edge password protection for public visitors.
     * `<PROJECT_NAME> host 3000 --only /webhook` — Restricts exposed paths at the Cloudflare edge.
     * `<PROJECT_NAME> status` — Displays a clean table of all slots (FREE vs. LIVE).
     * `<PROJECT_NAME> doctor` — Verifies config, Worker reachability, TLS, and password auth.
2. **Authentication UX:**
   * Always prompts `Tunnel Password: ` with hidden terminal echo (`getpass.getpass`) unless `TUNNEL_PASSWORD` is explicitly set in the shell environment. Never saves the plaintext password to disk.
3. **Live Inspector & Replay:**
   * Displays a clean banner once connected:
     `LIVE  https://temp1.<base_domain>  --->  http://127.0.0.1:3000  (Slot 1/5)`
   * Prints real-time color-coded logs: `[200] POST /api/webhook  14ms  1.2KB`.
   * Buffers the last 50 requests in memory; pressing `r` in the terminal immediately replays the last captured request directly against `http://127.0.0.1:<port>` for rapid local debugging, and pressing `l` lists recent requests.
   * Handles `Ctrl+C` cleanly so the WebSocket sends a proper close frame and frees the edge slot instantaneously.
   * Automatically sends WebSocket keepalive pings every 20 seconds to survive aggressive ISP double-NAT timeout tables.
4. **Zero-Friction Installer (`cli/install.sh`):**
   * Works on Linux, macOS, WSL, and Termux. Checks for `python3`, creates a dedicated isolated venv inside `~/.local/share/<PROJECT_NAME>/venv`, installs `requirements.txt`, and symlinks `cli/bin/<PROJECT_NAME>` into `~/.local/bin/<PROJECT_NAME>` with PATH verification instructions.

---

## 4. Mandatory Exhaustive `README.md` Requirements
Write an extraordinarily clear, beginner-proof, copy-pasteable `README.md` so any developer can go from zero to 5 live custom-domain tunnels in under 10 minutes. It MUST include:

1. **Hero Section & Architecture Diagram:**
   * Clean ASCII diagram showing `Public Visitor -> Cloudflare Edge Worker -> Durable Object Hub <=== Outbound WS (Bypasses Double-NAT) ===> Local CLI -> localhost:PORT`.
   * Explicit **Deploy to Cloudflare** one-click button badge (`https://deploy.workers.cloudflare.com/?url=https://github.com/<USER>/<REPO>`).
2. **How This Compares to `ngrok` and `cloudflared`:**
   * Clear comparison table covering Cost, Custom Subdomains, Concurrent Tunnels, Double-NAT Traversal, Idle Limits, Data Privacy, and Setup Complexity—explaining exactly how this replaces `cloudflared` / `ngrok` for HTTP & WebSockets without running a tunnel daemon or paying for custom subdomains (and noting when someone would still use `cloudflared` for raw non-HTTP TCP/SSH).
3. **Step 1: Deploying the Single Cloudflare Worker:**
   * **Option A:** One-Click Deploy via Cloudflare Dashboard.
   * **Option B:** Manual CLI deploy (`cd worker && npm install && npx wrangler login && npx wrangler deploy`).
   * Exact commands & Dashboard clicks to set the **`TUNNEL_PASSWORD`** secret (`npx wrangler secret put TUNNEL_PASSWORD`) and customize **`ALLOWED_SLOTS`** (e.g., expanding from 5 slots to 10 slots).
   * Confirming Durable Objects SQLite Free-Tier compatibility.
4. **Step 2: Complete DNS Configuration Guide (CNAME & TXT Records):**
   Provide crystal-clear, separate step-by-step tables and instructions for **every DNS scenario**:
   * **Scenario A — Domain Hosted on Cloudflare DNS (Easiest):**
     * Exact dashboard navigation: *Workers & Pages → `<worker>` → Settings → Domains & Routes → + Add → Custom Domain*.
     * Explaining how adding `temp1.yourdomain.com` through `temp5.yourdomain.com` automatically creates proxied DNS records and provisions free Universal SSL certificates.
   * **Scenario B — External DNS & Free Dynamic DNS Providers (e.g., deSEC `*.dedyn.io`, Namecheap, Porkbun, DuckDNS, `is-a.dev`):**
     * Explicitly explain the Public Suffix List / non-Cloudflare-nameserver limitation (why you cannot just point raw CNAMEs directly to `*.workers.dev` without Cloudflare rejecting the Host header with Error 1014 / SSL mismatch).
     * Provide the exact **Cloudflare for SaaS (Custom Hostnames)** free-tier workflow (100 free custom hostnames) OR external DNS zone onboarding workflow, including:
       * Exact **CNAME Record Table** (`Host/Subname`, `Type: CNAME`, `Target/Value`, `TTL`) for `temp1` through `temp5`.
       * Exact **TXT Verification Record Table** (Domain Control Validation `_cf-custom-hostname.<sub.domain>` and SSL DCV `_acme-challenge.<sub.domain>` TXT records) with exact examples of what to paste into external DNS panels like deSEC (`dedyn.io`).
       * Step-by-step verification commands using `dig CNAME`, `dig TXT`, and `curl -I` to confirm propagation and active TLS certificates before running the CLI.
   * **Scenario C — Zero-Domain Quickstart (`*.workers.dev` Fallback Mode):**
     * Explain how users can test the entire tunnel immediately using just their free `*.workers.dev` URL before configuring any custom DNS records.
5. **Step 3: Cloudflare Dashboard & Edge Checklist:**
   * Exact menu paths for checking real-time Worker logs (`npx wrangler tail`), rotating `TUNNEL_PASSWORD`, viewing Durable Object storage/hibernation metrics, and verifying SSL/TLS mode is set to **Full (Strict)**.
6. **Step 4: Local CLI Installation & Everyday Usage:**
   * One-line install (`git clone ... && ./cli/install.sh`).
   * Running `<PROJECT_NAME> init` and pasting the Worker URL + base domain.
   * Concrete examples: running 5 local servers simultaneously across terminals, locking a preview with `--lock`, filtering paths with `--only`, replaying webhooks with `r`, and running `<PROJECT_NAME> doctor`.
7. **Step 5: Troubleshooting Matrix:**
   * Table mapping exact error codes (`401`, `409`, `502`, `503`, `504`, Cloudflare `Error 1014`, `Error 525`, WebSocket `1006` disconnects) to root causes and exact one-line fixes.
8. **Security Best Practices & Free-Tier Quotas:**
   * Clear breakdown of Cloudflare's free daily request limits (100k req/day), Durable Object free-tier limits, why WebSocket Hibernation keeps costs at $0, and strong password hygiene.

---

## 5. Output Requirements
* Output **every single file** cleanly with its full relative file path and complete, runnable code—no placeholders, no `// TODO`, no truncated functions.
* Verify all TypeScript types compile cleanly under Wrangler and all Python code runs cleanly on Python 3.9+ without syntax or async event-loop bugs.
* Ensure binary responses (images, fonts, PDFs, gzipped assets) pass through the tunnel without UTF-8 corruption.
