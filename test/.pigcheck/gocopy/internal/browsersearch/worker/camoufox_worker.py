#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["camoufox==0.5.9"]
# ///
"""Local Camoufox worker for the Go port of AIO browser-search.

The Go extension (go/internal/browsersearch/camoufox.go) embeds this file,
writes it to a cache folder, and starts it once with
`uv run --script camoufox_worker.py`. uv reads the inline script metadata
above and builds the environment (camoufox, and Playwright with it), so no
repository virtual environment is needed. The worker keeps one Camoufox
browser warm and serves requests until stdin closes or Go sends "shutdown".

Protocol: one JSON object per line. Go writes to stdin, the worker writes to
the ORIGINAL stdout. File descriptor 1 is redirected to stderr at start, so
library output (Camoufox download progress, warnings) can never corrupt the
protocol stream.

  Go -> worker
    {"op": "init", "protocol": 1, "readabilityPath": str, "policy": {...},
     "headless": bool, "proxy": {"server": str, "bypass": str} | null}
    {"op": "fetch", "id": int, "url": str, "format": "markdown"|"text"|"html",
     "timeoutMs": int}
    {"op": "shutdown"}
  worker -> Go
    {"type": "progress", "message": str, "kind": "download" (first use only)}
    {"type": "ready", "camoufox": str, "browser": str}
    {"type": "fatal", "error": str}            (then the worker exits)
    {"type": "result", "id": int, "ok": true, "finalUrl": str, "title": str,
     "readability": {...} | null, "snapshot": str | null, "html": str | null,
     "blocked": [{"url": str, "reason": str}]}
    {"type": "result", "id": int, "ok": false, "error": str, "blocked": [...]}

SSRF policy: Go sends its own rule lists (urlvalidation.go) in "init". The
worker routes every browser request (navigations, redirects, subresources,
WebSockets) through `check_url`, which applies the same rules as Go's
ValidateURLWithDNS: scheme, metadata hostnames, localhost, blocked IPv4
ranges, blocked IPv6 patterns, private suffixes, and every DNS answer.
Blocked requests are aborted before the browser sends them. Playwright does
not call route handlers for redirect hops, so a "request" listener checks
each hop after the browser sent it; a hop that breaks the policy fails the
whole fetch and no content of it is returned. The module top
level imports only the standard library, so the pure parts are testable
without Camoufox (test_camoufox_worker.py).
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import sys
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlsplit

PROTOCOL = 1
CAMOUFOX_VERSION = "0.5.9"

# The in-page Readability call. Go's container path (camofox.go
# readabilityRun) evaluates the same expression.
READABILITY_CALL = (
    "; var a = new Readability(document.cloneNode(true)).parse();"
    "JSON.stringify({title: a?.title || null, text: a?.textContent || null, "
    "excerpt: a?.excerpt || null, length: a?.length || 0})"
)
HTML_EXPRESSION = "document.documentElement?.outerHTML || ''"
TEXT_EXPRESSION = "document.body?.innerText || ''"


class ProtocolError(ValueError):
    """A malformed protocol line."""


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def parse_message(line: str) -> Dict[str, Any]:
    """Parse one protocol line from Go and check its shape."""
    try:
        message = json.loads(line)
    except json.JSONDecodeError as error:
        raise ProtocolError(f"invalid JSON: {error.msg}") from error
    if not isinstance(message, dict):
        raise ProtocolError("message is not an object")
    op = message.get("op")
    if op == "init":
        if message.get("protocol") != PROTOCOL:
            raise ProtocolError(f"unsupported protocol {message.get('protocol')!r}")
        if not isinstance(message.get("readabilityPath"), str):
            raise ProtocolError("init needs readabilityPath")
        if not isinstance(message.get("policy"), dict):
            raise ProtocolError("init needs policy")
        return message
    if op == "fetch":
        if not isinstance(message.get("id"), int) or isinstance(message.get("id"), bool):
            raise ProtocolError("fetch needs an integer id")
        if not isinstance(message.get("url"), str) or not message["url"]:
            raise ProtocolError("fetch needs url")
        if message.get("format") not in ("markdown", "text", "html"):
            raise ProtocolError("fetch format must be markdown, text, or html")
        timeout = message.get("timeoutMs")
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
            raise ProtocolError("fetch needs a positive timeoutMs")
        return message
    if op == "shutdown":
        return message
    raise ProtocolError(f"unknown op {op!r}")


def encode(message: Dict[str, Any]) -> str:
    """One protocol line (compact JSON, no raw newlines)."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"


