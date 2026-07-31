#!/bin/sh
set -eu

ACTION="${1:-}"
RESOURCE_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
DATA_DIR="$HOME/.norns/runner-1"
LOG_DIR="$HOME/.norns/logs"
SERVICE="$HOME/Library/LaunchAgents/com.thenorns.local-agent.plist"
MENU_SERVICE="$HOME/Library/LaunchAgents/com.thenorns.local-agent-menubar.plist"
AGENT_VERSION="__VERSION__"

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)
    printf '%s\n' "This Mac processor is not supported." >&2
    exit 2
    ;;
esac

NODE="$RESOURCE_DIR/runtime/$ARCH/node"
CLI="$RESOURCE_DIR/app/$ARCH/node_modules/@norns/runner/dist/cli.js"
PACKAGE_BIN="$RESOURCE_DIR/app/$ARCH/node_modules/.bin"
export PATH="$RESOURCE_DIR/runtime/$ARCH:$PACKAGE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

if [ ! -x "$NODE" ] || [ ! -f "$CLI" ]; then
  printf '%s\n' "The installed app is incomplete. Reinstall Norns Local Agent." >&2
  exit 2
fi

stop_old_agents() {
  launchctl bootout "gui/$(id -u)/com.thenorns.local-agent" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)/com.thenorns.local-agent-menubar" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)/com.thenorns.runner" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)/app.thenorns.runner" >/dev/null 2>&1 || true
}

install_menu_agent() {
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '%s\n' '<key>Label</key><string>com.thenorns.local-agent-menubar</string>'
    printf '%s\n' '<key>ProgramArguments</key><array>'
    printf '%s\n' '<string>/usr/bin/open</string>'
    printf '%s\n' '<string>-gja</string>'
    printf '%s\n' '<string>/Applications/Norns Local Agent.app</string>'
    printf '%s\n' '</array>'
    printf '%s\n' '<key>RunAtLoad</key><true/>'
    printf '%s\n' '<key>LimitLoadToSessionType</key><string>Aqua</string>'
    printf '%s\n' '</dict></plist>'
  } >"$MENU_SERVICE"
  chmod 600 "$MENU_SERVICE"
  plutil -lint "$MENU_SERVICE" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$MENU_SERVICE" >/dev/null 2>&1 || true
}

ensure_menu_agent() {
  if [ ! -f "$MENU_SERVICE" ]; then
    install_menu_agent
    return
  fi
  if ! launchctl print "gui/$(id -u)/com.thenorns.local-agent-menubar" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$MENU_SERVICE" >/dev/null 2>&1 || true
  fi
}

install_launch_agent() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  chmod 700 "$HOME/.norns"
  stop_old_agents
  rm -f "$HOME/Library/LaunchAgents/com.thenorns.runner.plist"
  rm -f "$HOME/Library/LaunchAgents/app.thenorns.runner.plist"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '%s\n' '<key>Label</key><string>com.thenorns.local-agent</string>'
    printf '%s\n' '<key>ProgramArguments</key><array>'
    printf '<string>%s</string>\n' "$NODE"
    printf '<string>%s</string>\n' "$CLI"
    printf '%s\n' '<string>agent-start</string>'
    printf '%s\n' '<string>--data</string>'
    printf '<string>%s</string>\n' "$DATA_DIR"
    printf '%s\n' '</array>'
    printf '%s\n' '<key>RunAtLoad</key><true/>'
    printf '%s\n' '<key>KeepAlive</key><true/>'
    printf '%s\n' '<key>EnvironmentVariables</key><dict>'
    printf '%s\n' '<key>NORNS_SERVER</key><string>https://thenorns.up.railway.app</string>'
    printf '%s\n' '<key>NORNS_ENABLE_DEVICE_ENROLLMENT</key><string>true</string>'
    printf '%s\n' '<key>NORNS_ENABLE_DEVICE_CONTROL</key><string>true</string>'
    printf '<key>NORNS_LOCAL_AGENT_VERSION</key><string>%s</string>\n' "$AGENT_VERSION"
    printf '%s\n' '</dict>'
    printf '<key>StandardOutPath</key><string>%s/runner.log</string>\n' "$LOG_DIR"
    printf '<key>StandardErrorPath</key><string>%s/runner.err.log</string>\n' "$LOG_DIR"
    printf '%s\n' '</dict></plist>'
  } >"$SERVICE"
  chmod 600 "$SERVICE"
  plutil -lint "$SERVICE" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$SERVICE"
  launchctl kickstart -k "gui/$(id -u)/com.thenorns.local-agent"
  install_menu_agent
}

case "$ACTION" in
  install)
    if ! /usr/bin/git --version >/dev/null 2>&1; then
      /usr/bin/xcode-select --install >/dev/null 2>&1 || true
      printf '%s\n' "Apple needs to install its Command Line Tools for Git. Click Install in Apple's dialog, then return to The Norns and click Connect installed agent again." >&2
      exit 3
    fi
    mkdir -p "$DATA_DIR" "$LOG_DIR"
    chmod 700 "$HOME/.norns" "$DATA_DIR"
    stop_old_agents
    install_launch_agent
    ;;
  open)
    if [ ! -f "$SERVICE" ]; then
      "$0" install
      exit 0
    fi
    INSTALLED_SERVICE_VERSION=$(
      /usr/libexec/PlistBuddy \
        -c 'Print :EnvironmentVariables:NORNS_LOCAL_AGENT_VERSION' \
        "$SERVICE" 2>/dev/null || true
    )
    if [ "$INSTALLED_SERVICE_VERSION" != "$AGENT_VERSION" ]; then
      "$0" install
      exit 0
    fi
    if launchctl print "gui/$(id -u)/com.thenorns.local-agent" 2>/dev/null |
      grep -q 'state = running'
    then
      ensure_menu_agent
      exit 0
    fi
    launchctl bootstrap "gui/$(id -u)" "$SERVICE" >/dev/null 2>&1 || true
    launchctl kickstart "gui/$(id -u)/com.thenorns.local-agent"
    ensure_menu_agent
    ;;
  start)
    NORNS_SERVER="https://thenorns.up.railway.app" \
      NORNS_ENABLE_DEVICE_ENROLLMENT="true" \
      NORNS_ENABLE_DEVICE_CONTROL="true" \
      NORNS_LOCAL_AGENT_VERSION="$AGENT_VERSION" \
      exec "$NODE" "$CLI" agent-start --data "$DATA_DIR"
    ;;
  stop)
    stop_old_agents
    ;;
  *)
    printf '%s\n' "Usage: agent.sh install | open | start | stop" >&2
    exit 2
    ;;
esac
