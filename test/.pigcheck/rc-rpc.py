#!/usr/bin/env python3
"""Scratch RPC driver for the recipes/hypa/notification pig check.

Usage: rc-rpc.py <plan.json> -- <pig argv...>
plan: {"answers": [{"match": "title substring", "value": "..."} | {"match": "...", "confirmed": true} | {"match": "...", "cancel": true}],
       "steps": [{"prompt": "/cmd"} | {"sleep": 2} | {"wait_end": 30}]}
Prints every extension UI request and response; no real model calls (the
scripted fixture server answers)."""

import json
import selectors
import subprocess
import sys
import time

plan = json.load(open(sys.argv[1]))
argv = sys.argv[sys.argv.index("--") + 1:]
proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(plan.get("stderr", "/dev/null"), "w"), text=True)
sel = selectors.DefaultSelector()
sel.register(proc.stdout, selectors.EVENT_READ)
answers = plan.get("answers", [])
ended = {"n": 0}


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not sel.select(timeout=0.2):
            continue
        line = proc.stdout.readline()
        if not line:
            return
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = r.get("type")
        if t == "extension_ui_request":
            m = r.get("method")
            keep = {k: v for k, v in r.items() if k not in ("type", "id")}
            if m in ("setStatus", "setWidget", "setFooter", "setHeader", "setWorkingIndicator", "setTitle", "set_editor_text"):
                continue
            print("UI", json.dumps(keep, ensure_ascii=False)[:1500])
            if m in ("select", "confirm", "input", "editor"):
                title = str(r.get("title", "")) + str(r.get("message", ""))
                reply = {"type": "extension_ui_response", "id": r["id"], "cancelled": True}
                for a in answers:
                    if a["match"] in title:
                        if "value" in a:
                            reply = {"type": "extension_ui_response", "id": r["id"], "value": a["value"]}
                        elif "confirmed" in a:
                            reply = {"type": "extension_ui_response", "id": r["id"], "confirmed": a["confirmed"]}
                        break
                print("ANSWER", json.dumps(reply)[:300])
                send(reply)
        elif t == "agent_end":
            ended["n"] += 1
            print("AGENT_END")
        elif t == "response" and not r.get("success", True):
            print("RESPONSE ERROR", r.get("command"), r.get("error"))
        elif t in ("tool_execution_end",):
            print("TOOL_END", json.dumps(r)[:600])


pump(plan.get("startup", 5))
for step in plan["steps"]:
    if "prompt" in step:
        print("PROMPT", step["prompt"])
        send({"type": "prompt", "message": step["prompt"]})
        pump(step.get("after", 3))
    elif "sleep" in step:
        pump(step["sleep"])
    elif "wait_end" in step:
        target = ended["n"] + 1
        end = time.monotonic() + step["wait_end"]
        while ended["n"] < target and time.monotonic() < end:
            pump(0.5)
        pump(1)
proc.stdin.close()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
print("EXIT", proc.returncode)
