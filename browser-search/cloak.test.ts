import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cloakFetch, type CloakWorkerDependencies } from "./cloak.ts";
import { fetchInWorker } from "./cloak-worker.mjs";

const fixture = fileURLToPath(new URL("./test-fixture-cloak-worker.mjs", import.meta.url));
const deps: CloakWorkerDependencies = {
	nodeBinary: process.execPath,
	workerPath: fixture,
	timeoutMs: 5_000,
	killGraceMs: 50,
};
const url = (path: string) => `https://8.8.8.8/${path}`;

test("CloakBrowser uses an isolated Node child with only ordinary stdio", async () => {
	let stdio: unknown;
	const result = await cloakFetch({ url: url("ok"), format: "markdown" }, {
		...deps,
		spawn: ((binary, args, options) => {
			assert.equal(binary, process.execPath);
			stdio = options?.stdio;
			return spawn(binary, args, options);
		}) as typeof spawn,
	});
	assert.deepEqual(stdio, ["pipe", "pipe", "pipe"]);
	assert.equal(result.tier, "cloak");
	assert.match(result.content, /Node .*Bun none/);
});

test("an asynchronous worker crash rejects without terminating the host", async () => {
	await assert.rejects(cloakFetch({ url: url("crash") }, deps), /worker failed.*Failed to connect ENOENT/s);
	assert.equal((await cloakFetch({ url: url("still-alive") }, deps)).tier, "cloak");
});

test("missing Node is a catchable tool failure", async () => {
	await assert.rejects(cloakFetch({ url: url("ok") }, {
		...deps, nodeBinary: "/nonexistent/aio-node",
	}), /Could not start CloakBrowser Node worker.*ENOENT/);
});

test("worker errors and invalid output reject", async () => {
	await assert.rejects(cloakFetch({ url: url("error") }, deps), /no stale fallback/);
	for (const path of ["malformed", "shape"]) {
		await assert.rejects(cloakFetch({ url: url(path) }, deps), /Invalid CloakBrowser worker response/);
	}
	await assert.rejects(cloakFetch({ url: url("oversize") }, {
		...deps, maxOutputBytes: 1024,
	}), /exceeded its output limit/);
});

