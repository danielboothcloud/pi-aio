#!/usr/bin/env python3
"""Scratch RPC driver for the browser-search pig check: one prompt; the
scripted fixture model calls web_search and fetch_content; the driver prints
notifications, tool updates, and tool results. No real model calls."""

import json
import os
import subprocess
import time

here = os.path.dirname(os.path.abspath(__file__))
argv = ["pig", "--mode", "rpc", "--no-session", "-ne", "-e", os.path.join(here, "gocopy/aio"),
        "-e", os.path.join(here, "fixture-provider.ts"), "--model", "fixture/m1"]


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def main() -> None:
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(here, "bs-rpc.err"), "w"), text=True)
    time.sleep(3)
    send(proc, {"type": "get_state", "id": "s1"})
    send(proc, {"type": "prompt", "message": "go"})
    deadline = time.monotonic() + 120
    for line in proc.stdout:
        if time.monotonic() > deadline:
            print("TIMEOUT")
            break
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = r.get("type")
        if t == "extension_ui_request" and r.get("method") == "notify":
            print("NOTIFY", r.get("message"))
        elif t == "tool_execution_update":
            content = r.get("partialResult", {}).get("content") or [{}]
            print("UPDATE", r.get("toolName"), content[0].get("text"))
        elif t == "tool_execution_end":
            res = r.get("result", {})
            print("TOOL", r.get("toolName"), "isError=", r.get("isError"))
            print("  text:", (res.get("content", [{}])[0].get("text") or "")[:700])
            print("  details:", json.dumps(res.get("details"))[:500])
        elif t == "agent_end":
            print("AGENT_END")
            break
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


main()
