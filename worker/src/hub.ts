import { DurableObject } from "cloudflare:workers";
import {
  SlotMetadata,
  EdgeToClientMessage,
  ClientToEdgeMessage,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders
} from "./protocol";
import { renderOfflinePage, renderFullPage, renderTimeoutPage } from "./pages";

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  TUNNEL_PASSWORD?: string;
  ALLOWED_SLOTS?: string;
  DEFAULT_BASE_DOMAIN?: string;
}

interface PendingHttpRequest {
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  timer: any;
  slot: string;
}

export class TunnelHub extends DurableObject {
  private startTime: number = Date.now();
  private pendingRequests = new Map<string, PendingHttpRequest>();
  private visitorSockets = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private getAllowedSlots(): string[] {
    const raw = (this.env as Env).ALLOWED_SLOTS || "temp1,temp2,temp3,temp4,temp5";
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private getActiveSockets(): Map<string, WebSocket> {
    const active = new Map<string, WebSocket>();
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        const meta = ws.deserializeAttachment() as SlotMetadata | null;
        if (meta && meta.slot) {
          active.set(meta.slot, ws);
        }
      } catch {
        // Ignored if deserialization fails
      }
    }
    return active;
  }

  private findSocketForSlot(slot: string): WebSocket | undefined {
    const active = this.getActiveSockets();
    return active.get(slot);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. Control plane: CLI connection (WebSocket upgrade)
    if (url.pathname === "/_tunnel/connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const requestedSlot = url.searchParams.get("slot")?.trim() || null;
      const lockHash = url.searchParams.get("lock") || null;
      const onlyPrefix = url.searchParams.get("only") || null;

      const allowedSlots = this.getAllowedSlots();
      const isWildcard = allowedSlots.includes("*");
      const activeMap = this.getActiveSockets();

      let assignedSlot: string | null = null;

      if (requestedSlot) {
        if (!isWildcard && !allowedSlots.includes(requestedSlot)) {
          return new Response(`Slot '${requestedSlot}' is not in ALLOWED_SLOTS`, { status: 400 });
        }
        if (activeMap.has(requestedSlot)) {
          return new Response(`Slot '${requestedSlot}' is already occupied`, { status: 409 });
        }
        assignedSlot = requestedSlot;
      } else {
        // Auto-assign first available slot
        for (const slot of allowedSlots) {
          if (slot !== "*" && !activeMap.has(slot)) {
            assignedSlot = slot;
            break;
          }
        }
        if (!assignedSlot) {
          return renderFullPage(activeMap.size, allowedSlots.length);
        }
      }

      // Establish WebSocket pair
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);

      const metadata: SlotMetadata = {
        slot: assignedSlot,
        lockHash,
        onlyPrefix,
        connectedAt: Date.now()
      };

      this.ctx.acceptWebSocket(serverWs, [assignedSlot]);
      serverWs.serializeAttachment(metadata);

      // Send initial assignment frame
      const assignMsg: EdgeToClientMessage = {
        type: "assigned",
        slot: assignedSlot,
        activeCount: activeMap.size + 1,
        maxSlots: allowedSlots.length
      };
      serverWs.send(JSON.stringify(assignMsg));

      return new Response(null, {
        status: 101,
        webSocket: clientWs
      });
    }

    // 2. Control plane: Slot status & health check
    if (url.pathname === "/_tunnel/status") {
      const allowedSlots = this.getAllowedSlots();
      const activeMap = this.getActiveSockets();
      const slotsInfo = allowedSlots.map((slot) => {
        const ws = activeMap.get(slot);
        let meta: SlotMetadata | null = null;
        if (ws) {
          try {
            meta = ws.deserializeAttachment() as SlotMetadata;
          } catch {
            meta = null;
          }
        }
        return {
          slot,
          status: ws ? "LIVE" : "FREE",
          connectedAt: meta?.connectedAt || null,
          hasLock: Boolean(meta?.lockHash),
          onlyPrefix: meta?.onlyPrefix || null
        };
      });

      return new Response(
        JSON.stringify(
          {
            activeCount: activeMap.size,
            maxSlots: allowedSlots.length,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            slots: slotsInfo
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

    // 3. Slot metadata query endpoint
    if (url.pathname === "/_tunnel/slot-meta") {
      const slot = url.searchParams.get("slot");
      if (!slot) {
        return new Response("Missing slot param", { status: 400 });
      }
      const ws = this.findSocketForSlot(slot);
      if (!ws) {
        return new Response(JSON.stringify({ active: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const meta = ws.deserializeAttachment() as SlotMetadata;
      return new Response(
        JSON.stringify({
          active: true,
          lockHash: meta?.lockHash || null,
          onlyPrefix: meta?.onlyPrefix || null
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // 4. Dispatching visitor traffic to the active slot
    const targetSlot = request.headers.get("X-Target-Slot");
    if (!targetSlot) {
      return new Response("Missing X-Target-Slot header", { status: 400 });
    }

    const slotWs = this.findSocketForSlot(targetSlot);
    if (!slotWs) {
      return renderOfflinePage(targetSlot);
    }

    // Check if visitor request is a WebSocket upgrade (e.g. HMR or realtime chat)
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleVisitorWebSocket(request, slotWs, targetSlot);
    }

    // Standard HTTP request dispatching
    return this.handleVisitorHttpRequest(request, slotWs, targetSlot);
  }

  private async handleVisitorHttpRequest(request: Request, slotWs: WebSocket, slot: string): Promise<Response> {
    const reqId = crypto.randomUUID();
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") || undefined;
    const host = request.headers.get("host") || undefined;
    const sanitizedHeaders = sanitizeRequestHeaders(request.headers, clientIp, host);

    // Read body if present
    let bodyPayload: string | null = null;
    let isBase64 = false;

    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 0) {
        const bytes = new Uint8Array(buffer);
        let binaryString = "";
        for (let i = 0; i < bytes.length; i++) {
          binaryString += String.fromCharCode(bytes[i]);
        }
        bodyPayload = btoa(binaryString);
        isBase64 = true;
      }
    }

    const outboundMsg: EdgeToClientMessage = {
      type: "http_req",
      reqId,
      method: request.method,
      url: url.pathname + url.search,
      headers: sanitizedHeaders,
      body: bodyPayload,
      isBase64
    };

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(renderTimeoutPage(slot, 30000));
      }, 30000);

      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        timer,
        slot
      });

      try {
        slotWs.send(JSON.stringify(outboundMsg));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        resolve(renderOfflinePage(slot));
      }
    });
  }

  private handleVisitorWebSocket(request: Request, slotWs: WebSocket, slot: string): Response {
    const pair = new WebSocketPair();
    const [visitorClient, visitorServer] = Object.values(pair);
    const connId = crypto.randomUUID();

    visitorServer.accept();
    this.visitorSockets.set(connId, visitorServer);

    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") || undefined;
    const host = request.headers.get("host") || undefined;
    const sanitizedHeaders = sanitizeRequestHeaders(request.headers, clientIp, host);

    // Notify CLI of new WebSocket connection
    const openMsg: EdgeToClientMessage = {
      type: "ws_open",
      connId,
      url: url.pathname + url.search,
      headers: sanitizedHeaders
    };
    try {
      slotWs.send(JSON.stringify(openMsg));
    } catch {
      return renderOfflinePage(slot);
    }

    visitorServer.addEventListener("message", (event) => {
      let isBinary = false;
      let data = "";
      if (typeof event.data === "string") {
        data = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        isBinary = true;
        const bytes = new Uint8Array(event.data);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        data = btoa(bin);
      }
      const frameMsg: EdgeToClientMessage = {
        type: "ws_frame",
        connId,
        data,
        isBinary
      };
      try {
        slotWs.send(JSON.stringify(frameMsg));
      } catch {
        visitorServer.close(1011, "Slot disconnected");
      }
    });

    visitorServer.addEventListener("close", (event) => {
      this.visitorSockets.delete(connId);
      const closeMsg: EdgeToClientMessage = {
        type: "ws_close",
        connId,
        code: event.code,
        reason: event.reason
      };
      try {
        slotWs.send(JSON.stringify(closeMsg));
      } catch {
        // Socket already closed
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: visitorClient
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let parsed: ClientToEdgeMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    // 1. Correlate HTTP response from CLI
    if (parsed.type === "http_res") {
      const pending = this.pendingRequests.get(parsed.reqId);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pendingRequests.delete(parsed.reqId);

      const respHeaders = sanitizeResponseHeaders(parsed.headers);

      let body: BodyInit | null = null;
      if (parsed.body !== null) {
        if (parsed.isBase64) {
          const binStr = atob(parsed.body);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
          body = bytes;
        } else {
          body = parsed.body;
        }
      }

      const response = new Response(body, {
        status: parsed.status,
        statusText: parsed.statusText,
        headers: respHeaders
      });

      pending.resolve(response);
      return;
    }

    // 2. Correlate WebSocket passthrough frame from CLI to visitor
    if (parsed.type === "ws_frame") {
      const visitor = this.visitorSockets.get(parsed.connId);
      if (!visitor) return;

      if (parsed.isBinary) {
        const binStr = atob(parsed.data);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        visitor.send(bytes.buffer);
      } else {
        visitor.send(parsed.data);
      }
      return;
    }

    // 3. Correlate WebSocket close from CLI
    if (parsed.type === "ws_close") {
      const visitor = this.visitorSockets.get(parsed.connId);
      if (visitor) {
        visitor.close(parsed.code, parsed.reason);
        this.visitorSockets.delete(parsed.connId);
      }
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    let meta: SlotMetadata | null = null;
    try {
      meta = ws.deserializeAttachment() as SlotMetadata;
    } catch {
      meta = null;
    }

    if (meta && meta.slot) {
      // 3-second grace period before failing pending requests for this slot
      setTimeout(() => {
        const currentActive = this.findSocketForSlot(meta!.slot);
        if (!currentActive) {
          for (const [reqId, pending] of this.pendingRequests.entries()) {
            if (pending.slot === meta!.slot) {
              clearTimeout(pending.timer);
              this.pendingRequests.delete(reqId);
              pending.resolve(renderOfflinePage(meta!.slot));
            }
          }
        }
      }, 3000);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    try {
      ws.close(1011, "Durable Object WebSocket error");
    } catch {
      // Already closed
    }
  }
}
