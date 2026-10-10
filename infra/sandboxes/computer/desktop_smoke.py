#!/usr/bin/env python3
"""Offline desktop smoke: screenshots, idle cost and look invariants for the computer image."""

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

DISPLAY = ":1"
TRACKED = ("Xvfb", "x11vnc", "fluxbox", "xfwm4", "picom", "tint2", "xfconfd")
PAGE = (
    "<!doctype html><title>Desktop smoke</title>"
    "<body style='font:16px sans-serif;margin:48px;max-width:720px'>"
    "<h1>CortexAI Agent Hub</h1><p>Chromium on a bot computer.</p>"
    "<p><input placeholder='Search' style='font:inherit;padding:8px;width:320px'> <button>Go</button></p>"
)
IDLE_SECONDS = 20
# Paths a window manager, compositor or dock would write if it ignored our read-only config.
FORBIDDEN_HOME_WRITES = (".config/xfce4", ".config/tint2", ".config/picom", ".cache/sessions", ".fluxbox")


def run(*argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, env=session_env())


def session_env():
    env = dict(os.environ, DISPLAY=DISPLAY)
    try:
        line = Path("/tmp/cortexai-agent-hub/dbus-session").read_text().strip()
        env["DBUS_SESSION_BUS_ADDRESS"] = line.split("=", 1)[1]
    except (OSError, IndexError):
        pass
    return env


def wait(predicate, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def wm_name():
    check = run("xprop", "-root", "_NET_SUPPORTING_WM_CHECK").stdout.split()
    if not check or not check[-1].startswith("0x"):
        return ""
    out = run("xprop", "-id", check[-1], "_NET_WM_NAME").stdout
    return out.split('"')[1] if '"' in out else ""


def processes():
    found = {}
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            name = (proc / "comm").read_text().strip()
        except OSError:
            continue
        if name in TRACKED:
            found.setdefault(name, int(proc.name))
    return found


def rss_kb(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def cpu_ticks(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])


def compositor_owned():
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XGetSelectionOwner.restype = ctypes.c_ulong
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(DISPLAY.encode())
    assert display, "cannot open the X display"
    try:
        return x11.XGetSelectionOwner(display, x11.XInternAtom(display, b"_NET_WM_CM_S0", 0)) != 0
    finally:
        x11.XCloseDisplay(display)


class Capture:
    """The bots' screenshot path, bound the same way as control.py's NativeCapture."""

    def __init__(self):
        lib = ctypes.CDLL("/usr/local/lib/libcortexai_agent_hub-xcapture.so")
        lib.cortexai_agent_hub_xcapture_open.argtypes = [ctypes.c_char_p]
        lib.cortexai_agent_hub_xcapture_open.restype = ctypes.c_void_p
        lib.cortexai_agent_hub_xcapture_png.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.cortexai_agent_hub_xcapture_png.restype = ctypes.c_int
        lib.cortexai_agent_hub_xcapture_close.argtypes = [ctypes.c_void_p]
        self.lib = lib
        self.context = lib.cortexai_agent_hub_xcapture_open(DISPLAY.encode())
        assert self.context, "MIT-SHM capture is unavailable"

    def png(self, path):
        # The PNG buffer belongs to the capture context and stays valid until the next call.
        data, size = ctypes.POINTER(ctypes.c_ubyte)(), ctypes.c_size_t()
        width, height = ctypes.c_int(), ctypes.c_int()
        failed = self.lib.cortexai_agent_hub_xcapture_png(
            self.context, ctypes.byref(data), ctypes.byref(size), ctypes.byref(width), ctypes.byref(height)
        )
        assert not failed, "screen capture failed"
        assert (width.value, height.value) == (1280, 800), (width.value, height.value)
        if path:
            path.write_bytes(ctypes.string_at(data, size.value))

    def close(self):
        self.lib.cortexai_agent_hub_xcapture_close(self.context)


def window_list():
    return run("wmctrl", "-lx").stdout


def diagnose(out):
    """Print what a CI log needs to explain a failed wait; the runner can't be inspected later."""
    print("--- windows\n" + window_list(), file=sys.stderr)
    print("--- processes\n" + run("ps", "-eo", "pid,etime,args", "--cols", "220").stdout, file=sys.stderr)
    for log in sorted(Path("/tmp/cortexai-agent-hub").glob("*.log")):
        print(f"--- {log.name}\n" + log.read_text(errors="replace")[-3000:], file=sys.stderr)
    try:
        Capture().png(out / "failure.png" if out else None)
    except Exception as error:
        print(f"--- no failure screenshot: {error}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    parser.add_argument("--expect", choices=["modern"])
    args = parser.parse_args()
    computer = subprocess.Popen(["/usr/local/bin/cortexai-agent-hub-computer"])
    try:
        smoke(args)
    except Exception:
        diagnose(args.out)
        raise
    finally:
        computer.terminate()
        computer.wait(15)


def smoke(args):
    home = Path(os.environ["HOME"])
    started = time.monotonic()
    wait(lambda: wm_name() != "", 15, "a window manager")
    ready_ms = int((time.monotonic() - started) * 1000)
    time.sleep(3)
    capture = Capture()
    shot = lambda name: capture.png(args.out / name if args.out else None)
    shot("idle.png")

    found = processes()
    before = {name: cpu_ticks(pid) for name, pid in found.items()}
    time.sleep(IDLE_SECONDS)
    idle_ticks = {name: cpu_ticks(pid) - before[name] for name, pid in found.items()}
    rss = {name: rss_kb(pid) for name, pid in found.items()}

    page = Path("/tmp/desktop-smoke/page.html")
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(PAGE)
    browser = subprocess.Popen(["cortexai-agent-hub-browser", f"file://{page}"], env=session_env())
    wait(lambda: "Desktop smoke" in window_list(), 60, "Chromium")
    time.sleep(3)
    shot("chromium.png")
    run("pkill", "-f", "[c]hromium")
    browser.wait(15)
    wait(lambda: "Desktop smoke" not in window_list(), 15, "Chromium to close")

    subprocess.Popen(
        ["xterm", "-title", "Terminal", "-e", "sh", "-c", "cd ~ && ls -la && exec bash"], env=session_env()
    )
    wait(lambda: "xterm.XTerm" in window_list(), 15, "xterm")
    time.sleep(2)
    shot("terminal.png")
    capture.close()

    metrics = {
        "wm": wm_name(),
        "compositor": compositor_owned(),
        "dock": "tint2" in found,
        "ready_ms": ready_ms,
        "rss_kb": rss,
        "cpu_ticks_idle": idle_ticks,
        "idle_seconds": IDLE_SECONDS,
    }
    print(json.dumps(metrics), flush=True)
    if args.expect == "modern":
        modern_checks(metrics, home)


def modern_checks(metrics, home):
    assert metrics["wm"] == "Xfwm4", metrics["wm"]
    assert metrics["dock"], "tint2 is not running"
    assert metrics["compositor"], "no compositor owns _NET_WM_CM_S0"
    for family in ("Inter", "JetBrains Mono"):
        assert family in run("fc-match", family).stdout, f"{family} font missing"
    theme = run("xfconf-query", "-c", "xfwm4", "-p", "/general/theme").stdout.strip()
    assert theme == "Arc-Dark", f"xfwm4 theme is {theme!r}"
    assert not Path("/etc/gtk-3.0/settings.ini").exists(), "system GTK settings would theme Chromium pages"
    written = [path for path in FORBIDDEN_HOME_WRITES if (home / path).exists()]
    assert not written, f"desktop session wrote into the bot's home: {written}"


if __name__ == "__main__":
    sys.exit(main())
