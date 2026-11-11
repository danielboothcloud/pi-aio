#!/usr/bin/env python3
"""Scratch RPC driver for the diff-tools check: sends one prompt, answers
select requests from DT_ANSWERS (a JSON list of option indexes), prints the
select titles and tool results. No real model calls (fixture provider)."""

import json
import os
import subprocess
import time

here = os.path.dirname(os.path.abspath(__file__))
answers = json.loads(os.environ.get("DT_ANSWERS", "[0]"))
argv = ["pig", "--mode", "rpc", "--no-session", "-ne", "-e", os.path.join(here, "gocopy/aio"),
        "-e", os.path.join(here, "fixture-provider.ts"), "--model", "fixture/m1"]
def run() -> None:
    with open(os.path.join(here, "dt-rpc.err"), "w", encoding="utf-8") as err:
        proc = subprocess.Popen(argv, cwd=os.path.join(here, "dt"), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        drive(proc)


def drive(proc: subprocess.Popen) -> None:
    assert proc.stdin and proc.stdout
    time.sleep(3)
    proc.stdin.write(json.dumps({"type": "prompt", "message": "do it"}) + "\n")
    proc.stdin.flush()
    deadline = time.monotonic() + 90
    done = False
    for line in proc.stdout:
        if time.monotonic() > deadline:
            break
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = r.get("type")
        if t == "extension_ui_request" and r.get("method") == "select":
            idx = answers.pop(0) if answers else 2
            opts = r.get("options", [])
            print("SELECT title:\n" + r.get("title", ""))
            print("SELECT options:", opts, "-> answer", opts[idx] if idx < len(opts) else None)
            proc.stdin.write(json.dumps({"type": "extension_ui_response", "id": r["id"], "value": opts[idx]}) + "\n")
            proc.stdin.flush()
        elif t == "tool_execution_end":
            res = r.get("result", {})
            print("TOOL", r.get("toolName"), "isError=", r.get("isError"), json.dumps(res.get("content"))[:200])
        elif t == "agent_end":
            done = True
            break
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    print("agent_end seen:", done)


run()
