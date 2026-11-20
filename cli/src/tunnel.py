import asyncio
import base64
import json
import logging
import ssl
import sys
import urllib.parse
from typing import Optional, Dict, Any

import aiohttp
import websockets

from .inspector import RequestInspector, CapturedRequest

logger = logging.getLogger("hatch.tunnel")

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade"
}


class TunnelClient:
    def __init__(
        self,
        worker_url: str,
        base_domain: str,
        local_port: int,
        tunnel_password: str,
        slot: Optional[str] = None,
        lock_password: Optional[str] = None,
        only_prefix: Optional[str] = None
    ):
        self.worker_url = worker_url.rstrip("/")
        self.base_domain = base_domain.strip().lstrip(".")
        self.local_port = local_port
        self.tunnel_password = tunnel_password
        self.requested_slot = slot
        self.lock_password = lock_password
        self.only_prefix = only_prefix

        self.assigned_slot: Optional[str] = None
        self.inspector: Optional[RequestInspector] = None
        self.ws_connections: Dict[str, aiohttp.ClientWebSocketResponse] = {}
        self.http_session: Optional[aiohttp.ClientSession] = None
        self.running = False
        self.reconnect_delay = 1.0

    def get_public_url(self, slot: str) -> str:
        if self.base_domain:
            return f"https://{slot}.{self.base_domain}"
        # Fallback to workers.dev path
        return f"{self.worker_url}/_slot/{slot}"

    async def replay_request(self, req: CapturedRequest):
        if not self.http_session:
            return

        target_url = f"http://127.0.0.1:{self.local_port}{req.path}"
        headers = dict(req.headers)
        headers["host"] = f"127.0.0.1:{self.local_port}"

        body_data = None
        if req.body:
            body_data = base64.b64decode(req.body) if req.is_base64 else req.body.encode("utf-8")

        start_time = asyncio.get_event_loop().time()
        try:
            async with self.http_session.request(
                method=req.method,
                url=target_url,
                headers=headers,
                data=body_data,
                timeout=aiohttp.ClientTimeout(total=15),
                allow_redirects=False
            ) as resp:
                data = await resp.read()
                elapsed = (asyncio.get_event_loop().time() - start_time) * 1000
                print(f"\033[32m✔ Replayed [{resp.status}] in {elapsed:.0f}ms ({len(data)} bytes)\033[0m")
        except Exception as e:
            print(f"\033[31m✘ Replay failed: {e}\033[0m")

    async def handle_http_request(self, edge_ws, msg: Dict[str, Any]):
        req_id = msg["reqId"]
        method = msg["method"]
        url_path = msg["url"]
        headers = msg.get("headers", {})
        raw_body = msg.get("body")
        is_base64 = msg.get("isBase64", False)

        if self.inspector:
            self.inspector.record_request(req_id, method, url_path, headers, raw_body, is_base64)

        # Build local target URL
        local_url = f"http://127.0.0.1:{self.local_port}{url_path}"

        # Clean headers for local forwarder
        forward_headers = {}
        for k, v in headers.items():
            if k.lower() not in HOP_BY_HOP:
                forward_headers[k] = v
        forward_headers["host"] = f"127.0.0.1:{self.local_port}"

        body_bytes = None
        if raw_body is not None:
            body_bytes = base64.b64decode(raw_body) if is_base64 else raw_body.encode("utf-8")

        try:
            async with self.http_session.request(
                method=method,
                url=local_url,
                headers=forward_headers,
                data=body_bytes,
                timeout=aiohttp.ClientTimeout(total=28),
                allow_redirects=False
            ) as local_res:
                content = await local_res.read()

                # Clean response headers
                res_headers = {}
                for k, v in local_res.headers.items():
                    if k.lower() not in HOP_BY_HOP:
                        res_headers[k] = v

                encoded_body = base64.b64encode(content).decode("ascii") if content else None

                res_msg = {
                    "type": "http_res",
                    "reqId": req_id,
                    "status": local_res.status,
                    "statusText": local_res.reason or "OK",
                    "headers": res_headers,
                    "body": encoded_body,
                    "isBase64": True
                }

                await edge_ws.send(json.dumps(res_msg))

                if self.inspector:
                    self.inspector.complete_request(req_id, local_res.status, len(content))

        except Exception as err:
            err_body = f"Hatch local forwarder error: {err}".encode("utf-8")
            err_msg = {
                "type": "http_res",
                "reqId": req_id,
                "status": 502,
                "statusText": "Bad Gateway",
                "headers": {"content-type": "text/plain; charset=utf-8"},
                "body": base64.b64encode(err_body).decode("ascii"),
                "isBase64": True
            }
            try:
                await edge_ws.send(json.dumps(err_msg))
            except Exception:
                pass

            if self.inspector:
                self.inspector.complete_request(req_id, 502, len(err_body))

    async def handle_ws_open(self, edge_ws, msg: Dict[str, Any]):
        conn_id = msg["connId"]
        url_path = msg["url"]
        headers = msg.get("headers", {})

        local_ws_url = f"ws://127.0.0.1:{self.local_port}{url_path}"
        forward_headers = {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP}
        forward_headers["host"] = f"127.0.0.1:{self.local_port}"

        try:
            local_ws = await self.http_session.ws_connect(
                local_ws_url,
                headers=forward_headers,
                autoping=True
            )
            self.ws_connections[conn_id] = local_ws

            # Background task forwarding frames from local WS to edge
            asyncio.create_task(self.forward_local_ws_to_edge(conn_id, local_ws, edge_ws))
        except Exception:
            close_frame = {
                "type": "ws_close",
                "connId": conn_id,
                "code": 1011,
                "reason": "Local WebSocket connection failed"
            }
            await edge_ws.send(json.dumps(close_frame))

    async def forward_local_ws_to_edge(self, conn_id: str, local_ws: aiohttp.ClientWebSocketResponse, edge_ws):
        try:
            async for frame in local_ws:
                if frame.type == aiohttp.WSMsgType.TEXT:
                    await edge_ws.send(json.dumps({
                        "type": "ws_frame",
                        "connId": conn_id,
                        "data": frame.data,
                        "isBinary": False
                    }))
                elif frame.type == aiohttp.WSMsgType.BINARY:
                    b64_data = base64.b64encode(frame.data).decode("ascii")
                    await edge_ws.send(json.dumps({
                        "type": "ws_frame",
                        "connId": conn_id,
                        "data": b64_data,
                        "isBinary": True
                    }))
                elif frame.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                    break
        except Exception:
            pass
        finally:
            self.ws_connections.pop(conn_id, None)
            try:
                await edge_ws.send(json.dumps({
                    "type": "ws_close",
                    "connId": conn_id,
                    "code": 1000,
                    "reason": "Closed normally"
                }))
            except Exception:
                pass

    async def handle_ws_frame(self, msg: Dict[str, Any]):
        conn_id = msg["connId"]
        local_ws = self.ws_connections.get(conn_id)
        if not local_ws or local_ws.closed:
            return

        is_binary = msg.get("isBinary", False)
        data = msg.get("data", "")

        try:
            if is_binary:
                raw_bytes = base64.b64decode(data)
                await local_ws.send_bytes(raw_bytes)
            else:
                await local_ws.send_str(data)
        except Exception:
            pass

    async def handle_ws_close(self, msg: Dict[str, Any]):
        conn_id = msg["connId"]
        local_ws = self.ws_connections.pop(conn_id, None)
        if local_ws and not local_ws.closed:
            await local_ws.close(code=msg.get("code", 1000), message=msg.get("reason", "").encode("utf-8"))

    async def keepalive_loop(self, edge_ws):
        """Send WebSocket keepalive ping every 20 seconds to prevent double-NAT timeouts."""
        while self.running:
            await asyncio.sleep(20)
            try:
                ping_frame = {"type": "pong", "timestamp": int(asyncio.get_event_loop().time() * 1000)}
                await edge_ws.send(json.dumps(ping_frame))
            except Exception:
                break

    async def start(self):
        self.running = True
        self.http_session = aiohttp.ClientSession()

        # Format WebSocket endpoint
        ws_scheme = "wss" if self.worker_url.startswith("https") else "ws"
        netloc = self.worker_url.split("://", 1)[1]
        endpoint = f"{ws_scheme}://{netloc}/_tunnel/connect"

        params = {}
        if self.requested_slot:
            params["slot"] = self.requested_slot
        if self.lock_password:
            import hashlib
            params["lock"] = hashlib.sha256(self.lock_password.encode("utf-8")).hexdigest()
        if self.only_prefix:
            params["only"] = self.only_prefix

        if params:
            endpoint += "?" + urllib.parse.urlencode(params)

        headers = {
            "X-Tunnel-Password": self.tunnel_password
        }

        while self.running:
            try:
                ssl_context = None
                if ws_scheme == "wss":
                    ssl_context = ssl.create_default_context()

                async with websockets.connect(
                    endpoint,
                    additional_headers=headers,
                    ssl=ssl_context,
                    ping_interval=None,
                    max_size=32 * 1024 * 1024
                ) as edge_ws:
                    self.reconnect_delay = 1.0  # Reset reconnect delay on success

                    # Read initial assignment message
                    raw_init = await edge_ws.recv()
                    init_msg = json.parse(raw_init) if hasattr(json, "parse") else json.loads(raw_init)

                    if init_msg.get("type") == "error":
                        print(f"\033[31m[!] Edge error: {init_msg.get('message')}\033[0m")
                        return

                    if init_msg.get("type") != "assigned":
                        print(f"\033[31m[!] Unexpected initialization frame from edge: {init_msg}\033[0m")
                        return

                    self.assigned_slot = init_msg["slot"]
                    active_count = init_msg["activeCount"]
                    max_slots = init_msg["maxSlots"]

                    public_url = self.get_public_url(self.assigned_slot)
                    self.inspector = RequestInspector(
                        local_port=self.local_port,
                        public_url=public_url,
                        slot=self.assigned_slot,
                        active_count=active_count,
                        max_slots=max_slots
                    )
                    self.inspector.set_replay_handler(self.replay_request)
                    self.inspector.print_banner()

                    # Start background keepalive & hotkey listener
                    keepalive_task = asyncio.create_task(self.keepalive_loop(edge_ws))
                    hotkey_task = asyncio.create_task(self.inspector.start_hotkey_listener())

                    try:
                        async for raw_frame in edge_ws:
                            msg = json.loads(raw_frame)
                            mtype = msg.get("type")

                            if mtype == "http_req":
                                asyncio.create_task(self.handle_http_request(edge_ws, msg))
                            elif mtype == "ws_open":
                                asyncio.create_task(self.handle_ws_open(edge_ws, msg))
                            elif mtype == "ws_frame":
                                asyncio.create_task(self.handle_ws_frame(msg))
                            elif mtype == "ws_close":
                                asyncio.create_task(self.handle_ws_close(msg))
                    finally:
                        keepalive_task.cancel()
                        hotkey_task.cancel()
                        if self.inspector:
                            self.inspector.restore_terminal()

            except websockets.exceptions.InvalidStatusCode as e:
                if e.status_code == 401:
                    print(f"\n\033[31m✘ Authentication Failed (401): Incorrect TUNNEL_PASSWORD.\033[0m")
                    return
                elif e.status_code == 409:
                    print(f"\n\033[31m✘ Slot Conflict (409): Slot '{self.requested_slot}' is already in use.\033[0m")
                    return
                elif e.status_code == 503:
                    print(f"\n\033[31m✘ Service Unavailable (503): All tunnel slots are occupied.\033[0m")
                    return
                else:
                    print(f"\n\033[31m✘ Edge rejected connection: HTTP {e.status_code}\033[0m")
                    return

            except (websockets.exceptions.ConnectionClosedError, ConnectionResetError, OSError) as e:
                if not self.running:
                    break
                print(f"\n\033[33m[!] Disconnected ({e}). Reconnecting in {self.reconnect_delay:.1f}s...\033[0m")
                await asyncio.sleep(self.reconnect_delay)
                self.reconnect_delay = min(self.reconnect_delay * 1.5, 10.0)

            except Exception as e:
                if not self.running:
                    break
                print(f"\n\033[31m[!] Tunnel error: {e}\033[0m")
                await asyncio.sleep(2.0)

    async def close(self):
        self.running = False
        if self.inspector:
            self.inspector.restore_terminal()

        # Close all active visitor WebSockets
        for ws in self.ws_connections.values():
            if not ws.closed:
                await ws.close()
        self.ws_connections.clear()

        if self.http_session and not self.http_session.closed:
            await self.http_session.close()
