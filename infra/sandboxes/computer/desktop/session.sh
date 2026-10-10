#!/bin/sh
# Wallpaper, window manager, compositor and dock for one X display.
# The X clients exit when the display stops; xfconfd is shared by every display.
set -eu
display="${1:?usage: cortexai-agent-hub-desktop-session :N}"
number="${display#:}"
case "$number" in '' | *[!0-9]*) echo "invalid display $display" >&2; exit 64 ;; esac
export DISPLAY="$display"
share=/usr/local/share/cortexai-agent-hub/desktop
state="/tmp/cortexai-agent-hub/desktop-$number"
# Displays started through docker exec do not inherit the primary session bus; xfconfd needs it.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -r /tmp/cortexai-agent-hub/dbus-session ]; then
  . /tmp/cortexai-agent-hub/dbus-session
fi
mkdir -p "$state/applications"
browser="${BROWSER:-cortexai-agent-hub-browser}"
sed "s|@BROWSER@|$browser|" "$share/browser.desktop.in" >"$state/applications/browser.desktop"
cp "$share/terminal.desktop" "$state/applications/terminal.desktop"
sed "s|@STATE@|$state|g" "$share/tint2rc.in" >"$state/tint2rc"
xrdb -merge "$share/Xresources"
hsetroot -add "#141518" -add "#0B0C0E" -gradient 0 >/dev/null
# Bus activation would start xfconfd with the bot's HOME, and it saves channels there.
own_xfconf() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner string:org.xfce.Xfconf 2>/dev/null | grep -q "boolean true"
}
if ! own_xfconf; then
  for xfconfd in /usr/lib/*/xfce4/xfconf/xfconfd; do
    XDG_CONFIG_HOME=/tmp/cortexai-agent-hub/xfconf "$xfconfd" >/dev/null 2>&1 &
  done
  for _ in $(seq 50); do own_xfconf && break; sleep 0.1; done
fi
XDG_CONFIG_DIRS="$share:/etc/xdg" XDG_CONFIG_HOME="$state/config" XDG_CACHE_HOME="$state/cache" \
  xfwm4 --compositor=off --sm-client-disable &
wm=$!
picom --config "$share/picom.conf" &
compositor=$!
tint2 -c "$state/tint2rc" &
dock=$!
wait "$wm" "$compositor" "$dock"
