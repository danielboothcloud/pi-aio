#!/usr/bin/env python3
"""Scratch scripted OpenAI-compatible server for the group 11 (frame/queue) pig check.

A step may carry "delay" (seconds): its text then streams word by word
over that time, so a check can type while the agent is streaming.

No real model calls. Each request takes the next step of YH_SCRIPT (a JSON
list of {"tool": name, "args": {...}} or {"text": "..."}); after the list
runs out it answers "done". Every request is logged to FIXTURE_LOG with the
system prompt and the last message, so the check can see injected context
and tool results.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("FIXTURE_LOG", "/dev/null")
SCRIPT = json.loads(os.environ.get("YH_SCRIPT", "[]"))
STATE = {"n": 0}


def chunk(delta: dict, finish: str | None = None) -> bytes:
    body = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "fixture",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if finish:
        body["usage"] = {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    return f"data: {json.dumps(body)}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        body = json.dumps({"plan": {"remaining": 42, "renews": "2099-01-01T00:00:00Z"}}).encode()
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"get": self.path, "auth": self.headers.get("authorization")}) + "\n")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages", [])
        system = next((m.get("content") for m in messages if m.get("role") in ("system", "developer")), "")
        if isinstance(system, list):
            system = " ".join(p.get("text", "") for p in system if isinstance(p, dict))
        last = messages[-1] if messages else {}
        if "short, specific title" in str(system):
            step = {"text": "ui check session"}
        else:
            step = SCRIPT[STATE["n"]] if STATE["n"] < len(SCRIPT) else {"text": "done"}
            STATE["n"] += 1
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"n": STATE["n"], "system_tail": str(system)[-900:], "last": last}) + "\n")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if "tool" in step:
            call = {"index": 0, "id": f"call_{STATE['n']}", "type": "function",
                    "function": {"name": step["tool"], "arguments": json.dumps(step.get("args", {}))}}
            parts = [chunk({"role": "assistant", "tool_calls": [call]}), chunk({}, "tool_calls")]
        elif step.get("delay"):
            words = step["text"].split(" ")
            self.wfile.write(chunk({"role": "assistant", "content": ""}))
            self.wfile.flush()
            for i, word in enumerate(words):
                time.sleep(step["delay"] / max(1, len(words)))
                self.wfile.write(chunk({"content": (" " if i else "") + word}))
                self.wfile.flush()
            parts = [chunk({}, "stop")]
        else:
            parts = [chunk({"role": "assistant", "content": step["text"]}), chunk({}, "stop")]
        for part in parts:
            self.wfile.write(part)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
