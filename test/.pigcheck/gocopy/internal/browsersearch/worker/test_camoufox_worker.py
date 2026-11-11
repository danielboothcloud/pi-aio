"""Unit tests for the pure parts of camoufox_worker.py (no browser).

Run with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s
go/internal/browsersearch/worker` or pytest. The Go test TestPythonWorkerUnit runs them too. The policy and
its cases come from ../testdata/browser-policy.json, which the Go test
TestBrowserPolicyFixture writes from the Go rule tables, so both languages
check one rule list.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # no __pycache__ beside the embedded worker
SPEC = importlib.util.spec_from_file_location("camoufox_worker", os.path.join(HERE, "camoufox_worker.py"))
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)

with open(os.path.join(HERE, "..", "testdata", "browser-policy.json"), encoding="utf-8") as handle:
    FIXTURE = json.load(handle)

PUBLIC = [(4, "93.184.216.34")]


def resolver_for(table: Dict[str, List[Any]]):
    def resolve(host: str):
        if host not in table:
            raise OSError(f"getaddrinfo ENOTFOUND {host}")
        return [tuple(row) for row in table[host]]

    return resolve


class PolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = worker.Policy(FIXTURE["policy"])

    def test_host_cases_match_go(self) -> None:
        for case in FIXTURE["hostCases"]:
            reason = self.policy.check_host(case["host"])
            with self.subTest(host=case["host"]):
                self.assertEqual(reason is None, case["valid"], reason)
                if not case["valid"]:
                    self.assertEqual(reason, case["reason"])

    def test_dns_answers(self) -> None:
        resolve = resolver_for({
            "public.test": [[4, "93.184.216.34"]],
            "rebind.test": [[4, "93.184.216.34"], [4, "10.0.0.5"]],
            "loop6.test": [[6, "::1"]],
            "mapped.test": [[6, "::ffff:7f00:1"]],
            "empty.test": [],
        })
        check = lambda url: self.policy.check_url(url, resolve)  # noqa: E731
        self.assertIsNone(check("https://public.test/a"))
        self.assertEqual(check("https://rebind.test/"), "DNS resolved to blocked IP: 10.0.0.5")
        self.assertEqual(check("https://loop6.test/"), "DNS resolved to blocked IPv6: ::1")
        self.assertEqual(check("https://mapped.test/"), "DNS resolved to blocked IPv6: ::ffff:7f00:1")
        self.assertEqual(check("https://empty.test/"), "DNS lookup returned no addresses")
        self.assertEqual(check("https://missing.test/"), "DNS lookup failed: getaddrinfo ENOTFOUND missing.test")

    def test_schemes_and_literals(self) -> None:
        never = resolver_for({})
        self.assertEqual(self.policy.check_url("file:///etc/passwd", never), "Blocked scheme: file:")
        self.assertEqual(self.policy.check_url("ftp://8.8.8.8/", never), "Blocked scheme: ftp:")
        self.assertIsNone(self.policy.check_url("wss://8.8.8.8/socket", never))
        self.assertEqual(self.policy.check_url("ws://127.0.0.1:9/", never), "Blocked IP: 127.0.0.1")
        self.assertEqual(self.policy.check_url("http://[::1]:8080/", never), "Blocked IPv6: ::1")
        self.assertEqual(self.policy.check_url("http://169.254.169.254/latest", never), "Blocked IP: 169.254.169.254")
        self.assertEqual(self.policy.check_url("http://LOCALHOST/", never), "Blocked hostname: localhost")
        self.assertEqual(self.policy.check_url("http://printer.local/", never), "Blocked TLD: printer.local")

    def test_loopback_test_policy(self) -> None:
        data = dict(FIXTURE["policy"])
        data["blockedIPv4"] = [c for c in data["blockedIPv4"] if c != "127.0.0.0/8"]
        policy = worker.Policy(data)
        self.assertIsNone(policy.check_url("http://127.0.0.1:8000/page", resolver_for({})))
        self.assertEqual(policy.check_url("http://10.1.2.3/", resolver_for({})), "Blocked IP: 10.1.2.3")

    def test_cached_checker_reuses_answers(self) -> None:
        calls: List[str] = []

        def resolve(host: str):
            calls.append(host)
            return PUBLIC

        check = worker.CachedChecker(self.policy, resolve)
        self.assertIsNone(check("https://a.test/1"))
        self.assertIsNone(check("https://a.test/2"))
        self.assertEqual(calls, ["a.test"])


class MessageTest(unittest.TestCase):
    def test_parse_valid(self) -> None:
        init = worker.parse_message(json.dumps({"op": "init", "protocol": 1, "readabilityPath": "/x", "policy": {}}))
        self.assertEqual(init["op"], "init")
        fetch = worker.parse_message('{"op":"fetch","id":3,"url":"https://a","format":"text","timeoutMs":5}')
        self.assertEqual(fetch["id"], 3)
        self.assertEqual(worker.parse_message('{"op":"shutdown"}')["op"], "shutdown")

    def test_parse_invalid(self) -> None:
        bad = [
            "not json",
            "[1]",
            '{"op":"dance"}',
            '{"op":"init","protocol":2,"readabilityPath":"/x","policy":{}}',
            '{"op":"init","protocol":1,"policy":{}}',
            '{"op":"fetch","id":"1","url":"https://a","format":"text","timeoutMs":5}',
            '{"op":"fetch","id":true,"url":"https://a","format":"text","timeoutMs":5}',
            '{"op":"fetch","id":1,"url":"","format":"text","timeoutMs":5}',
            '{"op":"fetch","id":1,"url":"https://a","format":"pdf","timeoutMs":5}',
            '{"op":"fetch","id":1,"url":"https://a","format":"text","timeoutMs":0}',
        ]
        for line in bad:
            with self.subTest(line=line):
                with self.assertRaises(worker.ProtocolError):
                    worker.parse_message(line)

    def test_encode_is_one_line(self) -> None:
        line = worker.encode({"type": "result", "html": "a\nb\u2028c"})
        self.assertTrue(line.endswith("\n"))
        self.assertEqual(line.count("\n"), 1)
        self.assertEqual(json.loads(line)["html"], "a\nb\u2028c")

    def test_readability_helpers(self) -> None:
        self.assertTrue(worker.readability_expression("SRC").startswith("SRC; var a = new Readability(document.cloneNode(true)).parse();"))
        self.assertEqual(worker.parse_readability('{"text":"x"}'), {"text": "x"})
        self.assertIsNone(worker.parse_readability("not json"))
        self.assertIsNone(worker.parse_readability(""))
        self.assertIsNone(worker.parse_readability("[1]"))

    def test_short_error(self) -> None:
        self.assertEqual(worker.short_error(RuntimeError("Page.goto: NS_ERROR\nCall log:\n- x")), "Page.goto: NS_ERROR")
        self.assertEqual(worker.short_error(RuntimeError("")), "RuntimeError")


class FakeWorker:
    def __init__(self, fail_start: bool = False) -> None:
        self.fail_start = fail_start
        self.closed = False
        self.fetched: List[Dict[str, Any]] = []

    def start(self, init: Dict[str, Any]) -> None:
        if self.fail_start:
            raise RuntimeError("no browser\ndetails")

    def fetch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        self.fetched.append(request)
        return {"type": "result", "id": request["id"], "ok": True}

    def close(self) -> None:
        self.closed = True


class ServeTest(unittest.TestCase):
    INIT = json.dumps({"op": "init", "protocol": 1, "readabilityPath": "/x", "policy": {}})
    FETCH = '{"op":"fetch","id":1,"url":"https://a","format":"text","timeoutMs":5}'

    def test_loop(self) -> None:
        out: List[Dict[str, Any]] = []
        fake = FakeWorker()
        code = worker.serve([self.FETCH, self.INIT, "", "garbage", self.FETCH, '{"op":"shutdown"}', self.FETCH], out.append, fake)
        self.assertEqual(code, 0)
        self.assertTrue(fake.closed)
        self.assertEqual(len(fake.fetched), 1)
        self.assertEqual(out[0], {"type": "result", "id": 1, "ok": False, "error": "worker not initialized", "blocked": []})
        self.assertEqual(out[1]["type"], "progress")
        self.assertEqual(out[2], {"type": "result", "id": 1, "ok": True})

    def test_start_failure_is_fatal(self) -> None:
        out: List[Dict[str, Any]] = []
        fake = FakeWorker(fail_start=True)
        self.assertEqual(worker.serve([self.INIT, self.FETCH], out.append, fake), 1)
        self.assertEqual(out, [{"type": "fatal", "error": "Camoufox failed to start: no browser"}])
        self.assertTrue(fake.closed)

    def test_malformed_init_is_fatal(self) -> None:
        out: List[Dict[str, Any]] = []
        self.assertEqual(worker.serve(["{}"], out.append, FakeWorker()), 2)
        self.assertEqual(out[0]["type"], "fatal")

    def test_eof_closes(self) -> None:
        fake = FakeWorker()
        self.assertEqual(worker.serve([self.INIT], lambda m: None, fake), 0)
        self.assertTrue(fake.closed)


if __name__ == "__main__":
    unittest.main()
