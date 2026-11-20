import argparse
import asyncio
import getpass
import json
import os
import signal
import sys
import urllib.request
import urllib.error
from typing import Optional

from .config import load_config, ensure_config, prompt_config_interactive, validate_config, get_config_path


def get_tunnel_password() -> str:
    env_pass = os.environ.get("TUNNEL_PASSWORD")
    if env_pass:
        return env_pass.strip()
    try:
        pw = getpass.getpass("Tunnel Password: ")
        return pw.strip()
    except (KeyboardInterrupt, EOFError):
        print("\nAborted.")
        sys.exit(1)


def cmd_init():
    current = load_config()
    prompt_config_interactive(current)


def cmd_status():
    config = ensure_config()
    worker_url = config.get("worker_url", "").rstrip("/")
    password = get_tunnel_password()

    status_url = f"{worker_url}/_tunnel/status"
    req = urllib.request.Request(
        status_url,
        headers={"X-Tunnel-Password": password, "User-Agent": "Hatch-CLI/1.0"}
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))

            print(f"\n\033[1;36m=== Hatch Edge Status ===\033[0m")
            print(f"Worker: \033[33m{worker_url}\033[0m")
            print(f"Active Tunnels: \033[1;32m{data.get('activeCount', 0)}\033[0m / {data.get('maxSlots', 0)}")
            print(f"Uptime: {data.get('uptimeSeconds', 0)}s\n")

            print(f"{'SLOT':<12} {'STATE':<10} {'PROTECTION':<14} {'PATH FILTER':<14}")
            print(f"{'─' * 52}")

            for s in data.get("slots", []):
                slot_name = s.get("slot")
                is_live = s.get("status") == "LIVE"
                state_str = "\033[1;32mLIVE\033[0m" if is_live else "\033[90mFREE\033[0m"
                lock_str = "\033[33m🔒 Locked\033[0m" if s.get("hasLock") else "Public"
                only_str = s.get("onlyPrefix") or "/*"
                print(f"{slot_name:<12} {state_str:<19} {lock_str:<23} {only_str:<14}")
            print()

    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("\033[31m[!] Error: Unauthorized (401). Invalid TUNNEL_PASSWORD.\033[0m")
        else:
            print(f"\033[31m[!] Edge returned error {e.code}: {e.reason}\033[0m")
        sys.exit(1)
    except Exception as e:
        print(f"\033[31m[!] Failed to reach Hatch edge: {e}\033[0m")
        sys.exit(1)


