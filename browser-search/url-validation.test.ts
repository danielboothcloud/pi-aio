import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUrl } from "./url-validation.ts";

function blocked(url: string): string {
	const result = validateUrl(url);
	assert.equal(result.valid, false, `${url} should be blocked`);
	return result.valid ? "" : result.reason;
}

test("validateUrl accepts public HTTP(S) destinations", () => {
	assert.deepEqual(validateUrl("https://example.com/path"), { valid: true });
	assert.deepEqual(validateUrl("http://8.8.8.8/"), { valid: true });
});

test("validateUrl rejects non-HTTP schemes and local hostnames", () => {
	assert.match(blocked("file:///etc/passwd"), /Blocked scheme/);
	assert.match(blocked("ftp://example.com/file"), /Blocked scheme/);
	assert.match(blocked("http://localhost/admin"), /localhost/);
	assert.match(blocked("http://service.internal/admin"), /Blocked TLD/);
	assert.match(blocked("http://router.local/admin"), /Blocked TLD/);
});

test("validateUrl rejects private, metadata, and alternate-form IPv4", () => {
	for (const url of [
		"http://127.0.0.1",
		"http://10.0.0.1",
		"http://172.16.0.1",
		"http://192.168.1.1",
		"http://169.254.169.254",
		"http://2130706433",
		"http://0177.0.0.1",
	]) {
		assert.match(blocked(url), /Blocked IP/);
	}
});

test("validateUrl rejects unsafe IPv6 including IPv4-mapped loopback", () => {
	for (const url of [
		"http://[::]",
		"http://[::1]",
		"http://[fe80::1]",
		"http://[fc00::1]",
		"http://[fd00::1]",
		"http://[::ffff:127.0.0.1]",
	]) {
		assert.match(blocked(url), /Blocked IPv6/);
	}
});

test("validateUrl rejects known metadata hostnames", () => {
	assert.match(
		blocked("http://metadata.google.internal/computeMetadata/v1"),
		/metadata endpoint/,
	);
});
