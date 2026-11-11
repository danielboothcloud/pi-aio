#!/usr/bin/env python3
"""Scratch RPC driver for the ask-user-question check: one prompt, the
scripted fixture model calls ask_user_question six times; the driver
answers the select/input dialogs from REPLIES, prints each dialog and each
tool result. No real model calls (fixture provider)."""

import json
import os
import subprocess
import time

here = os.path.dirname(os.path.abspath(__file__))
argv = ["pig", "--mode", "rpc", "--no-session", "-ne", "-e", os.path.join(here, "gocopy/aio"),
        "-e", os.path.join(here, "fixture-provider.ts"), "--model", "fixture/m1"]
# One reply per dialog: an option index (select), a string (input), or None (cancel).
REPLIES = [1, "1,3", 2, "custom layout", 0, None, 0, "2"]


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def main() -> None:
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(here, "aq-rpc.err"), "w"), text=True)
    time.sleep(3)
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
        if t == "extension_ui_request" and r.get("method") in ("select", "input"):
            reply = REPLIES.pop(0) if REPLIES else None
            print(f"DIALOG {r['method']} title={r.get('title')!r}")
            if r["method"] == "select":
                print("  options:", r.get("options"))
            else:
                print("  placeholder:", repr(r.get("placeholder")))
            if reply is None:
                print("  -> cancel")
                send(proc, {"type": "extension_ui_response", "id": r["id"], "cancelled": True})
            elif isinstance(reply, int):
                value = r["options"][reply]
                print("  ->", repr(value))
                send(proc, {"type": "extension_ui_response", "id": r["id"], "value": value})
            else:
                print("  ->", repr(reply))
                send(proc, {"type": "extension_ui_response", "id": r["id"], "value": reply})
        elif t == "extension_ui_request" and r.get("method") == "notify":
            print("NOTIFY", r.get("message"))
        elif t == "tool_execution_end":
            res = r.get("result", {})
            print("TOOL", r.get("toolName"), "isError=", r.get("isError"))
            print("  text:", res.get("content", [{}])[0].get("text"))
            print("  details:", json.dumps(res.get("details")))
        elif t == "agent_end":
            print("AGENT_END")
            break
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


main()
