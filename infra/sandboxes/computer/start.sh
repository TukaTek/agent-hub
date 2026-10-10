#!/usr/bin/env bash
set -uo pipefail
source /usr/local/lib/cortexai-agent-hub-user-env.sh
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/cortexai-agent-hub}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/cortexai-agent-hub /tmp/.X11-unix
# Login shells re-apply ~/.local/bin from /etc/profile.d/cortexai-agent-hub-local-bin.sh.

export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"

# This script is PID 1. Without a handler, PID 1 ignores SIGTERM and `docker stop` waits its
# full grace period before killing the container, so every stop, sleep and computer switch
# took ten seconds. Install the handler before any child starts so a stop during startup is
# honoured too: forward the signal to the desktop processes and exit promptly.
XVFB_PID=""
shutdown() {
  trap - TERM INT
  if [[ -n "$XVFB_PID" ]]; then
    kill -TERM "$XVFB_PID" 2>/dev/null || true
  fi
  kill -TERM -- -1 2>/dev/null || true
  if [[ -n "$XVFB_PID" ]]; then
    wait "$XVFB_PID" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

if [[ -n "${CORTEXAI_AGENT_HUB_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  /usr/local/bin/cortexai-agent-hub-computer-control >/tmp/cortexai-agent-hub/control.log 2>&1 &
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >/tmp/cortexai-agent-hub/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Xvfb failed to start" >&2
  cat /tmp/cortexai-agent-hub/xvfb.log >&2 || true
  exit 1
fi

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  # cortexai-agent-hub-browser is launched later without this session's environment; the
  # file-chooser portals only work if the browser finds the same bus.
  printf 'export DBUS_SESSION_BUS_ADDRESS=%s\n' "$DBUS_SESSION_BUS_ADDRESS" \
    > /tmp/cortexai-agent-hub/dbus-session
fi

# Chromium's file chooser talks to xdg-desktop-portal over the session bus.
# Without a running portal backend, the select-file dialog opens but the
# chosen file never reaches the page — uploads silently do nothing. The
# daemons install as flat files in /usr/libexec on Debian bookworm.
if [ -x /usr/libexec/xdg-desktop-portal ] && [ -x /usr/libexec/xdg-desktop-portal-gtk ]; then
  /usr/libexec/xdg-desktop-portal >/tmp/cortexai-agent-hub/portal.log 2>&1 &
  # Theme the file chooser from the desktop's own GTK settings; Chromium keeps the defaults.
  XDG_CONFIG_DIRS=/usr/local/share/cortexai-agent-hub/desktop:/etc/xdg \
    /usr/libexec/xdg-desktop-portal-gtk >/tmp/cortexai-agent-hub/portal-gtk.log 2>&1 &
fi

/usr/local/bin/cortexai-agent-hub-desktop-session :1 >/tmp/cortexai-agent-hub/desktop.log 2>&1 &

register_browser_handler() {
  local mime="$1"
  if ! xdg-mime default cortexai-agent-hub-browser.desktop "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "cortexai-agent-hub-browser.desktop" ]]; then
    echo "failed to register cortexai-agent-hub-browser for $mime" >&2
    exit 1
  fi
}
register_browser_handler x-scheme-handler/http
register_browser_handler x-scheme-handler/https
register_browser_handler text/html
if ! xdg-settings set default-web-browser cortexai-agent-hub-browser.desktop >/dev/null 2>&1 \
  || [[ "$(xdg-settings get default-web-browser 2>/dev/null || true)" != "cortexai-agent-hub-browser.desktop" ]]; then
  echo "failed to set default web browser to cortexai-agent-hub-browser" >&2
  exit 1
fi

x11vnc -display :1 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/cortexai-agent-hub/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/embed.html" ]]; then
  echo "noVNC embed.html is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/clipboard-bridge.js" ]]; then
  echo "noVNC clipboard-bridge.js is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/mobile-keyboard.js" ]]; then
  echo "noVNC mobile-keyboard.js is missing from the computer image" >&2
  exit 1
fi
websockify --heartbeat=30 --web="$NOVNC_ROOT" --token-plugin=TokenFile --token-source=/tmp/cortexai-agent-hub/view-target-1 0.0.0.0:6080 >/tmp/cortexai-agent-hub/novnc.log 2>&1 &

wait "$XVFB_PID"
echo "Xvfb exited" >&2
exit 1
