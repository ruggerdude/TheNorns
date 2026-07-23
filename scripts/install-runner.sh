#!/bin/sh
# Installs, pairs, and starts the local folder helper without administrator access.
set -eu

SERVER_URL="${NORNS_SERVER:-}"
PAIR_CODE=""
RUNNER_ID="runner-1"
ROOT_DIR="${NORNS_HOME:-$HOME/.norns}"
SOURCE_URL="${NORNS_HELPER_SOURCE:-https://github.com/ruggerdude/TheNorns.git}"
SOURCE_REF="${NORNS_HELPER_REF:-main}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --pair) PAIR_CODE="${2:-}"; shift 2 ;;
    --id) RUNNER_ID="${2:-}"; shift 2 ;;
    --uninstall)
      if [ "$(uname -s)" = "Darwin" ]; then
        launchctl bootout "gui/$(id -u)/com.thenorns.runner" >/dev/null 2>&1 || true
        rm -f "$HOME/Library/LaunchAgents/com.thenorns.runner.plist"
      else
        systemctl --user disable --now com.thenorns.runner >/dev/null 2>&1 || true
        rm -f "$HOME/.config/systemd/user/com.thenorns.runner.service"
      fi
      rm -rf "$ROOT_DIR/helper"
      printf '%s\n' "The Norns helper was removed. Pairing keys remain in $ROOT_DIR/$RUNNER_ID."
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

case "$SERVER_URL" in http://*|https://*) ;; *) printf '%s\n' "--server URL is required" >&2; exit 1 ;; esac
case "$RUNNER_ID" in *[!A-Za-z0-9._-]*) printf '%s\n' "Invalid helper id" >&2; exit 1 ;; esac
command -v git >/dev/null 2>&1 || { printf '%s\n' "Git is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' "Node.js 24 or newer is required." >&2; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(\".\")[0])')" -ge 24 ] ||
  { printf '%s\n' "Node.js 24 or newer is required." >&2; exit 1; }

SRC_DIR="$ROOT_DIR/helper"
DATA_DIR="$ROOT_DIR/$RUNNER_ID"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$ROOT_DIR" "$LOG_DIR"
chmod 700 "$ROOT_DIR"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin "$SOURCE_REF"
  git -C "$SRC_DIR" checkout --detach FETCH_HEAD
else
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
  corepack prepare pnpm@11.13.0 --activate
fi
command -v pnpm >/dev/null 2>&1 || { printf '%s\n' "pnpm is required." >&2; exit 1; }
pnpm install --frozen-lockfile --filter "@norns/runner..."
pnpm --filter "@norns/runner..." run build
CLI="$SRC_DIR/apps/runner/dist/cli.js"
[ -f "$CLI" ] || { printf '%s\n' "Helper build failed." >&2; exit 1; }

if [ -n "$PAIR_CODE" ]; then
  node "$CLI" pair "$PAIR_CODE" --server "$SERVER_URL" --id "$RUNNER_ID" --data "$DATA_DIR"
elif [ ! -f "$DATA_DIR/runner-state.json" ]; then
  printf '%s\n' "Copy a fresh setup command from The Norns; its pairing code is required." >&2
  exit 1
fi

if [ "$(uname -s)" = "Darwin" ]; then
  SERVICE="$HOME/Library/LaunchAgents/com.thenorns.runner.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  launchctl bootout "gui/$(id -u)/com.thenorns.runner" >/dev/null 2>&1 || true
  sed \
    -e "s|__NODE__|$(command -v node)|g" \
    -e "s|__CLI__|$CLI|g" \
    -e "s|__SERVER__|$SERVER_URL|g" \
    -e "s|__ID__|$RUNNER_ID|g" \
    -e "s|__DATA__|$DATA_DIR|g" \
    -e "s|__LOG__|$LOG_DIR|g" >"$SERVICE" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.thenorns.runner</string>
<key>ProgramArguments</key><array>
<string>__NODE__</string><string>__CLI__</string><string>start</string>
<string>--server</string><string>__SERVER__</string>
<string>--id</string><string>__ID__</string><string>--data</string><string>__DATA__</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>__LOG__/runner.log</string>
<key>StandardErrorPath</key><string>__LOG__/runner.err.log</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$SERVICE"
  launchctl kickstart -k "gui/$(id -u)/com.thenorns.runner"
else
  SERVICE="$HOME/.config/systemd/user/com.thenorns.runner.service"
  mkdir -p "$HOME/.config/systemd/user"
  {
    printf '%s\n' "[Unit]" "Description=The Norns local helper" "[Service]"
    printf 'ExecStart=%s %s start --server %s --id %s --data %s\n' "$(command -v node)" "$CLI" "$SERVER_URL" "$RUNNER_ID" "$DATA_DIR"
    printf '%s\n' "Restart=always" "RestartSec=5" "[Install]" "WantedBy=default.target"
  } >"$SERVICE"
  systemctl --user daemon-reload
  systemctl --user enable --now com.thenorns.runner
fi

printf '%s\n' "The Norns helper is ready. Return to the browser and choose your folder."
