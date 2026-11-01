import assert from "node:assert/strict";
import test from "node:test";
import { cleanText, createNotificationBackend, type DesktopNotification, type Execute } from "./backend.ts";

const notification: DesktopNotification = { title: "Pi · Finished", body: "Ready", subtitle: "Session", group: "aio.session.core", sound: "Glass" };
const signal = () => new AbortController().signal;

test("native delivery uses argv, caches discovery, supports sound and click-to-activate", async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const backend = createNotificationBackend({ platform: "darwin", env: { __CFBundleIdentifier: "com.example.Terminal" }, execute: async (bin, args) => { calls.push({ bin, args }); return "com.example.Terminal\n"; } });
	assert.equal(await backend.focused(signal()), true);
	await backend.send(notification, signal(), () => true);
	await backend.send(notification, signal(), () => true);
	assert.equal(calls.filter((call) => call.args[0] === "-help").length, 1);
	const delivery = calls.find((call) => call.args[0] === "-title")!;
	assert.equal(delivery.bin, "terminal-notifier");
	assert.ok(delivery.args.includes("-activate")); assert.ok(delivery.args.includes("com.example.Terminal"));
	assert.ok(delivery.args.includes("-sound")); assert.ok(delivery.args.includes("Glass"));
	assert.ok(delivery.args.includes("aio.session.core"));
	assert.equal(backend.name(), "terminal-notifier");
});

for (const failure of ["missing", "delivery"]) {
	test(`${failure} native backend fails over to sanitized OSC and is not retried`, async () => {
		const output: string[] = []; let probes = 0;
		const backend = createNotificationBackend({ platform: "darwin", env: {}, write: (text) => output.push(text), execute: async (_bin, args) => {
			if (args[0] === "-help") { probes++; if (failure === "missing") throw new Error("ENOENT"); return ""; }
			throw new Error("notification denied");
		} });
		await backend.send({ ...notification, body: "Hello;\x07\x1b]52;c;secrets\x07\nWorld" }, signal(), () => true);
		await backend.send(notification, signal(), () => true);
		assert.equal(probes, 1);
		assert.equal(output.length, 2);
		assert.match(output[0], /^\x1b\]777;notify;Pi · Finished;Session — Hello World\x07$/);
	});
}

for (const env of [{ SSH_CONNECTION: "remote" }, { SSH_TTY: "/dev/pts/1" }]) {
	test("SSH uses local-terminal escape delivery, not remote macOS native/focus", async () => {
		const output: string[] = [];
		const backend = createNotificationBackend({ platform: "darwin", env, write: (text) => output.push(text), execute: async () => { throw new Error("must not execute"); } });
		assert.equal(await backend.focused(signal()), false);
		await backend.send(notification, signal(), () => true); assert.equal(output.length, 1);
	});
}

test("unknown and failing focus checks allow delivery; TERM_PROGRAM fallback is supported", async () => {
	let calls = 0;
	const execute: Execute = async () => { calls++; throw new Error("not permitted"); };
	assert.equal(await createNotificationBackend({ platform: "darwin", env: {}, execute }).focused(signal()), false);
	assert.equal(calls, 0);
	assert.equal(await createNotificationBackend({ platform: "darwin", env: { TERM_PROGRAM: "ghostty" }, execute }).focused(signal()), false);
	assert.equal(calls, 1);
});

test("Kitty uses OSC 99 and tmux doubles escapes in a passthrough frame", async () => {
	const output: string[] = [];
	const backend = createNotificationBackend({ platform: "linux", env: { KITTY_WINDOW_ID: "1", TMUX: "yes" }, write: (text) => output.push(text) });
	await backend.send(notification, signal(), () => true);
	assert.match(output[0], /^\x1bPtmux;/);
	assert.ok(output[0].includes("\x1b\x1b]99;i=aio:d=0;"));
	assert.ok(output[0].includes("\x1b\x1b]99;i=aio:p=body;"));
	assert.equal(backend.name(), "OSC 99");
});

test("cancellation/invalidated work after discovery never delivers or emits a fallback", async () => {
	let resolve!: (value: string) => void; const output: string[] = [];
	const controller = new AbortController();
	const backend = createNotificationBackend({ platform: "darwin", env: {}, write: (text) => output.push(text), execute: () => new Promise((done) => { resolve = done; }) });
	const task = backend.send(notification, controller.signal, () => !controller.signal.aborted);
	controller.abort(); resolve(""); await task;
	assert.equal(output.length, 0);
});

test("control characters, OSC delimiters and ANSI are removed and snippets bounded", () => {
	assert.equal(cleanText("\x1b[31mred\x1b[0m;\n\x9d\x07 hi"), "red hi");
	assert.equal(cleanText("x".repeat(1000)).length, 160);
});