def readability_expression(source: str) -> str:
    return source + READABILITY_CALL


def parse_readability(result: Any) -> Optional[Dict[str, Any]]:
    """JSON.parse(String(result)) as camofox.ts readabilityRun does: None
    when the result is empty or not valid JSON."""
    if not result:
        return None
    try:
        parsed = json.loads(str(result))
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def short_error(error: BaseException) -> str:
    """The first line of an exception message (Playwright adds call logs)."""
    text = str(error).strip() or type(error).__name__
    first = text.splitlines()[0].strip()
    return first[:500]


# ---------------------------------------------------------------------------
# SSRF policy (mirrors urlvalidation.go; the lists come from Go)
# ---------------------------------------------------------------------------

Resolver = Callable[[str], List[Tuple[int, str]]]

DOTTED_QUAD = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
MAPPED = re.compile(r"(?i)^::ffff:(.+)$")
HEX_PREFIX = re.compile(r"^[0-9a-fA-F]+")


def system_resolver(host: str) -> List[Tuple[int, str]]:
    """dns.lookup(host, {all: true}) as (family, address) pairs."""
    out: List[Tuple[int, str]] = []
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP):
        if family == socket.AF_INET:
            out.append((4, str(sockaddr[0])))
        elif family == socket.AF_INET6:
            out.append((6, str(sockaddr[0]).split("%", 1)[0]))
    return out


class Policy:
    """The URL rules Go sends in "init" (BrowserPolicy in policy.go)."""

    def __init__(self, data: Dict[str, Any]) -> None:
        self.schemes = {str(s).lower() for s in data.get("schemes", ["http", "https"])}
        self.blocked_ipv4 = [ipaddress.ip_network(c, strict=False) for c in data.get("blockedIPv4", [])]
        self.blocked_ipv6 = [re.compile(p) for p in data.get("blockedIPv6Patterns", [])]
        self.blocked_hostnames = {str(h).lower() for h in data.get("blockedHostnames", [])}
        self.localhost_names = {str(h).lower() for h in data.get("localhostNames", [])}
        self.blocked_suffixes = [str(s).lower() for s in data.get("blockedSuffixes", [])]

    def ipv4_blocked(self, address: str) -> bool:
        try:
            ip = ipaddress.IPv4Address(address)
        except ValueError:
            return True  # not a valid address: never let it through
        return any(ip in network for network in self.blocked_ipv4)

    def ipv6_blocked(self, address: str) -> bool:
        if any(p.search(address) for p in self.blocked_ipv6):
            return True
        mapped = MAPPED.match(address)
        if not mapped:
            return False
        tail = mapped.group(1)
        if re.match(r"^\d{1,3}(?:\.\d{1,3}){3}$", tail):
            return self.ipv4_blocked(tail)
        parts = tail.split(":")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            return False
        high, low = HEX_PREFIX.match(parts[0]), HEX_PREFIX.match(parts[1])
        if not high or not low:
            return False
        h, lo = int(high.group(0), 16), int(low.group(0), 16)
        return self.ipv4_blocked(f"{(h >> 8) & 255}.{h & 255}.{(lo >> 8) & 255}.{lo & 255}")

    def check_host(self, hostname: str) -> Optional[str]:
        """validateUrl's host rules: a reason, or None when allowed."""
        host = hostname.lower()
        if not host:
            return "Missing hostname"
        if host in self.blocked_hostnames:
            return "Blocked hostname: cloud metadata endpoint"
        if host in self.localhost_names:
            return "Blocked hostname: localhost"
        if DOTTED_QUAD.match(host):
            return f"Blocked IP: {host}" if self.ipv4_blocked(host) else None
        if ":" in host:
            v6 = host.strip("[]")
            return f"Blocked IPv6: {v6}" if self.ipv6_blocked(v6) else None
        for suffix in self.blocked_suffixes:
            if host.endswith(suffix):
                return f"Blocked TLD: {host}"
        return None

    def check_url(self, url: str, resolver: Resolver = system_resolver) -> Optional[str]:
        """validateUrlWithDns: a reason, or None when the URL is allowed."""
        try:
            parts = urlsplit(url)
            hostname = parts.hostname or ""
        except ValueError:
            return "Invalid URL format"
        scheme = parts.scheme.lower()
        # WebSockets follow the rules of their HTTP twins.
        if {"ws": "http", "wss": "https"}.get(scheme, scheme) not in self.schemes:
            return f"Blocked scheme: {scheme}:"
        reason = self.check_host(hostname)
        if reason or DOTTED_QUAD.match(hostname) or ":" in hostname:
            return reason
        try:
            addresses = resolver(hostname)
        except OSError as error:
            return f"DNS lookup failed: {error}"
        if not addresses:
            return "DNS lookup returned no addresses"
        for family, address in addresses:
            if family == 6:
                if self.ipv6_blocked(address):
                    return f"DNS resolved to blocked IPv6: {address}"
            elif self.ipv4_blocked(address):
                return f"DNS resolved to blocked IP: {address}"
        return None


