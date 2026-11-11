#!/usr/bin/env python3
"""Scratch local backends for the browser-search pig check (no external network).

/sx/search  SearXNG-shaped JSON      /exa/search  Exa-shaped JSON (needs x-api-key)
/cf/*       Camofox-shaped REST API  /page.html   the local HTML page Camofox "loads"
Every request is logged to BS_MOCK_LOG (method, path, a short body)."""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("BS_MOCK_LOG", "/dev/null")
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "<html><head><title>Local release notes</title></head><body><article><h1>Local release notes</h1><p>Version 2 adds offline search.</p></article></body></html>"
TABS = {}


def page_article():
    title = re.search(r"<title>(.*?)</title>", PAGE).group(1)
    text = re.sub(r"<[^>]+>", " ", PAGE.split("<body>")[1])
    text = " ".join(text.split())
    return {"title": title, "text": text, "excerpt": text[:40], "length": len(text)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def reply(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        length = int(self.headers.get("content-length", "0") or 0)
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw) if raw else {}
        with open(LOG, "a", encoding="utf-8") as log:
            short = {k: (v[:60] + "…" if isinstance(v, str) and len(v) > 60 else v) for k, v in body.items()} if isinstance(body, dict) else body
            log.write(json.dumps({"method": self.command, "path": self.path, "auth": self.headers.get("authorization"), "key": self.headers.get("x-api-key"), "body": short}) + "\n")
        path = self.path.split("?")[0]
        if path == "/page.html":
            return self.reply(200, PAGE.encode(), "text/html")
        if path == "/sx/search":
            return self.reply(200, {"query": "release notes", "results": [
                {"title": "SearXNG hit A", "url": "https://8.8.8.8/a", "content": "Snippet from local SearXNG", "engine": "mock"},
                {"title": "SearXNG hit B", "url": "https://8.8.8.8/b", "content": "Second snippet", "engine": "mock", "publishedDate": "2026-01-01"}]})
        if path == "/exa/search":
            if self.headers.get("x-api-key") != "local-test-key":
                return self.reply(401, {"error": "bad key"})
            return self.reply(200, {"results": [{"title": "Exa hit", "url": "https://8.8.8.8/exa", "publishedDate": "2026-01-02", "highlights": ["Local Exa highlight"]}]})
        if path == "/cf/health":
            return self.reply(200, {"ok": True, "browserRunning": True})
        if path == "/cf/tabs" and self.command == "POST":
            tab = f"tab-{len(TABS) + 1}"
            TABS[tab] = body.get("url")
            return self.reply(200, {"tabId": tab, "url": body.get("url")})
        m = re.match(r"^/cf/tabs/([^/]+)(/evaluate)?$", path)
        if m and self.command == "DELETE":
            return self.reply(200, {"closed": True})
        if m and m.group(2) == "/evaluate":
            target = TABS.get(m.group(1), "")
            expr = body.get("expression", "")
            if "outerHTML" in expr:
                return self.reply(200, {"result": PAGE})
            if target.endswith("/challenge"):
                return self.reply(200, {"result": json.dumps({"title": "Just a moment...", "text": "Checking your browser", "excerpt": None, "length": 21})})
            if "new Readability(" not in expr:
                return self.reply(400, {"error": "expected Readability"})
            return self.reply(200, {"result": json.dumps(page_article())})
        return self.reply(404, {"error": self.path})

    do_GET = do_POST = do_DELETE = handle_any


def main():
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
