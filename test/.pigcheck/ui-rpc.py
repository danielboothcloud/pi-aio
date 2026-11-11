#!/usr/bin/env python3
"""Scratch RPC driver for the group 11 check: runs the AIO commands of the
frame/status-line/queue/session-nav features in RPC mode, one prompt with
the fixture model, and prints every extension UI request (notify, status,
widget, footer, editor) so the RPC fallbacks are visible. No real model
calls (fixture provider)."""

import json
import os
import subprocess
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
pig = os.path.join(here, "pigfork/pig")
repo = os.path.abspath(os.path.join(here, "..", ".."))
argv = [pig, "--mode", "rpc", "--session-dir", os.path.join(here, "ui-sessions-rpc"), "-ne", "-e", os.path.join(repo, "go/aio"),
        "-e", os.path.join(here, "fixture-provider.ts"), "--model", "fixture/m1"]
COMMANDS = ["/queue status", "/queue off", "/queue", "/status-line", "/status-line verbose", "/rewind", "/sessions", "/plan", "/style concise", "/default", "/style none"]


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def main() -> None:
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(here, "ui-rpc.err"), "w"), text=True)
    time.sleep(4)
    for command in COMMANDS:
        send(proc, {"type": "prompt", "message": command})
    send(proc, {"type": "prompt", "message": "hello rpc"})
    deadline = time.monotonic() + 60
    import selectors
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    while time.monotonic() < deadline:
        if not sel.select(timeout=1):
            continue
        line = proc.stdout.readline()
        if not line:
            break
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = r.get("type")
        if t == "extension_ui_request":
            m = r.get("method")
            keep = {k: v for k, v in r.items() if k not in ("type", "id")}
            print("UI", json.dumps(keep, ensure_ascii=False)[:300])
            if m in ("select", "confirm", "input", "editor"):
                send(proc, {"type": "extension_ui_response", "id": r["id"], "cancelled": True})
        elif t == "agent_end":
            print("AGENT_END")
            time.sleep(2)
            break
        elif t == "response" and not r.get("success", True):
            print("RESPONSE ERROR", r.get("command"), r.get("error"))
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


main()
