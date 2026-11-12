#!/usr/bin/env python3
"""Read-only PiG capability probe. All agent/home/build temp paths are repo-local.

From the repository root:
    python3 go/internal/anthropicauth/testdata/probe-host.py

This is NOT successful transport integration evidence. It proves the blocker.
No models are called and no credentials are read from the real agent directory.
"""
import os
from pathlib import Path
import subprocess
import tempfile

here = Path(__file__).resolve().parent
repo = here.parents[3]
with tempfile.TemporaryDirectory(prefix=".anthropic-host-", dir=repo / "test") as scratch:
    root = Path(scratch)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PIG_EXT_", "PIG_HARNESS_", "PIG_PRODUCT_", "ANTHROPIC_"))}
    for name in ("home", "agent", "pighome", "pihome", "tmp"):
        (root / name).mkdir()
    env.update(HOME=str(root / "home"), PIG_HOME=str(root / "pighome"), PI_HOME=str(root / "pihome"), PIG_CODING_AGENT_DIR=str(root / "agent"), PI_CODING_AGENT_DIR=str(root / "agent"), TMPDIR=str(root / "tmp"), ANTHROPIC_AUTH_PROBE_FILE=str(root / "result.txt"))
    version = subprocess.run(["pig", "--version"], env=env, check=True, text=True, capture_output=True, timeout=30)
    print(version.stdout.strip())
    proc = subprocess.run(["pig", "--mode", "rpc", "--no-session", "-ne", "-e", str(here / "host-delegate-probe")], env=env, input='{"type":"get_state"}\n', text=True, capture_output=True, timeout=120)
    if proc.returncode:
        raise SystemExit(proc.stderr or proc.stdout)
    result = (root / "result.txt").read_text()
    print(result.strip())
    expected = "provider_nil=true error=builtin/composed Provider object carrier is unavailable (D78)\n"
    if result != expected:
        raise SystemExit("SDK capability changed: inspect the raw delegate before wiring the factory")
    print("BLOCKED: no raw built-in Anthropic streamSimple delegate; no transport test ran")
