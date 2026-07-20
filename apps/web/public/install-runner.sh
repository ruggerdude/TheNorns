#!/bin/sh
set -eu

PAIRING_CODE="${1:-}"
SERVER_URL="${2:-}"
if [ -z "$PAIRING_CODE" ] || [ -z "$SERVER_URL" ]; then
  printf '%s\n' "Usage: install-runner.sh <pairing-code> <server-url>" >&2
  exit 2
fi

for required in git node npm; do
  if ! command -v "$required" >/dev/null 2>&1; then
    printf '%s\n' "The Norns runner requires $required. Install Node.js 24+ and Git, then try again." >&2
    exit 1
  fi
done

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 24 ]; then
  printf '%s\n' "The Norns runner requires Node.js 24 or newer (found $(node --version))." >&2
  exit 1
fi
NODE_BIN=$(command -v node)

INSTALL_ROOT="${NORNS_RUNNER_HOME:-$HOME/.norns/runner-install}"
SOURCE_DIR="$INSTALL_ROOT/source"
BIN_DIR="$HOME/.local/bin"
RUNNER_BIN="$BIN_DIR/norns-runner"
REPOSITORY_URL="${NORNS_RUNNER_REPOSITORY_URL:-https://github.com/ruggerdude/TheNorns.git}"
REPOSITORY_REF="${NORNS_RUNNER_REF:-main}"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN=$(command -v pnpm)
else
  npm install --prefix "$INSTALL_ROOT/pnpm" pnpm@11.13.0
  PNPM_BIN="$INSTALL_ROOT/pnpm/node_modules/.bin/pnpm"
fi
if [ -d "$SOURCE_DIR/.git" ]; then
  git -C "$SOURCE_DIR" fetch --depth 1 origin "$REPOSITORY_REF"
  git -C "$SOURCE_DIR" checkout --detach FETCH_HEAD
else
  if [ -e "$SOURCE_DIR" ]; then
    printf '%s\n' "$SOURCE_DIR exists but is not a runner installation; move it and try again." >&2
    exit 1
  fi
  git clone --depth 1 --branch "$REPOSITORY_REF" "$REPOSITORY_URL" "$SOURCE_DIR"
fi

"$PNPM_BIN" --dir "$SOURCE_DIR" --filter @norns/runner... install --frozen-lockfile
"$PNPM_BIN" --dir "$SOURCE_DIR" --filter @norns/runner... run build

cat >"$RUNNER_BIN" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$SOURCE_DIR/apps/runner/dist/cli.js" "\$@"
EOF
chmod 700 "$RUNNER_BIN"

if [ "${NORNS_RUNNER_INSTALL_ONLY:-0}" = "1" ]; then
  "$RUNNER_BIN" help >/dev/null
  printf '%s\n' "The Norns runner installation was verified at $RUNNER_BIN."
  exit 0
fi

"$RUNNER_BIN" pair "$PAIRING_CODE" --server "$SERVER_URL"
printf '%s\n' "$SERVER_URL" >"$INSTALL_ROOT/server-url"
chmod 600 "$INSTALL_ROOT/server-url"

cat >"$INSTALL_ROOT/start" <<EOF
#!/bin/sh
SERVER_URL=\$(cat "$INSTALL_ROOT/server-url")
exec "$RUNNER_BIN" start --server "\$SERVER_URL"
EOF
chmod 700 "$INSTALL_ROOT/start"

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/app.thenorns.runner.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  START_XML=$(printf '%s' "$INSTALL_ROOT/start" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
  LOG_XML=$(printf '%s' "$INSTALL_ROOT/runner.log" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.thenorns.runner</string>
  <key>ProgramArguments</key><array><string>$START_XML</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/app.thenorns.runner"
else
  nohup "$INSTALL_ROOT/start" >"$INSTALL_ROOT/runner.log" 2>&1 &
fi

printf '\n%s\n' "The Norns runner is installed, paired, and running. Return to the browser and choose your project folder."
