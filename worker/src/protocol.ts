export interface SlotMetadata {
  slot: string;
  lockHash: string | null;
  onlyPrefix: string | null;
  connectedAt: number;
}

export type EdgeToClientMessage =
  | {
      type: "assigned";
      slot: string;
      activeCount: number;
      maxSlots: number;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "http_req";
      reqId: string;
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string | null;
      isBase64: boolean;
    }
  | {
      type: "ws_open";
      connId: string;
      url: string;
      headers: Record<string, string>;
    }
  | {
      type: "ws_frame";
      connId: string;
      data: string;
      isBinary: boolean;
    }
  | {
      type: "ws_close";
      connId: string;
      code: number;
      reason: string;
    };

export type ClientToEdgeMessage =
  | {
      type: "pong";
      timestamp: number;
    }
  | {
      type: "http_res";
      reqId: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string | null;
      isBase64: boolean;
    }
  | {
      type: "ws_frame";
      connId: string;
      data: string;
      isBinary: boolean;
    }
  | {
      type: "ws_close";
      connId: string;
      code: number;
      reason: string;
    };

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "cf-ray",
  "cf-visitor",
  "cf-connecting-ip",
  "x-real-ip"
]);

export function sanitizeRequestHeaders(headers: Headers, clientIp?: string, host?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower)) {
      result[lower] = value;
    }
  }
  if (clientIp && !result["x-forwarded-for"]) {
    result["x-forwarded-for"] = clientIp;
  }
  if (host) {
    result["x-forwarded-host"] = host;
  }
  result["x-forwarded-proto"] = "https";
  return result;
}

export function sanitizeResponseHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower)) {
      result.set(key, value);
    }
  }
  return result;
}

export async function timingSafeStringCompare(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // Perform dummy comparison to keep execution time consistent
    const dummy = new Uint8Array(aBuf.byteLength);
    crypto.subtle.timingSafeEqual(aBuf, dummy);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

export async function hashPassword(password: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
