function pageLayout(title: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · Hatch</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --danger: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 440px;
      width: 100%;
      padding: 2.25rem 2rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 0.25rem 0.65rem;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent);
      margin-bottom: 1.25rem;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
    .badge.danger {
      background: rgba(248, 113, 113, 0.1);
      color: var(--danger);
      border-color: rgba(248, 113, 113, 0.2);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      letter-spacing: -0.025em;
    }
    p {
      color: var(--muted);
      font-size: 0.925rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    code {
      background: rgba(255, 255, 255, 0.06);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #e2e8f0;
    }
    .input-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.825rem;
      font-weight: 500;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    input[type="password"] {
      width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input[type="password"]:focus {
      border-color: var(--accent);
    }
    button {
      width: 100%;
      background: var(--accent);
      color: #0b0f19;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    button:hover {
      background: var(--accent-hover);
    }
    .footer {
      margin-top: 1.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .footer a {
      color: var(--muted);
      text-decoration: none;
    }
    .footer a:hover {
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="card">
    ${contentHtml}
    <div class="footer">
      <span>Hatch Edge Tunnel</span>
      <a href="https://github.com/dwip-the-dev/hatch" target="_blank" rel="noopener">Documentation</a>
    </div>
  </div>
</body>
</html>`;
}

export function renderOfflinePage(slot: string): Response {
  const html = pageLayout(
    "Slot Offline",
    `
    <div class="badge danger">502 Bad Gateway</div>
    <h1>Tunnel Slot Offline</h1>
    <p>Slot <code>${slot}</code> is not currently connected to an active Hatch CLI daemon on localhost.</p>
    <p>To broadcast on this slot, launch your local server and run:</p>
    <p><code>hatch host &lt;port&gt; --slot ${slot}</code></p>
    `
  );
  return new Response(html, {
    status: 502,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export function renderFullPage(activeSlots: number, maxSlots: number): Response {
  const html = pageLayout(
    "All Slots Occupied",
    `
    <div class="badge danger">503 Service Unavailable</div>
    <h1>All Tunnel Slots Active</h1>
    <p>All <code>${maxSlots}</code> tunnel slots managed by this Hatch Worker are currently in use by active CLI clients.</p>
    <p>Please disconnect an unused tunnel session or increase <code>ALLOWED_SLOTS</code> in your Cloudflare Worker configuration.</p>
    `
  );
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export function renderTimeoutPage(slot: string, elapsedMs = 30000): Response {
  const html = pageLayout(
    "Gateway Timeout",
    `
    <div class="badge danger">504 Gateway Timeout</div>
    <h1>Local Server Timed Out</h1>
    <p>The Hatch edge forwarded your request to slot <code>${slot}</code>, but the local development server failed to respond within <code>${Math.round(elapsedMs / 1000)}s</code>.</p>
    <p>Check your local terminal logs to ensure your application did not hang or deadlock.</p>
    `
  );
  return new Response(html, {
    status: 504,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export function renderForbiddenPage(slot: string, path: string): Response {
  const html = pageLayout(
    "Path Restricted",
    `
    <div class="badge danger">403 Forbidden</div>
    <h1>Restricted Endpoint</h1>
    <p>Slot <code>${slot}</code> was launched with edge path restriction rules. The requested path <code>${path}</code> is not exposed publicly.</p>
    `
  );
  return new Response(html, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export function renderLockGatePage(slot: string, error?: string): Response {
  const errorBanner = error
    ? `<div style="background: rgba(248, 113, 113, 0.15); border: 1px solid rgba(248, 113, 113, 0.3); color: #fca5a5; padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem;">${error}</div>`
    : "";

  const html = pageLayout(
    "Protected Tunnel",
    `
    <div class="badge">401 Access Protected</div>
    <h1>Protected Preview</h1>
    <p>Slot <code>${slot}</code> is password protected. Enter the access password to enter this tunnel.</p>
    ${errorBanner}
    <form method="POST" action="/_tunnel/auth">
      <input type="hidden" name="slot" value="${slot}" />
      <div class="input-group">
        <label for="password">Tunnel Visitor Password</label>
        <input type="password" id="password" name="password" required autofocus autocomplete="current-password" placeholder="••••••••••••" />
      </div>
      <button type="submit">Unlock Tunnel</button>
    </form>
    `
  );
  return new Response(html, {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Hatch Protected Tunnel"'
    }
  });
}
