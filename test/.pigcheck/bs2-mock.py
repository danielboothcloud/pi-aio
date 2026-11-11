#!/usr/bin/env python3
"""Scratch local web for the bs2 pig check (no external network).

An HTTP proxy: every absolute-form request (http://<any host>/...) gets a
local page, so http://8.8.8.8/bs2/... URLs pass the SSRF rules (public IP)
while nothing leaves 127.0.0.1. Camoufox (BROWSER_SEARCH_CAMOUFOX_PROXY)
and the Go HTTP fallback (HTTP_PROXY) both use it. Each request is logged
to BS2_MOCK_LOG with its User-Agent."""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("BS2_MOCK_LOG", "/dev/null")
ARTICLE = """<!doctype html><html><head><title>Local release notes</title></head><body>
<nav><a href="/">Home</a></nav><article><h1>Local release notes</h1>
<p>Version 2 adds offline search. The index is built locally and stays on the machine, so queries remain private.</p>
<p>The fetch chain tries the local Camoufox browser first and then a plain HTTP request. See <a href="/bs2/chain">the chain notes</a>.</p>
<p>Upgrading needs no configuration change; existing settings keep working after the upgrade.</p>
</article><footer>footer text</footer></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"path": self.path, "ua": self.headers.get("user-agent")}) + "\n")
        if not self.path.startswith("http://"):
            self.send_response(400)
            self.end_headers()
            return
        tail = self.path.split("/", 3)[-1]
        if tail == "bs2/slow":
            time.sleep(6)
        if tail.startswith("bs2/"):
            body = ARTICLE.replace("Local release notes", "Local release notes" if "other" not in tail else "Other local page").encode()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
        else:
            body = b"not found"
            self.send_response(404)
            self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
