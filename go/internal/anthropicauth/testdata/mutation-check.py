#!/usr/bin/env python3
"""Prove behavioral regressions compile and fail, without editing the worktree."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

here = Path(__file__).resolve().parent
repo = here.parents[3]
mutations = [
    ("shaping removed", "transport.go", "return ShapePayload(upstream, version, observer), nil", "_ = version; return upstream, nil", "TestUpstreamGoldenOAuthWrapper"),
    ("OAuth gate removed", "transport.go", "oauth := IsAnthropicOAuthToken(key)", "oauth := true; _ = key", "TestUpstreamGoldenOAuthWrapper"),
    ("retry removed", "sync.go", "retryBody, retry, reason := s.plan(rejection, body, sent)", "retryBody, retry, reason := s.plan(rejection, body, sent); retry = false", "TestUpstreamGoldenBillingVersionSync"),
    ("UTF-16 replaced with runes", "billing.go", "units := utf16.Encode([]rune(text))", "units := []uint16{}; for _, r := range text { units = append(units, uint16(r)) }", "TestUpstreamGoldenShaping/billing"),
]
with tempfile.TemporaryDirectory(prefix=".anthropic-mutations-", dir=repo / "test") as scratch:
    root = Path(scratch)
    shutil.copy(repo / "go/go.mod", root / "go.mod")
    shutil.copytree(repo / "go/internal/jsstr", root / "internal/jsstr")
    shutil.copytree(here.parent, root / "internal/anthropicauth")
    env = dict(os.environ, GOWORK="off", TMPDIR=str(root / "tmp"), GOCACHE=str(root / "cache"), HOME=str(root / "home"), PIG_HOME=str(root / "agent"), PI_HOME=str(root / "agent"), PIG_CODING_AGENT_DIR=str(root / "agent"), PI_CODING_AGENT_DIR=str(root / "agent"))
    for name in ("tmp", "cache", "home", "agent"):
        (root / name).mkdir()
    for name, filename, old, new, test in mutations:
        path = root / "internal/anthropicauth" / filename
        original = path.read_text()
        if original.count(old) != 1:
            raise SystemExit(f"ambiguous mutation: {name}")
        path.write_text(original.replace(old, new))
        try:
            build = subprocess.run(["go", "test", "-trimpath", "./internal/anthropicauth", "-run", "^$"], cwd=root, env=env, text=True, capture_output=True, timeout=90)
            if build.returncode:
                raise SystemExit(f"mutation did not compile: {name}\n{build.stdout}{build.stderr}")
            proc = subprocess.run(["go", "test", "-trimpath", "./internal/anthropicauth", "-run", test, "-timeout", "30s"], cwd=root, env=env, text=True, capture_output=True, timeout=60)
            if proc.returncode == 0 or "--- FAIL:" not in proc.stdout:
                raise SystemExit(f"mutation was not behaviorally killed: {name}\n{proc.stdout}{proc.stderr}")
            print(f"KILLED (compiled, regression failed): {name}")
        finally:
            path.write_text(original)