test("SSRF validation and pre-aborted requests never spawn a worker", async () => {
	let spawns = 0;
	const noSpawn = { spawn: (() => { spawns++; throw new Error("must not spawn"); }) as typeof spawn };
	await assert.rejects(cloakFetch({ url: "http://127.0.0.1/private" }, noSpawn), /URL blocked/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(cloakFetch({ url: url("ok"), signal: controller.signal }, noSpawn), { name: "AbortError" });
	assert.equal(spawns, 0);
});

test("cancellation and deadlines reap an unresponsive child before rejecting", async () => {
	for (const abort of [true, false]) {
		let child: ReturnType<typeof spawn> | undefined;
		const controller = new AbortController();
		const pending = cloakFetch({ url: url("hang"), signal: controller.signal }, {
			...deps,
			timeoutMs: abort ? 5_000 : 500,
			spawn: ((...args: Parameters<typeof spawn>) => {
				child = spawn(...args);
				if (abort) child.stdout?.once("data", () => controller.abort());
				return child;
			}) as typeof spawn,
		});
		await assert.rejects(pending, abort ? { name: "AbortError" } : /timed out/);
		assert.ok(child?.pid);
		assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
	}
});

test("descendant pipes cannot keep timeout or worker-exit cleanup pending", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
	for (const scenario of ["descendant", "detached-descendant", "exited-descendant", "exited-detached-descendant"]) {
		let descendant = 0;
		let child: ReturnType<typeof spawn> | undefined;
		try {
			await assert.rejects(cloakFetch({ url: url(scenario) }, {
				...deps,
				timeoutMs: 1_000,
				killGraceMs: 100,
				spawn: ((...args: Parameters<typeof spawn>) => {
					child = spawn(...args);
					child.stdout?.on("data", (chunk: Buffer) => {
						const match = chunk.toString().match(/descendant=(\d+)/);
						if (match) descendant = Number(match[1]);
					});
					return child;
				}) as typeof spawn,
			}), scenario.startsWith("exited-") ? /missing result/ : /timed out/);
			assert.ok(descendant);
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try { process.kill(descendant, 0); }
				catch { alive = false; }
				if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(alive, false, `${scenario} descendant must be reaped`);
		} finally {
			try { if (descendant) process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
			child?.kill("SIGKILL");
		}
	}
});

test("production runtime loads with SDK/dev/parent-browser package resolution forbidden", () => {
	const workerUrl = new URL("./cloak-worker.mjs", import.meta.url).href;
	const script = `
		import { createRequire, registerHooks } from "node:module";
		const require = createRequire(import.meta.url);
		const Module = require("node:module");
		const blocked = id => /^(?:@earendil-works\\/pi-|@mariozechner\\/pi-|typebox(?:\\/|$)|tsx(?:\\/|$)|vitest(?:\\/|$)|cloakbrowser(?:\\/|$)|playwright-core(?:\\/|$))/.test(id);
		const original = Module._resolveFilename;
		Module._resolveFilename = function(id, ...args) {
			if (blocked(id)) throw new Error("Forbidden production dependency: " + id);
			return original.call(this, id, ...args);
		};
		registerHooks({ resolve(id, context, next) {
			if (blocked(id)) throw new Error("Forbidden production dependency: " + id);
			return next(id, context);
		} });
		const { fetchInWorker } = await import(${JSON.stringify(workerUrl)});
		const html = "<html><body><article><h1>Fixture</h1><p>Guarded runtime content.</p></article></body></html>";
		let target = "";
		const context = { pages: () => [], cookies: async () => [], close: async () => {}, newPage: async () => page };
		const page = {
			url: () => target, goto: async url => { target = url; },
			title: async () => "Fixture", content: async () => html,
			evaluate: async fn => fn.toString().includes("documentElement") ? html : "Guarded runtime content.",
			context: () => context, close: async () => {},
		};
		const cloak = { launch: async () => ({ newContext: async () => context, close: async () => {} }) };
		for (const format of ["text", "markdown", "html"]) {
			const result = await fetchInWorker({ url: "https://8.8.8.8/fixture", format, wait: 0 }, {
				latestEntry: async () => "fixture", loadCloak: async () => cloak,
			});
			if (!result.content.includes("Guarded runtime content")) throw new Error("Empty " + format);
		}
		console.log("production runtime OK");
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8", timeout: 15_000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /production runtime OK/);
});

test("the real worker loads TypeScript and uses the latest module supplied", async () => {
	const prior = process.env.CLOAKBROWSER_AUTO_UPDATE;
	let closed = 0;
	let loaded = "";
	let requested = "";
	const html = "<html><body><article><h1>Fixture</h1><p>Readable worker content.</p></article></body></html>";
	const context = {
		pages: () => [], cookies: async () => [], close: async () => { closed++; },
		newPage: async () => page,
	};
	const page = {
		url: () => requested, goto: async (target: string) => { requested = target; },
		title: async () => "Fixture", content: async () => html,
		evaluate: async (fn: Function) => fn.toString().includes("documentElement") ? html : "Readable worker content.",
		context: () => context, close: async () => { closed++; },
	};
	try {
		const result = await fetchInWorker({ url: url("article"), format: "markdown", wait: 0 }, {
			latestEntry: async () => "file:///isolated-latest/cloakbrowser.mjs",
			loadCloak: async (entry: string) => {
				loaded = entry;
				return {
					launch: async () => ({ newContext: async () => context, close: async () => { closed++; } }),
				};
			},
		});
		assert.equal(loaded, "file:///isolated-latest/cloakbrowser.mjs");
		assert.match(result.content, /Readable worker content/);
		assert.equal(result.tier, "cloak");
		assert.equal(closed, 3);
	} finally {
		if (prior === undefined) delete process.env.CLOAKBROWSER_AUTO_UPDATE;
		else process.env.CLOAKBROWSER_AUTO_UPDATE = prior;
	}
});
