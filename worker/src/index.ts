import { TunnelHub, Env } from "./hub";
import { timingSafeStringCompare, hashPassword } from "./protocol";
import { renderOfflinePage, renderForbiddenPage, renderLockGatePage } from "./pages";

export { TunnelHub };

function extractSlotFromHost(host: string, allowedSlots: string[]): string | null {
  const cleanHost = host.split(":")[0].toLowerCase();
  const parts = cleanHost.split(".");
  if (parts.length >= 2) {
    const candidate = parts[0];
    if (allowedSlots.includes("*") || allowedSlots.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseCookie(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split("=");
    if (name.trim() === key) {
      return rest.join("=").trim();
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hubId = env.TUNNEL_HUB.idFromName("global");
    const hub = env.TUNNEL_HUB.get(hubId);

    const allowedSlotsRaw = env.ALLOWED_SLOTS || "temp1,temp2,temp3,temp4,temp5";
    const allowedSlots = allowedSlotsRaw.split(",").map((s) => s.trim()).filter(Boolean);

    // =========================================================================
    // 1. Control Plane & Administrative Endpoints
    // =========================================================================
    if (url.pathname.startsWith("/_tunnel/")) {
      // Form POST action for unlocking a protected slot via web browser
      if (url.pathname === "/_tunnel/auth" && request.method === "POST") {
        const formData = await request.formData();
        const slot = formData.get("slot")?.toString().trim();
        const password = formData.get("password")?.toString();

        if (!slot || !password) {
          return new Response("Missing slot or password", { status: 400 });
        }

        const metaRes = await hub.fetch(new Request(`http://internal/_tunnel/slot-meta?slot=${encodeURIComponent(slot)}`));
        const meta = (await metaRes.json()) as { active: boolean; lockHash: string | null };

        if (!meta.active || !meta.lockHash) {
          return new Response("Tunnel slot is not active or not locked", { status: 404 });
        }

        const submittedHash = await hashPassword(password);
        const matches = await timingSafeStringCompare(submittedHash, meta.lockHash);

        if (!matches) {
          return renderLockGatePage(slot, "Incorrect tunnel password. Please try again.");
        }

        // Set secure authentication cookie and redirect
        const headers = new Headers();
        headers.set(
          "Set-Cookie",
          `hatch_auth_${slot}=${submittedHash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
        );
        headers.set("Location", "/");
        return new Response(null, { status: 302, headers });
      }

      // Master password authentication for CLI connections and status checks
      const configuredPassword = env.TUNNEL_PASSWORD;
      if (configuredPassword) {
        const providedPassword =
          request.headers.get("X-Tunnel-Password") ||
          url.searchParams.get("password") ||
          url.searchParams.get("token") ||
          "";

        const isAuth = await timingSafeStringCompare(providedPassword, configuredPassword);
        if (!isAuth) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Invalid or missing X-Tunnel-Password" }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
      }

      // Forward authenticated control plane request directly to Durable Object
      return hub.fetch(request);
    }

    // =========================================================================
    // 2. Resolve Target Slot for Public Traffic
    // =========================================================================
    let targetSlot: string | null = null;
    let forwardPath = url.pathname;

    // A. Header override (useful for API clients & proxying)
    const headerSlot = request.headers.get("X-Hatch-Slot");
    if (headerSlot && (allowedSlots.includes("*") || allowedSlots.includes(headerSlot))) {
      targetSlot = headerSlot;
    }

    // B. Path prefix fallback for *.workers.dev (e.g. /_slot/temp1/... or /temp1/...)
    if (!targetSlot) {
      if (url.pathname.startsWith("/_slot/")) {
        const parts = url.pathname.slice("/_slot/".length).split("/");
        const slotCandidate = parts[0];
        if (slotCandidate && (allowedSlots.includes("*") || allowedSlots.includes(slotCandidate))) {
          targetSlot = slotCandidate;
          forwardPath = "/" + parts.slice(1).join("/");
          if (forwardPath === "") forwardPath = "/";
        }
      } else {
        // Also support /<slot>/... if Host contains workers.dev or localhost
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length > 0) {
          const firstSegment = segments[0];
          if (allowedSlots.includes("*") || allowedSlots.includes(firstSegment) || firstSegment.startsWith("temp")) {
            targetSlot = firstSegment;
            forwardPath = "/" + segments.slice(1).join("/");
            if (forwardPath === "") forwardPath = "/";
          }
        }
      }
    }

    // C. Subdomain extraction from Host header (e.g. temp1.example.com)
    if (!targetSlot) {
      const host = request.headers.get("host") || "";
      targetSlot = extractSlotFromHost(host, allowedSlots);
    }

    // If still no slot could be determined, return friendly landing instructions
    if (!targetSlot) {
      return new Response(
        JSON.stringify(
          {
            service: "Hatch Edge Tunnel",
            status: "online",
            message: "No active slot identified in request Host header or path prefix.",
            usage: {
              subdomain: "https://<slot>.yourdomain.com/",
              workers_dev_fallback: "https://<worker>.workers.dev/_slot/<slot>/"
            },
            available_slots: allowedSlots
          },
          null,
          2
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // =========================================================================
    // 3. Edge Protections & Access Verification
    // =========================================================================
    const metaReq = new Request(`http://internal/_tunnel/slot-meta?slot=${encodeURIComponent(targetSlot)}`);
    const metaRes = await hub.fetch(metaReq);
    const meta = (await metaRes.json()) as {
      active: boolean;
      lockHash: string | null;
      onlyPrefix: string | null;
    };

    if (!meta.active) {
      return renderOfflinePage(targetSlot);
    }

    // Edge Path Filtering (--only /prefix)
    if (meta.onlyPrefix && !forwardPath.startsWith(meta.onlyPrefix)) {
      return renderForbiddenPage(targetSlot, forwardPath);
    }

    // Edge Lock Password Protection (--lock <password>)
    if (meta.lockHash) {
      let isAuthorized = false;

      // 1. Check HTTP Basic Authentication
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Basic ")) {
        try {
          const decoded = atob(authHeader.slice(6));
          const parts = decoded.split(":");
          const pass = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
          const hash = await hashPassword(pass);
          if (await timingSafeStringCompare(hash, meta.lockHash)) {
            isAuthorized = true;
          }
        } catch {
          // Base64 decode failure
        }
      }

      // 2. Check Session Cookie
      if (!isAuthorized) {
        const cookieVal = parseCookie(request.headers.get("Cookie"), `hatch_auth_${targetSlot}`);
        if (cookieVal && (await timingSafeStringCompare(cookieVal, meta.lockHash))) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        return renderLockGatePage(targetSlot);
      }
    }

    // =========================================================================
    // 4. Dispatch Request to Durable Object Hub
    // =========================================================================
    const forwardUrl = new URL(request.url);
    forwardUrl.pathname = forwardPath;

    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set("X-Target-Slot", targetSlot);

    const forwardRequest = new Request(forwardUrl.toString(), {
      method: request.method,
      headers: modifiedHeaders,
      body: request.body,
      redirect: "manual"
    });

    return hub.fetch(forwardRequest);
  }
};
