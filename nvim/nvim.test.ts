// Regression tests for the nvim integration: arg building, target parsing,
// launcher plan/chain, and command formatting. All seams injected — no live
// otty/tmux/osascript calls.

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildNvimArgs,
	buildNvimCompletions,
	buildOttyNvimCommand,
	filePathsFromToolResult,
	formatNvimCommand,
	nvimTitle,
	openInNvim,
	parseFileTarget,
	planNvimLaunchAttempts,
	resolveNvimPath,
	shellSingleQuoteNvim,
	splitNvimTargets,
	stripAtReference,
	touchSessionFiles,
	type NvimExecLike,
	type NvimOpenRequest,
	type SessionFileEntry,
} from "./core.js";

// ---- arg building ----

test("buildNvimArgs: path, line, column, read-only, extra args", () => {
	assert.deepEqual(buildNvimArgs({ path: "src/index.ts" }), ["--", "src/index.ts"]);
	assert.deepEqual(buildNvimArgs({ path: "src/index.ts", line: 42 }), ["+42", "--", "src/index.ts"]);
	assert.deepEqual(buildNvimArgs({ path: "src/index.ts", line: 42, column: 7 }), ["+42,7", "--", "src/index.ts"]);
	assert.deepEqual(buildNvimArgs({ path: "src/index.ts", readOnly: true }), ["-R", "--", "src/index.ts"]);
	assert.deepEqual(buildNvimArgs({ path: "src/index.ts", line: 3, extraArgs: ["-c", "set nu"] }), [
		"+3",
		"-c",
		"set nu",
		"--",
		"src/index.ts",
	]);
	// Invalid line numbers are ignored (nvim treats bare + as line 1).
	assert.deepEqual(buildNvimArgs({ path: "a.ts", line: 0 }), ["--", "a.ts"]);
	assert.deepEqual(buildNvimArgs({ path: "a.ts", line: 1.5 }), ["--", "a.ts"]);
});

// ---- target parsing ----

test("parseFileTarget: path, path:line, path:line:col", () => {
	assert.deepEqual(parseFileTarget("src/index.ts"), { path: "src/index.ts" });
	assert.deepEqual(parseFileTarget("src/index.ts:42"), { path: "src/index.ts", line: 42 });
	assert.deepEqual(parseFileTarget("src/index.ts:42:7"), { path: "src/index.ts", line: 42, column: 7 });
	// Whitespace tolerated; invalid numbers ignored.
	assert.deepEqual(parseFileTarget("  a.ts:0  "), { path: "a.ts" });
	assert.deepEqual(parseFileTarget("a.ts:x"), { path: "a.ts:x" });
	// Windows-style drive paths are not treated as line separators.
	assert.deepEqual(parseFileTarget("C:/repo/a.ts"), { path: "C:/repo/a.ts" });
});

// ---- path resolution ----

test("resolveNvimPath: relative resolves against cwd; absolute passes through", () => {
	assert.equal(resolveNvimPath("src/a.ts", "/repo"), "/repo/src/a.ts");
	assert.equal(resolveNvimPath("/abs/a.ts", "/repo"), "/abs/a.ts");
});

// ---- @-reference handling ----

test("stripAtReference: @path, quoted @path, and plain paths", () => {
	assert.equal(stripAtReference("@src/index.ts"), "src/index.ts");
	assert.equal(stripAtReference('@"my file.ts"'), "my file.ts");
	assert.equal(stripAtReference("src/index.ts:42"), "src/index.ts:42");
	assert.equal(stripAtReference("@"), "");
});

test("splitNvimTargets: @ tokens split; plain args stay one target", () => {
	assert.deepEqual(splitNvimTargets("@a.ts @b.ts:3"), ["@a.ts", "@b.ts:3"]);
	assert.deepEqual(splitNvimTargets("src/my file.ts"), ["src/my file.ts"], "no @: spaces survive");
	assert.deepEqual(splitNvimTargets("  "), []);
	assert.deepEqual(splitNvimTargets("src/a.ts"), ["src/a.ts"]);
});

// ---- session file MRU + completions ----

const readEvent = (input: Record<string, unknown>, isError = false): Parameters<typeof filePathsFromToolResult>[0] =>
	({ toolName: "read", isError, input, content: [], toolCallId: "t1", type: "tool_result" }) as Parameters<
		typeof filePathsFromToolResult
	>[0];

const writeEvent = (input: Record<string, unknown>): Parameters<typeof filePathsFromToolResult>[0] =>
	({ toolName: "write", isError: false, input, content: [], toolCallId: "t2", type: "tool_result" }) as Parameters<
		typeof filePathsFromToolResult
	>[0];

