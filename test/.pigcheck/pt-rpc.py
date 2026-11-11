#!/usr/bin/env python3
"""Scratch RPC driver for the pretty-tools/copy-widget check: one prompt
(scripted fixture tool calls), then /pick and /fff-health. Prints tool
results and notify requests. No real model calls (fixture provider)."""

import json
import os
import subprocess
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
argv = ["pig", "--mode", "rpc", "--no-session", "-ne", "-e", os.path.join(here, "gocopy/aio"),
        "-e", os.path.join(here, "fixture-provider.ts"), "--model", "fixture/m1", "--permission-mode", "auto"]


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def main() -> None:
    with open(os.path.join(here, "pt-rpc.err"), "w", encoding="utf-8") as err:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True)
    time.sleep(3)
    send(proc, {"type": "prompt", "message": "do it"})
    phase = "run"
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
        if t == "tool_execution_end":
            res = r.get("result", {})
            d = res.get("details") or {}
            print("TOOL", r.get("toolName"), "isError=", r.get("isError"), "_type=", d.get("_type"), json.dumps(res.get("content"))[:140])
        elif t == "extension_ui_request" and r.get("method") == "notify":
            print("NOTIFY", r.get("notifyType") or r.get("level"), r.get("message"))
            if phase == "pick":
                phase = "fff"
                send(proc, {"type": "prompt", "message": "/fff-health"})
            elif phase == "fff":
                break
        elif t == "agent_end" and phase == "run":
            print("AGENT_END")
            phase = "pick"
            send(proc, {"type": "prompt", "message": "/pick"})
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


main()