def cmd_doctor():
    print("\n\033[1;36m=== Hatch Diagnostic Doctor ===\033[0m\n")

    # Step 1: Config file check
    cfg_path = get_config_path()
    print(f"[1/4] Checking configuration at {cfg_path} ...", end=" ")
    config = load_config()
    is_valid, missing = validate_config(config)
    if not is_valid:
        print("\033[31mFAIL\033[0m")
        print(f"      Missing keys: {', '.join(missing)}")
        print("      Run \033[1;33mhatch init\033[0m to configure.\n")
        return
    print("\033[32mOK\033[0m")

    worker_url = config.get("worker_url", "").rstrip("/")
    base_domain = config.get("base_domain", "")

    # Step 2: Worker TLS & connectivity
    print(f"[2/4] Testing reachability to {worker_url} ...", end=" ")
    try:
        req = urllib.request.Request(worker_url, headers={"User-Agent": "Hatch-Doctor/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("\033[32mOK\033[0m")
    except urllib.error.HTTPError as e:
        print(f"\033[32mOK\033[0m (HTTP {e.code})")
    except Exception as e:
        print("\033[31mFAIL\033[0m")
        print(f"      Could not connect to Worker: {e}\n")
        return

    # Step 3: Edge status & password authentication
    print(f"[3/4] Testing TUNNEL_PASSWORD authentication against edge ...")
    password = get_tunnel_password()
    status_url = f"{worker_url}/_tunnel/status"
    try:
        req = urllib.request.Request(
            status_url,
            headers={"X-Tunnel-Password": password, "User-Agent": "Hatch-Doctor/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"      \033[32m✔ Authenticated successfully!\033[0m Available slots: {data.get('maxSlots', 0)}")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("      \033[31m✘ Authentication Failed: Invalid TUNNEL_PASSWORD configured in Worker secret.\033[0m")
        else:
            print(f"      \033[31m✘ Edge responded with HTTP {e.code}\033[0m")
        return
    except Exception as e:
        print(f"      \033[31m✘ Failed: {e}\033[0m")
        return

    # Step 4: Domain DNS check
    print(f"[4/4] Checking base domain routing ({base_domain or 'workers.dev fallback'}) ...", end=" ")
    if base_domain:
        print("\033[32mCONFIGURED\033[0m")
        print(f"      Tunnels will be assigned at: https://<slot>.{base_domain}")
    else:
        print("\033[33mFALLBACK\033[0m")
        print(f"      Tunnels will be accessible at: {worker_url}/_slot/<slot>")

    print("\n\033[1;32m✔ All checks passed! Hatch is ready to host tunnels.\033[0m\n")


def cmd_host(args):
    try:
        from .tunnel import TunnelClient
    except ImportError as e:
        print(f"\033[31m[!] Missing dependency: {e}.\033[0m")
        print("    Please run \033[1;33m./cli/install.sh\033[0m or install requirements: \033[1;33mpip install -r cli/requirements.txt\033[0m")
        sys.exit(1)

    config = ensure_config()
    worker_url = config.get("worker_url", "")
    base_domain = config.get("base_domain", "")

    port = args.port
    if not port:
        print("\033[31mError: Port number is required (e.g. `hatch host 3000` or `hatch host -p 3000`)\033[0m")
        sys.exit(1)

    password = get_tunnel_password()

    client = TunnelClient(
        worker_url=worker_url,
        base_domain=base_domain,
        local_port=port,
        tunnel_password=password,
        slot=args.slot,
        lock_password=args.lock,
        only_prefix=args.only
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def handle_signal():
        asyncio.create_task(client.close())

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_signal)
        except NotImplementedError:
            pass

    try:
        loop.run_until_complete(client.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.run_until_complete(client.close())
        loop.close()
        print("\n\033[32m✔ Tunnel closed cleanly.\033[0m")


def main():
    # Handle natural and flag-based syntax
    raw_args = sys.argv[1:]

    # Normalize flag-style `-host` or `--host` into subcommand `host`
    normalized_args = []
    for arg in raw_args:
        if arg in ("-host", "--host"):
            normalized_args.append("host")
        else:
            normalized_args.append(arg)

    parser = argparse.ArgumentParser(
        prog="hatch",
        description="Hatch: Zero-VPS, self-hosted localhost-to-edge tunneling client"
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # Command: init
    subparsers.add_parser("init", help="Interactive initial configuration wizard")

    # Command: status
    subparsers.add_parser("status", help="Display status of all edge tunnel slots")

    # Command: doctor
    subparsers.add_parser("doctor", help="Verify configuration, edge reachability and authentication")

    # Command: host
    host_parser = subparsers.add_parser("host", help="Expose a local port through a live edge tunnel")
    host_parser.add_argument("pos_port", nargs="?", type=int, help="Local port (e.g. 3000)")
    host_parser.add_argument("-p", "--port", type=int, help="Local port flag")
    host_parser.add_argument("-s", "--slot", type=str, help="Claim a specific slot (e.g. temp3)")
    host_parser.add_argument("--lock", type=str, help="Edge password protection for visitors")
    host_parser.add_argument("--only", type=str, help="Restrict exposed paths (e.g. /api/webhook)")

    args = parser.parse_args(normalized_args)

    if not args.command:
        # Default behavior: if a single number was passed, treat as `hatch host <port>`
        if len(normalized_args) == 1 and normalized_args[0].isdigit():
            port_val = int(normalized_args[0])
            ns = argparse.Namespace(
                command="host",
                port=port_val,
                slot=None,
                lock=None,
                only=None
            )
            cmd_host(ns)
            return

        parser.print_help()
        sys.exit(0)

    if args.command == "init":
        cmd_init()
    elif args.command == "status":
        cmd_status()
    elif args.command == "doctor":
        cmd_doctor()
    elif args.command == "host":
        port = args.pos_port or args.port
        args.port = port
        cmd_host(args)


if __name__ == "__main__":
    main()
