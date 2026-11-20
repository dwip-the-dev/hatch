#!/usr/bin/env bash
set -e

# Hatch Zero-Friction CLI Installer
# Supports Linux, macOS, WSL, and Termux

CYAN='\033[1;36m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NC='\033[0m'

echo -e "${CYAN}=== Installing Hatch CLI ===${NC}"

# Detect repository root directory
SCRIPT_DIR="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REQ_FILE="$SCRIPT_DIR/requirements.txt"
BIN_FILE="$SCRIPT_DIR/bin/hatch"

# 1. Check Python 3
if ! command -v python3 >/dev/null 2>&1; then
  echo -e "${RED}[!] python3 could not be found. Please install Python 3.9+ to continue.${NC}" >&2
  exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo -e "Found Python ${GREEN}$PY_VERSION${NC}"

# 2. Setup isolated virtual environment in ~/.local/share/hatch/venv
INSTALL_DIR="$HOME/.local/share/hatch"
VENV_DIR="$INSTALL_DIR/venv"

echo -e "Setting up isolated virtual environment in ${YELLOW}$VENV_DIR${NC}..."
mkdir -p "$INSTALL_DIR"
python3 -m venv "$VENV_DIR"

# Upgrade pip & install requirements
echo -e "Installing dependencies (aiohttp, websockets)..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$REQ_FILE"

# 3. Create symlink to ~/.local/bin/hatch
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
chmod +x "$BIN_FILE"

TARGET_LINK="$LOCAL_BIN/hatch"
ln -sf "$BIN_FILE" "$TARGET_LINK"
echo -e "Symlinked Hatch executable to ${GREEN}$TARGET_LINK${NC}"

# 4. PATH verification
echo ""
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  echo -e "${YELLOW}[!] Warning: $LOCAL_BIN is not currently in your system PATH.${NC}"
  echo "    To make 'hatch' available anywhere, add the following to your ~/.bashrc or ~/.zshrc:"
  echo -e "    ${CYAN}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  echo ""
fi

echo -e "${GREEN}✔ Hatch CLI successfully installed!${NC}"
echo -e "Run ${CYAN}hatch init${NC} to configure your Cloudflare Worker URL, or ${CYAN}hatch host <port>${NC} to start tunneling."
