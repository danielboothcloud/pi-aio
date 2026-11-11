#!/usr/bin/env python3
"""Scratch TUI driver for pig checks: run pig in a PTY and print screens.

Usage: tui.py <script.json>
The script is {"argv": [...], "env": {...}, "cols": 120, "rows": 40,
"steps": [{"wait": "text", "timeout": 20} | {"sleep": 1.0} |
{"send": "keys"} | {"screen": "label"}]}. "send" accepts \\r, \\x1b, etc.
The driver never sends a model prompt on its own; the script decides.
"""

import fcntl
import importlib
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

# pyte lives in the scratch venv (test/.pigcheck/venv); run this file with it.
pyte = importlib.import_module("pyte")


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as handle:
        script = json.load(handle)
    cols, rows = script.get("cols", 120), script.get("rows", 40)
    env = {**os.environ, **script.get("env", {}), "TERM": "xterm-256color"}
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(script["argv"][0], script["argv"], env)  # noqa: S606 - scratch driver, argv from the script
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)

    def pump(seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                stream.feed(data)

    def text() -> str:
        return "\n".join(line.rstrip() for line in screen.display)

    try:
        for step in script["steps"]:
            if "wait" in step:
                deadline = time.monotonic() + step.get("timeout", 20)
                while step["wait"] not in text() and time.monotonic() < deadline:
                    pump(0.1)
                if step["wait"] not in text():
                    print(f"TIMEOUT waiting for {step['wait']!r}")
                    print(text())
                    break
            elif "sleep" in step:
                pump(step["sleep"])
            elif "send" in step:
                os.write(fd, step["send"].encode())
                pump(0.3)
            elif "screen" in step:
                pump(0.3)
                print(f"===== {step['screen']} =====")
                print(text())
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.5)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
