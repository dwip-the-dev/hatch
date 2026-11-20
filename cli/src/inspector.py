import asyncio
import collections
import os
import sys
import time
from typing import Optional, Dict, Any, List

# Check if stdin is an interactive TTY
IS_TTY = sys.stdin.isatty()

if IS_TTY and os.name == "posix":
    import termios
    import tty


class CapturedRequest:
    def __init__(
        self,
        req_id: str,
        method: str,
        path: str,
        headers: Dict[str, str],
        body: Optional[str],
        is_base64: bool
    ):
        self.req_id = req_id
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
        self.is_base64 = is_base64
        self.start_time = time.time()
        self.status: Optional[int] = None
        self.duration_ms: float = 0.0
        self.res_bytes: int = 0


class RequestInspector:
    def __init__(self, local_port: int, public_url: str, slot: str, active_count: int, max_slots: int):
        self.local_port = local_port
        self.public_url = public_url
        self.slot = slot
        self.active_count = active_count
        self.max_slots = max_slots
        self.history: collections.deque = collections.deque(maxlen=50)
        self.active_requests: Dict[str, CapturedRequest] = {}
        self.running = False
        self._replay_callback = None
        self._orig_termios = None

    def print_banner(self):
        sys.stdout.write("\033[2J\033[H")  # Clear screen and move to top
        banner = (
            f"\n\033[1;32m● LIVE\033[0m  "
            f"\033[1;36m{self.public_url}\033[0m  "
            f"\033[1;30m--->\033[0m  "
            f"\033[1;33mhttp://127.0.0.1:{self.local_port}\033[0m  "
            f"\033[90m(Slot {self.slot} · {self.active_count}/{self.max_slots} active)\033[0m\n"
            f"\033[90mHotkeys: [r] Replay last request | [l] List recent requests | [Ctrl+C] Disconnect\033[0m\n"
            f"\033[90m{'─' * 76}\033[0m\n"
        )
        sys.stdout.write(banner)
        sys.stdout.flush()

    def record_request(
        self,
        req_id: str,
        method: str,
        path: str,
        headers: Dict[str, str],
        body: Optional[str],
        is_base64: bool
    ) -> CapturedRequest:
        req = CapturedRequest(req_id, method, path, headers, body, is_base64)
        self.active_requests[req_id] = req
        return req

    def complete_request(self, req_id: str, status: int, res_bytes: int = 0):
        req = self.active_requests.pop(req_id, None)
        if not req:
            return

        req.status = status
        req.duration_ms = (time.time() - req.start_time) * 1000
        req.res_bytes = res_bytes
        self.history.append(req)

        # Format color based on HTTP status
        if 200 <= status < 300:
            status_color = "\033[1;32m"  # Green
        elif 300 <= status < 400:
            status_color = "\033[1;36m"  # Cyan
        elif 400 <= status < 500:
            status_color = "\033[1;33m"  # Yellow
        else:
            status_color = "\033[1;31m"  # Red

        size_str = f"{res_bytes}B" if res_bytes < 1024 else f"{res_bytes / 1024:.1f}KB"
        dur_str = f"{req.duration_ms:.0f}ms" if req.duration_ms < 1000 else f"{req.duration_ms / 1000:.2f}s"

        line = (
            f"{status_color}[{status}]\033[0m "
            f"\033[1m{req.method:<6}\033[0m "
            f"{req.path:<38} "
            f"\033[90m{dur_str:>6}  {size_str:>8}\033[0m\n"
        )
        sys.stdout.write(line)
        sys.stdout.flush()

    def set_replay_handler(self, callback):
        self._replay_callback = callback

    def list_history(self):
        sys.stdout.write("\n\033[1;37m--- Captured Requests (Last 15) ---\033[0m\n")
        if not self.history:
            sys.stdout.write("  No requests recorded yet.\n")
        else:
            items = list(self.history)[-15:]
            for idx, r in enumerate(items, 1):
                st = r.status or 0
                c = "\033[32m" if st < 400 else "\033[31m"
                sys.stdout.write(
                    f"  {idx:2d}. {c}[{st}]\033[0m {r.method:<6} {r.path:<32} {r.duration_ms:.0f}ms ({r.res_bytes}B)\n"
                )
        sys.stdout.write("\033[90m----------------------------------\033[0m\n")
        sys.stdout.flush()

    async def start_hotkey_listener(self):
        if not IS_TTY or os.name != "posix":
            return

        self.running = True
        fd = sys.stdin.fileno()
        try:
            self._orig_termios = termios.tcgetattr(fd)
            tty.setcbreak(fd)
        except Exception:
            return

        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        try:
            while self.running:
                ch = await reader.read(1)
                if not ch:
                    break
                char = ch.decode("utf-8", errors="ignore").lower()

                if char == "r":
                    if self.history and self._replay_callback:
                        last_req = self.history[-1]
                        sys.stdout.write(f"\n\033[33m⚡ Replaying [{last_req.method} {last_req.path}]...\033[0m\n")
                        sys.stdout.flush()
                        asyncio.create_task(self._replay_callback(last_req))
                    else:
                        sys.stdout.write("\n\033[90m(No requests captured yet to replay)\033[0m\n")
                        sys.stdout.flush()

                elif char == "l":
                    self.list_history()

                elif char == "\x03":  # Ctrl+C
                    os.kill(os.getpid(), 2)
                    break
        finally:
            self.restore_terminal()

    def restore_terminal(self):
        if self._orig_termios and os.name == "posix":
            try:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self._orig_termios)
            except Exception:
                pass
            self._orig_termios = None