class CachedChecker:
    """Policy.check_url with a per-host DNS answer cache (one fetch)."""

    def __init__(self, policy: Policy, resolver: Resolver = system_resolver, ttl: float = 60.0) -> None:
        self.policy = policy
        self.resolver = resolver
        self.ttl = ttl
        self.cache: Dict[str, Tuple[float, Any]] = {}

    def _resolve(self, host: str) -> List[Tuple[int, str]]:
        now = time.monotonic()
        hit = self.cache.get(host)
        if hit and now - hit[0] < self.ttl:
            if isinstance(hit[1], OSError):
                raise hit[1]
            return hit[1]
        try:
            answer = self.resolver(host)
        except OSError as error:
            self.cache[host] = (now, error)
            raise
        self.cache[host] = (now, answer)
        return answer

    def __call__(self, url: str) -> Optional[str]:
        return self.policy.check_url(url, self._resolve)


# ---------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------


class FetchState:
    """What the browser handlers record during one fetch."""

    def __init__(self, checker: Callable[[str], Optional[str]]) -> None:
        self.checker = checker
        self.blocked: List[Dict[str, str]] = []
        self.main_blocked: List[str] = []
        self.redirect_blocked: List[str] = []

    def first_block(self) -> Optional[str]:
        reasons = self.main_blocked or self.redirect_blocked
        return reasons[0] if reasons else None