test("filePathsFromToolResult: reads and writes; errors never count", () => {
	assert.deepEqual(filePathsFromToolResult(readEvent({ path: "src/a.ts" })), { paths: ["src/a.ts"], edited: false });
	assert.deepEqual(filePathsFromToolResult(writeEvent({ path: "src/b.ts" })), { paths: ["src/b.ts"], edited: true });
	assert.deepEqual(filePathsFromToolResult(readEvent({ path: "x" }, true)), { paths: [], edited: false });
	assert.deepEqual(filePathsFromToolResult(readEvent({})), { paths: [], edited: false });
});

test("touchSessionFiles: newest first, deduped, edited-ness sticky, bounded", () => {
	let entries: SessionFileEntry[] = [];
	entries = touchSessionFiles(entries, ["/r/a.ts"], false, 1);
	entries = touchSessionFiles(entries, ["/r/b.ts"], true, 2);
	assert.deepEqual(
		entries.map((entry) => entry.path),
		["/r/b.ts", "/r/a.ts"],
	);
	// Re-read keeps the sticky edited flag and bumps recency.
	entries = touchSessionFiles(entries, ["/r/a.ts"], false, 3);
	assert.equal(entries[0]?.edited, false);
	assert.equal(entries[0]?.path, "/r/a.ts");
	entries = touchSessionFiles(entries, ["/r/a.ts"], true, 4);
	assert.equal(entries[0]?.edited, true, "edit upgrades a read entry");
	const many = Array.from({ length: 50 }, (_, i) => `/f/${i}.ts`);
	entries = touchSessionFiles(entries, many, false, 5);
	assert.equal(entries.length, 40);
});

test("buildNvimCompletions: session first, @-prefixed values, prefix-filtered", () => {
	const entries: SessionFileEntry[] = [
		{ path: "/repo/src/index.ts", edited: true, touchedAt: 2 },
		{ path: "/repo/README.md", edited: false, touchedAt: 1 },
	];
	const completions = buildNvimCompletions("", entries, ["package.json", "src/other.ts"], "/repo");
	assert.equal(completions[0]?.value, "@src/index.ts");
	assert.equal(completions[0]?.description, "edited this session");
	assert.equal(completions[1]?.description, "read this session");
	assert.ok(completions.some((item) => item.label === "package.json"));

	const filtered = buildNvimCompletions("@src", entries, ["package.json"], "/repo");
	assert.ok(filtered.every((item) => item.value.includes("src")));
	assert.ok(!filtered.some((item) => item.label === "README.md"));

	// Outside-cwd paths fall back to absolute display.
	const outside = buildNvimCompletions("", [{ path: "/elsewhere/a.ts", edited: false, touchedAt: 1 }], [], "/repo");
	assert.equal(outside[0]?.label, "/elsewhere/a.ts");
});

test("formatNvimCommand: quoting only when needed", () => {
	assert.equal(formatNvimCommand({ path: "src/index.ts", line: 42 }), "nvim +42 -- src/index.ts");
	assert.equal(formatNvimCommand({ path: "my file.ts" }), "nvim -- 'my file.ts'");
	assert.equal(formatNvimCommand({ path: "a.ts", readOnly: true, line: 5 }), "nvim -R +5 -- a.ts");
});

test("shellSingleQuoteNvim: POSIX escaping", () => {
	assert.equal(shellSingleQuoteNvim("plain"), "'plain'");
	assert.equal(shellSingleQuoteNvim("it's"), "'it'\\''s'");
});

test("nvimTitle: basename with optional line", () => {
	assert.equal(nvimTitle({ path: "/repo/src/index.ts" }), "nvim index.ts");
	assert.equal(nvimTitle({ path: "/repo/src/index.ts", line: 42 }), "nvim index.ts:42");
});

test("buildOttyNvimCommand: exec keeps the pane alive in nvim", () => {
	const command = buildOttyNvimCommand({ path: "src/index.ts", line: 42 });
	assert.match(command, /^exec nvim \+42 -- src\/index\.ts$/);
});

// ---- launch plan ----

type EnvLike = NodeJS.ProcessEnv;

function envLike(values: Record<string, string>): EnvLike {
	return values as EnvLike;
}

test("planNvimLaunchAttempts: otty split first inside Otty, tmux next", () => {
	const plan = planNvimLaunchAttempts(envLike({ OTTY_PANE_ID: "p_1" }), "darwin");
	assert.deepEqual(plan.map((attempt) => attempt.mode), ["otty-split", "otty-tab", "macos", "print"]);

	const tmux = planNvimLaunchAttempts(envLike({ TMUX: "x" }), "darwin");
	assert.deepEqual(tmux.map((attempt) => attempt.mode), ["tmux", "otty-tab", "macos", "print"]);

	const bare = planNvimLaunchAttempts(envLike({}), "darwin");
	assert.deepEqual(bare.map((attempt) => attempt.mode), ["otty-tab", "macos", "print"]);

	const linux = planNvimLaunchAttempts(envLike({}), "linux");
	assert.deepEqual(linux.map((attempt) => attempt.mode), ["otty-tab", "print"]);
});

