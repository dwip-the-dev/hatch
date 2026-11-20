import json
import os
import sys
from pathlib import Path
from typing import Dict, Any, Tuple, List, Optional

CONFIG_DIR = Path.home() / ".config" / "hatch"
CONFIG_FILE = CONFIG_DIR / "config.json"


def get_config_path() -> Path:
    return CONFIG_FILE


def load_config() -> Optional[Dict[str, Any]]:
    if not CONFIG_FILE.exists():
        return None
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"\033[31m[!] Error reading configuration from {CONFIG_FILE}: {e}\033[0m", file=sys.stderr)
        return None


def save_config(config: Dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    os.chmod(CONFIG_FILE, 0o600)


def validate_config(config: Optional[Dict[str, Any]]) -> Tuple[bool, List[str]]:
    if not config:
        return False, ["worker_url", "base_domain"]

    missing = []
    worker_url = config.get("worker_url", "").strip()
    if not worker_url:
        missing.append("worker_url")
    elif not (worker_url.startswith("https://") or worker_url.startswith("http://")):
        missing.append("worker_url (must start with https:// or http://)")

    base_domain = config.get("base_domain", "").strip()
    if not base_domain and not ("workers.dev" in worker_url or "localhost" in worker_url):
        missing.append("base_domain")

    return (len(missing) == 0, missing)


def prompt_config_interactive(existing: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    print("\n\033[1;36m=== Hatch Configuration Setup ===\033[0m")
    print(f"Configuration file location: \033[33m{CONFIG_FILE}\033[0m\n")

    current = existing or {}
    prev_worker = current.get("worker_url", "")
    prev_domain = current.get("base_domain", "")

    try:
        # Prompt Worker URL
        default_worker_prompt = f" [{prev_worker}]" if prev_worker else ""
        worker_input = input(f"Cloudflare Worker URL (e.g. https://hatch.yourdomain.com or https://hatch.user.workers.dev){default_worker_prompt}: ").strip()
        worker_url = worker_input if worker_input else prev_worker

        while not worker_url or not (worker_url.startswith("https://") or worker_url.startswith("http://")):
            print("\033[31mError: Worker URL must begin with https:// or http://\033[0m")
            worker_url = input("Cloudflare Worker URL: ").strip()

        # Clean trailing slash
        worker_url = worker_url.rstrip("/")

        # Prompt Base Domain
        default_domain_prompt = f" [{prev_domain}]" if prev_domain else ""
        domain_input = input(f"Base Domain for subdomains (e.g. yourdomain.com or user.dedyn.io, leave empty if testing workers.dev fallback){default_domain_prompt}: ").strip()
        base_domain = domain_input if domain_input else prev_domain
        base_domain = base_domain.lstrip(".").rstrip("/")

    except (KeyboardInterrupt, EOFError):
        print("\n\033[31mConfiguration setup aborted.\033[0m")
        sys.exit(1)

    config = {
        "worker_url": worker_url,
        "base_domain": base_domain
    }

    save_config(config)
    print(f"\033[32m✔ Configuration saved successfully to {CONFIG_FILE}\033[0m\n")
    return config


def ensure_config() -> Dict[str, Any]:
    config = load_config()
    is_valid, missing = validate_config(config)
    if not is_valid:
        print("\n\033[33m[!] Hatch configuration is missing or incomplete.\033[0m")
        if missing:
            print(f"    Missing parameters: \033[1;31m{', '.join(missing)}\033[0m")
        print("    Launching interactive configuration wizard now...\n")
        return prompt_config_interactive(config)
    return config