class Worker:
    """One warm Camoufox browser with one context and one page, reused by
    every fetch (opening a Camoufox page takes seconds; navigating an open
    one does not). Cookies persist across fetches, as in the Camofox
    container's default session. One fetch at a time."""

    def __init__(self, emit: Callable[[Dict[str, Any]], None]) -> None:
        self.emit = emit
        self.manager: Any = None
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self.policy: Optional[Policy] = None
        self.state: Optional[FetchState] = None
        self.opening = False
        self.readability = ""

    def progress(self, message: str, kind: Optional[str] = None) -> None:
        message_out: Dict[str, Any] = {"type": "progress", "message": message}
        if kind:
            message_out["kind"] = kind
        self.emit(message_out)

    def start(self, init: Dict[str, Any]) -> None:
        with open(init["readabilityPath"], encoding="utf-8") as handle:
            self.readability = handle.read()
        self.policy = Policy(init["policy"])
        self.state = FetchState(CachedChecker(self.policy))
        try:
            from camoufox.pkgman import camoufox_path
            from camoufox.sync_api import Camoufox
        except ImportError as error:
            raise RuntimeError(f"the camoufox Python package is not available: {error}") from error
        try:
            camoufox_path(download_if_missing=False)
        except Exception:  # noqa: BLE001 - any "not installed" form means download
            self.progress("Downloading the Camoufox browser (first use; this can take several minutes)…", "download")
            camoufox_path()
            self.progress("Camoufox browser downloaded.")
        self.progress("Launching Camoufox…")
        options: Dict[str, Any] = {"headless": bool(init.get("headless", True)), "block_webrtc": True}
        proxy = init.get("proxy")
        if isinstance(proxy, dict) and proxy.get("server"):
            options["proxy"] = {k: str(v) for k, v in proxy.items() if v}
        self.manager = Camoufox(**options)
        self.browser = self.manager.__enter__()
        self._open_page()
        version = ""
        try:
            version = str(self.browser.version)
        except Exception:  # noqa: BLE001 - informational only
            pass
        self.emit({"type": "ready", "camoufox": CAMOUFOX_VERSION, "browser": version})

    def _open_page(self) -> None:
        if self.context is None:
            context = self.browser.new_context(service_workers="block")
            context.route("**/*", self._on_route)
            context.route_web_socket(re.compile(".*"), self._on_websocket)
            context.on("request", self._on_request)
            context.on("page", self._on_page)
            self.context = context
        self.opening = True
        try:
            self.page = self.context.new_page()
        finally:
            self.opening = False

    # Browser handlers. They read self.state, the current fetch.

    def _on_route(self, route: Any, req: Any) -> None:
        state = self.state
        reason = state.checker(req.url) if state else "no fetch is running"
        if reason is None:
            route.continue_()
            return
        if state:
            state.blocked.append({"url": req.url, "reason": reason})
            try:
                if req.is_navigation_request() and req.frame.parent_frame is None:
                    state.main_blocked.append(reason)
            except Exception:  # noqa: BLE001 - a detached frame is not the main frame
                pass
        route.abort("blockedbyclient")

    def _on_request(self, req: Any) -> None:
        # Playwright never calls route handlers for redirect hops, so the
        # browser has already sent this request. A hop that breaks the
        # policy fails the whole fetch: no content from it reaches Go.
        state = self.state
        try:
            if state is None or req.redirected_from is None:
                return
        except Exception:  # noqa: BLE001
            return
        reason = state.checker(req.url)
        if reason is not None:
            state.blocked.append({"url": req.url, "reason": reason})
            state.redirect_blocked.append(f"redirect to {req.url}: {reason}")

    def _on_websocket(self, ws: Any) -> None:
        state = self.state
        reason = state.checker(ws.url) if state else "no fetch is running"
        if reason is None:
            ws.connect_to_server()
            return
        if state:
            state.blocked.append({"url": ws.url, "reason": reason})
        ws.close()

    def _on_page(self, page: Any) -> None:
        # Popups and new windows are never read; close them at once.
        if not self.opening and page is not self.page:
            try:
                page.close()
            except Exception:  # noqa: BLE001
                pass

    def close(self) -> None:
        manager, self.manager, self.browser, self.context, self.page = self.manager, None, None, None, None
        if manager is not None:
            try:
                manager.__exit__(None, None, None)
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass

    def connected(self) -> bool:
        try:
            return bool(self.browser and self.browser.is_connected())
        except Exception:  # noqa: BLE001
            return False

    def fetch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        assert self.browser is not None and self.policy is not None
        url, fmt, timeout = request["url"], request["format"], int(request["timeoutMs"])
        state = FetchState(CachedChecker(self.policy))
        self.state = state

        def failure(message: str) -> Dict[str, Any]:
            # A failure never carries page content.
            return {"type": "result", "id": request["id"], "ok": False, "error": message, "blocked": state.blocked}

        try:
            if self.page is None or self.page.is_closed():
                self._open_page()
            page = self.page
            error = self._navigate(page, url, timeout)
            if state.first_block():
                return failure(f"URL blocked: {state.first_block()}")
            if error is not None:
                return failure(error)
            result: Dict[str, Any] = {"type": "result", "id": request["id"], "ok": True, "blocked": state.blocked,
                                      "finalUrl": page.url, "title": self._title(page)}
            if fmt == "html":
                result.update({"html": str(page.evaluate(HTML_EXPRESSION) or ""), "readability": None, "snapshot": None})
            else:
                article = None
                for attempt in (1, 2):
                    article = parse_readability(page.evaluate(readability_expression(self.readability)))
                    if article and article.get("text"):
                        break
                    article = None
                    if attempt == 1:
                        page.wait_for_timeout(1500)
                result.update({"readability": article, "html": None, "snapshot": None if article else self._snapshot(page)})
            if state.first_block():
                return failure(f"URL blocked: {state.first_block()}")
            return result
        except Exception as error:  # noqa: BLE001 - every page failure is a result
            if state.first_block():
                return failure(f"URL blocked: {state.first_block()}")
            return failure(short_error(error))
        finally:
            self._reset()

    def _reset(self) -> None:
        """Leave the page blank between fetches (no page scripts run while
        the worker waits)."""
        self.state = FetchState(CachedChecker(self.policy)) if self.policy else None
        try:
            if self.page is not None and not self.page.is_closed():
                self.page.goto("about:blank", timeout=5000)
        except Exception:  # noqa: BLE001 - a broken page is reopened next time
            try:
                self.page.close()
            except Exception:  # noqa: BLE001
                pass
            self.page = None

    @staticmethod
    def _navigate(page: Any, url: str, timeout: int) -> Optional[str]:
        """goto at DOMContentLoaded; a timeout still accepts a document that
        has started (as the CloakBrowser fallback did). Then a short wait for
        the load event."""
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        except Exception as error:  # noqa: BLE001
            message = short_error(error)
            if "Timeout" not in message:
                return message
            try:
                state = page.evaluate("document.readyState")
                text = page.evaluate("(document.body?.innerText || '').trim().length")
            except Exception:  # noqa: BLE001
                return message
            if state == "loading" and not text:
                return message
        try:
            page.wait_for_load_state("load", timeout=min(5000, timeout))
        except Exception:  # noqa: BLE001 - slow subresources do not fail the page
            pass
        return None

    @staticmethod
    def _title(page: Any) -> str:
        try:
            return str(page.title() or "")
        except Exception:  # noqa: BLE001
            return ""

    @staticmethod
    def _snapshot(page: Any) -> str:
        """The accessibility snapshot (as the container path), else the body
        text."""
        try:
            snapshot = page.locator("body").aria_snapshot(timeout=5000)
            if snapshot and snapshot.strip():
                return str(snapshot)
        except Exception:  # noqa: BLE001
            pass
        try:
            return str(page.evaluate(TEXT_EXPRESSION) or "")
        except Exception:  # noqa: BLE001
            return ""


