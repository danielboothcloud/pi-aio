#!/usr/bin/env python3
"""Scratch RPC driver for pig checks.

Usage: rpc.py <cwd> <command-json | sleep:N>...
Environment: PIG_ARGS (extra pig args), RPC_WAIT (seconds), RPC_CUT (chars).
"""

import json
import os
import subprocess
import sys
import threading
import time


def main() -> None:
    cwd = sys.argv[1]
    cmds = sys.argv[2:]
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    extra = os.environ.get("PIG_ARGS", "").split()
    argv = ["pig", "--mode", "rpc", "--no-session", "-ne", "-e", os.environ.get("PIG_EXT", os.path.join(repo, "go/aio")), *extra]
    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdin, stdout, stderr = proc.stdin, proc.stdout, proc.stderr
    if stdin is None or stdout is None or stderr is None:
        raise SystemExit("pipes missing")
    lines: list[str] = []
    reader = threading.Thread(target=lambda: lines.extend(stdout), daemon=True)
    reader.start()
    for cmd in cmds:
        if cmd.startswith("sleep:"):
            time.sleep(float(cmd[6:]))
            continue
        stdin.write(cmd + "\n")
        stdin.flush()
        time.sleep(0.5)
    time.sleep(float(os.environ.get("RPC_WAIT", "3")))
    stdin.close()
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
    reader.join(timeout=2)
    cut = int(os.environ.get("RPC_CUT", "600"))
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            print("RAW", line.rstrip())
            continue
        if record.get("type") == "message_update":
            continue
        print(json.dumps(record)[:cut])
    err = stderr.read()
    if err.strip():
        print("STDERR:", err[-3000:])


if __name__ == "__main__":
    main()
