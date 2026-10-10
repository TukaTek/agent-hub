#!/bin/sh
# Wallpaper, window manager, compositor and dock for one X display.
# Every child is an X client, so all of them exit when the display stops.
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
XDG_CONFIG_DIRS="$share:/etc/xdg" xfwm4 --compositor=off --sm-client-disable &
picom --config "$share/picom.conf" &
tint2 -c "$state/tint2rc" &
wait