def serve(lines: Iterable[str], emit: Callable[[Dict[str, Any]], None], worker: Any) -> int:
    """The request loop: init first, then fetches until shutdown or EOF."""
    started = False
    try:
        for line in lines:
            if not line.strip():
                continue
            try:
                message = parse_message(line)
            except ProtocolError as error:
                if not started:
                    emit({"type": "fatal", "error": f"protocol error: {error}"})
                    return 2
                emit({"type": "progress", "message": f"ignored a malformed request: {error}"})
                continue
            op = message["op"]
            if op == "shutdown":
                return 0
            if op == "init":
                if started:
                    continue
                try:
                    worker.start(message)
                except Exception as error:  # noqa: BLE001 - reported to Go
                    emit({"type": "fatal", "error": f"Camoufox failed to start: {short_error(error)}"})
                    return 1
                started = True
                continue
            if not started:
                emit({"type": "result", "id": message["id"], "ok": False, "error": "worker not initialized", "blocked": []})
                continue
            emit(worker.fetch(message))
            if hasattr(worker, "connected") and not worker.connected():
                # The browser died: exit so Go starts a new worker.
                return 1
        return 0
    finally:
        worker.close()


def main() -> int:
    # Keep the protocol on a private copy of stdout; everything else that
    # writes to fd 1 (rich progress bars, warnings) goes to stderr.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def emit(message: Dict[str, Any]) -> None:
        protocol.write(encode(message))
        protocol.flush()

    stdin = (line.decode("utf-8", "replace") for line in iter(sys.stdin.buffer.readline, b""))
    return serve(stdin, emit, Worker(emit))


if __name__ == "__main__":
    sys.exit(main())
