#!/usr/bin/env python3
"""Scratch scripted OpenAI-compatible server for pig checks (no real model calls).

Parent requests: first a `subagent` tool call (arguments from SUBAGENT_ARGS),
then a final text after the tool result. Child requests (system prompt has
the child boundary): a short text answer. Every request is logged.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("FIXTURE_LOG", "/dev/null")
TOOL_ARGS = os.environ.get("SUBAGENT_ARGS", '{"agent":"scout","task":"Say hi"}')


def chunk(delta: dict, finish: str | None = None) -> bytes:
    body = {
        "id": "c1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "fixture",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if finish:
        body["usage"] = {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    return f"data: {json.dumps(body)}\n\n".encode()


PARENT_CALLS = {"n": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages", [])
        text = json.dumps(messages)
        child = "CHILD AGENT BOUNDARY" in text
        last = messages[-1] if messages else {}
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"child": child, "last_role": last.get("role"), "n": len(messages)}) + "\n")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if child:
            parts = [chunk({"role": "assistant", "content": "child says hi"}), chunk({}, "stop")]
        elif last.get("role") == "tool" or PARENT_CALLS["n"] > 0:
            parts = [chunk({"role": "assistant", "content": "parent done"}), chunk({}, "stop")]
        else:
            PARENT_CALLS["n"] += 1
            call = {"index": 0, "id": "call_1", "type": "function", "function": {"name": "subagent", "arguments": TOOL_ARGS}}
            parts = [chunk({"role": "assistant", "tool_calls": [call]}), chunk({}, "tool_calls")]
        for part in parts:
            self.wfile.write(part)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