// ---- launch chain (scripted exec) ----

function fakeNvimExec(script: Record<string, Array<{ code: number }>>): NvimExecLike & { calls: Array<{ command: string; args: string[] }> } {
	const queues = new Map(Object.entries(script));
	const calls: Array<{ command: string; args: string[] }> = [];
	return {
		calls,
		exec: async (command, args) => {
			calls.push({ command, args });
			const queue = queues.get(command) ?? [];
			const next = queue.shift();
			return { code: next?.code ?? 127, stdout: "", stderr: next ? "" : "command not found" };
		},
	};
}

function ctxLike(cwd = "/tmp/aio-nvim-test"): Parameters<typeof openInNvim>[1] {
	return { cwd } as Parameters<typeof openInNvim>[1];
}

function withPaneEnv<T>(paneId: string | undefined, run: () => Promise<T>): Promise<T> {
	const previous = process.env.OTTY_PANE_ID;
	if (paneId === undefined) {
		delete process.env.OTTY_PANE_ID;
	} else {
		process.env.OTTY_PANE_ID = paneId;
	}
	return (async () => {
		try {
			return await run();
		} finally {
			if (previous === undefined) {
				delete process.env.OTTY_PANE_ID;
			} else {
				process.env.OTTY_PANE_ID = previous;
			}
		}
	})();
}

test("openInNvim: otty split success with anchored pane and exec command", async () => {
	const fake = fakeNvimExec({ otty: [{ code: 0 }] });
	const output = await withPaneEnv("p_1", async () => openInNvim(fake, ctxLike("/repo"), { path: "src/index.ts", line: 42 }));
	assert.match(output, /Otty pane beside this session/);
	assert.match(output, /src\/index\.ts:42/);

	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0]?.command, "otty");
	const args = fake.calls[0]?.args ?? [];
	assert.deepEqual(args.slice(0, 6), ["pane", "split", "--direction", "right", "--size", "50"]);
	assert.match(args.join(" "), /--pane p_1/);
	assert.match(args.join(" "), /--cwd \/repo/);
	assert.match(args.join(" "), /--title nvim index\.ts:42/);
	assert.match(args.join(" "), /exec nvim \+42 -- src\/index\.ts/);
});

test("openInNvim: falls through otty split failure to the otty tab attempt", async () => {
	const fake = fakeNvimExec({ otty: [{ code: 127 }, { code: 0 }] });
	const output = await withPaneEnv("p_1", async () => openInNvim(fake, ctxLike(), { path: "a.ts" }));
	assert.match(output, /new Otty tab/);
	// Second otty call is a tab: no --pane anchor.
	const tabArgs = fake.calls[1]?.args ?? [];
	assert.equal(tabArgs[0], "tab");
	assert.equal(tabArgs[1], "new");
	assert.equal(tabArgs.includes("--pane"), false);
});

test("openInNvim: tmux attempt sits between the otty attempts", async () => {
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-0/default,123,0";
	try {
		const fake = fakeNvimExec({ tmux: [{ code: 0 }] });
		const output = await withPaneEnv(undefined, async () => openInNvim(fake, ctxLike(), { path: "a.ts" }));
		assert.match(output, /new tmux window/);
		assert.equal(fake.calls[0]?.command, "tmux");
	} finally {
		if (previousTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = previousTmux;
		}
	}
});

test("openInNvim: ends at the print fallback when every launcher fails", async () => {
	const fake = fakeNvimExec({ otty: [], osascript: [] });
	const output = await withPaneEnv(undefined, async () => openInNvim(fake, ctxLike(), { path: "my file.ts", readOnly: true }));
	assert.match(output, /run this command yourself/);
	assert.match(output, /nvim -R -- 'my file\.ts'/);
});

test("openInNvim: read-only requests label the pane and the output", async () => {
	const fake = fakeNvimExec({ otty: [{ code: 0 }] });
	const output = await withPaneEnv("p_1", async () => openInNvim(fake, ctxLike(), { path: "src/a.ts", readOnly: true }));
	assert.match(output, /read-only/);
	const args = fake.calls[0]?.args ?? [];
	assert.match(args.join(" "), /-R -- src\/a\.ts/);
});

// ---- request shape sanity ----

test("NvimOpenRequest round-trips through format/build", () => {
	const request: NvimOpenRequest = { path: "/repo/src/deep file.ts", line: 3, column: 9, readOnly: true };
	const formatted = formatNvimCommand(request);
	assert.equal(formatted, "nvim -R +3,9 -- '/repo/src/deep file.ts'");
});
