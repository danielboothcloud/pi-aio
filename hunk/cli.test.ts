// Regression tests for hunk CLI helpers: arg builders, JSON parsing, error
// classification, and the launcher decision.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildCommentAddArgs,
	buildCommentBatch,
	buildHighlightAddArgs,
	buildNavigateArgs,
	buildReloadArgs,
	execHunkSession,
	hunkCliError,
	parseHunkJson,
	sessionTargetArgs,
} from "./cli.js";
import {
	buildOttyCommand,
	formatHunkCommand,
	launchHunkInteractive,
	planLaunchAttempts,
	shellSingleQuote,
	type HunkExecLike,
} from "./launcher.js";
import { resolveHunkSkillPath, resetHunkSkillPathForTests } from "./skill.js";
import { HUNK_BINARY } from "./cli.js";

// ---- session targeting ----

test("sessionTargetArgs: explicit id wins over repo", () => {
	assert.deepEqual(sessionTargetArgs(["session", "get"], { sessionId: "s1", repo: "/repo" }), [
		"session",
		"get",
		"s1",
	]);
	assert.deepEqual(sessionTargetArgs(["session", "get"], { repo: "/repo" }), ["session", "get", "--repo", "/repo"]);
	assert.deepEqual(sessionTargetArgs(["session", "get"], {}), ["session", "get", "--repo", "."]);
});

// ---- arg builders ----

test("buildCommentAddArgs: file + exactly one line anchor", () => {
	assert.deepEqual(
		buildCommentAddArgs({ repo: "." }, { filePath: "README.md", newLine: 103, summary: "Tighten this wording" }),
		["session", "comment", "add", "--repo", ".", "--file", "README.md", "--new-line", "103", "--summary", "Tighten this wording"],
	);
	assert.deepEqual(
		buildCommentAddArgs({}, { filePath: "src/a.ts", oldLine: 5, summary: "s", focus: true }),
		["session", "comment", "add", "--repo", ".", "--file", "src/a.ts", "--old-line", "5", "--summary", "s", "--focus"],
	);
});

test("buildCommentAddArgs: replies inherit the anchor", () => {
	assert.deepEqual(buildCommentAddArgs({}, { replyTo: "user:123", summary: "Addressed" }), [
		"session",
		"comment",
		"add",
		"--repo",
		".",
		"--reply-to",
		"user:123",
		"--summary",
		"Addressed",
	]);
});

test("buildCommentAddArgs: validation errors", () => {
	assert.throws(() => buildCommentAddArgs({}, { summary: "s" }), /requires filePath/);
	assert.throws(() => buildCommentAddArgs({}, { filePath: "f", summary: "s" }), /oldLine or newLine/);
	assert.throws(
		() => buildCommentAddArgs({}, { filePath: "f", summary: "s", oldLine: 1, newLine: 2 }),
		/oldLine or newLine/,
	);
});

test("buildHighlightAddArgs: offsets and tones", () => {
	assert.deepEqual(
		buildHighlightAddArgs({}, { filePath: "src/App.tsx", newLine: 42, start: 6, end: 19, tone: "warning", focus: true }),
		[
			"session",
			"highlight",
			"add",
			"--repo",
			".",
			"--file",
			"src/App.tsx",
			"--new-line",
			"42",
			"--start",
			"6",
			"--end",
			"19",
			"--tone",
			"warning",
			"--focus",
		],
	);
});

test("buildHighlightAddArgs: validation errors", () => {
	assert.throws(
		() => buildHighlightAddArgs({}, { filePath: "f", newLine: 1, start: 5, end: 5 }),
		/end must be greater than start/,
	);
	assert.throws(() => buildHighlightAddArgs({}, { filePath: "f", start: 0, end: 3 }), /oldLine or newLine/);
});

test("buildNavigateArgs: exact, comment, and relative navigation", () => {
	assert.deepEqual(buildNavigateArgs({}, { filePath: "src/App.tsx", hunk: 2 }), [
		"session",
		"navigate",
		"--repo",
		".",
		"--file",
		"src/App.tsx",
		"--hunk",
		"2",
	]);
	assert.deepEqual(buildNavigateArgs({}, { filePath: "src/App.tsx", newLine: 372 }), [
		"session",
		"navigate",
		"--repo",
		".",
		"--file",
		"src/App.tsx",
		"--new-line",
		"372",
	]);
	assert.deepEqual(buildNavigateArgs({}, { commentId: "comment-1" }), [
		"session",
		"navigate",
		"--repo",
		".",
		"--comment",
		"comment-1",
	]);
	assert.deepEqual(buildNavigateArgs({}, { nextComment: true }), ["session", "navigate", "--repo", ".", "--next-comment"]);
	assert.deepEqual(buildNavigateArgs({ sessionId: "s1" }, { prevComment: true }), ["session", "navigate", "s1", "--prev-comment"]);
});

test("buildNavigateArgs: validation errors", () => {
	assert.throws(() => buildNavigateArgs({}, { nextComment: true, prevComment: true }), /not both/);
	assert.throws(() => buildNavigateArgs({}, {}), /filePath plus exactly one/);
	assert.throws(() => buildNavigateArgs({}, { filePath: "f", hunk: 1, newLine: 2 }), /exactly one/);
});

test("buildReloadArgs: nested command always after --", () => {
	assert.deepEqual(buildReloadArgs({}, { command: "diff" }), ["session", "reload", "--repo", ".", "--", "diff"]);
	assert.deepEqual(buildReloadArgs({}, { command: "show", target: "HEAD~1", pathspec: ["README.md"] }), [
		"session",
		"reload",
		"--repo",
		".",
		"--",
		"show",
		"HEAD~1",
		"--",
		"README.md",
	]);
	assert.deepEqual(buildReloadArgs({}, { command: "diff", staged: true, excludeUntracked: true }), [
		"session",
		"reload",
		"--repo",
		".",
		"--",
		"diff",
		"--staged",
		"--exclude-untracked",
	]);
	assert.deepEqual(buildReloadArgs({ sessionPath: "/path" }, { command: "diff" }), [
		"session",
		"reload",
		"--session-path",
		"/path",
		"--",
		"diff",
	]);
});

// ---- comment batch ----

test("buildCommentBatch: valid items serialize with anchors", () => {
	const payload = JSON.parse(
		buildCommentBatch([
			{ filePath: "README.md", newLine: 103, summary: "Tighten this wording" },
			{ replyTo: "user:123", summary: "Addressed in the latest revision" },
		]),
	) as { comments: Array<Record<string, unknown>> };
	assert.equal(payload.comments.length, 2);
	assert.deepEqual(payload.comments[0], { summary: "Tighten this wording", filePath: "README.md", newLine: 103 });
	assert.deepEqual(payload.comments[1], { summary: "Addressed in the latest revision", replyTo: "user:123" });
});

test("buildCommentBatch: hunk and rationale fields round-trip", () => {
	const payload = JSON.parse(
		buildCommentBatch([{ filePath: "src/a.ts", hunkNumber: 2, summary: "s", rationale: "r", author: "sonnet" }]),
	) as { comments: Array<Record<string, unknown>> };
	assert.deepEqual(payload.comments[0], {
		summary: "s",
		rationale: "r",
		author: "sonnet",
		filePath: "src/a.ts",
		hunkNumber: 2,
	});
});

// ---- exec + classification ----

test("execHunkSession: appends --json and parses output", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const ex = async (command: string, args: string[]) => {
		calls.push({ command, args });
		return { code: 0, stdout: `{"sessions":[]}`, stderr: "" };
	};
	const result = await execHunkSession(ex, ["session", "list"]);
	assert.deepEqual(calls[0], { command: "hunk", args: ["session", "list", "--json"] });
	assert.deepEqual(result.parsed, { sessions: [] });
	assert.equal(calls[0].command, HUNK_BINARY);
});

test("execHunkSession: failure classification", async () => {
	const noSessions = async () => ({ code: 1, stdout: "", stderr: "Error: No active Hunk sessions" });
	await assert.rejects(execHunkSession(noSessions, ["session", "get"]), (error: Error & { kind?: string }) => {
		assert.equal(error.kind, "no_sessions");
		assert.match(error.message, /Ask the user to open a review/);
		return true;
	});

	const multiple = async () => ({ code: 1, stdout: "", stderr: "Error: Multiple active sessions match" });
	await assert.rejects(execHunkSession(multiple, ["session", "get"]), (error: Error & { kind?: string }) => {
		assert.equal(error.kind, "multiple_sessions");
		return true;
	});

	const notFound = async () => ({ code: 127, stdout: "", stderr: "spawn hunk ENOENT" });
	await assert.rejects(execHunkSession(notFound, ["session", "list"]), (error: Error & { kind?: string }) => {
		assert.equal(error.kind, "not_found");
		return true;
	});

	const generic = async () => ({ code: 2, stdout: "", stderr: "No diff file matches src/missing.ts" });
	await assert.rejects(execHunkSession(generic, ["session", "navigate"]), (error: Error & { kind?: string }) => {
		assert.equal(error.kind, "failed");
		assert.match(error.message, /No diff file matches/);
		return true;
	});
});

// ---- payload parsing ----

test("parseHunkJson: JSON, raw text, and empty payloads", () => {
	assert.deepEqual(parseHunkJson(`{"a":1}`), { a: 1 });
	assert.deepEqual(parseHunkJson("Session s1 at /path"), { raw: "Session s1 at /path" });
	assert.deepEqual(parseHunkJson(""), { raw: "" });
	assert.deepEqual(parseHunkJson("   "), { raw: "" });
});

test("hunkCliError carries kind and stderr", () => {
	const error = hunkCliError("failed", "boom", "detail");
	assert.equal(error.kind, "failed");
	assert.equal(error.stderrText, "detail");
	assert.equal(error.message, "boom");
});

// ---- launcher ----

type EnvLike = NodeJS.ProcessEnv;

function envLike(values: Record<string, string>): EnvLike {
	return values as EnvLike;
}

test("planLaunchAttempts: otty split first when OTTY_PANE_ID is set", () => {
	const plan = planLaunchAttempts(envLike({ OTTY_PANE_ID: "p_1_2" }), "darwin");
	assert.deepEqual(
		plan.map((attempt) => attempt.mode),
		["otty-split", "otty-tab", "macos", "print"],
	);
	assert.match(plan[0]?.reason ?? "", /Otty pane/);
});

test("planLaunchAttempts: tmux wins over the otty tab attempt", () => {
	const plan = planLaunchAttempts(envLike({ TMUX: "/tmp/tmux-0/default,123,0" }), "darwin");
	assert.deepEqual(
		plan.map((attempt) => attempt.mode),
		["tmux", "otty-tab", "macos", "print"],
	);
});

test("planLaunchAttempts: otty tab attempt always present; macOS only on darwin", () => {
	const bare = planLaunchAttempts(envLike({}), "darwin");
	assert.deepEqual(bare.map((attempt) => attempt.mode), ["otty-tab", "macos", "print"]);
	assert.match(bare[bare.length - 1]?.reason ?? "", /run this command yourself/);

	const linux = planLaunchAttempts(envLike({}), "linux");
	assert.deepEqual(linux.map((attempt) => attempt.mode), ["otty-tab", "print"]);
});

test("planLaunchAttempts: iTerm hint on the macOS attempt", () => {
	const plan = planLaunchAttempts(envLike({ TERM_PROGRAM: "iTerm.app" }), "darwin");
	const macos = plan.find((attempt) => attempt.mode === "macos");
	assert.match(macos?.reason ?? "", /iTerm2/);
});

test("buildOttyCommand: hunk script with sh takeover on failure", () => {
	const command = buildOttyCommand(["diff"]);
	assert.match(command, /^sh -c /);
	assert.match(command, /hunk diff/);
	assert.match(command, /status=\$\?/);
	assert.match(command, /exec sh/);

	// Quoted args survive the single-quote escaping.
	const withSpace = buildOttyCommand(["diff", "--", "my file.ts"]);
	assert.match(withSpace, /"my file.ts"/);
});

test("shellSingleQuote: POSIX escaping for embedded quotes", () => {
	assert.equal(shellSingleQuote("plain"), "'plain'");
	assert.equal(shellSingleQuote("it's"), "'it'\\''s'");
});

test("launchHunkInteractive: otty split success returns pane output", async () => {
	const ex = fakeLauncherExec({ otty: [{ code: 0, stdout: "p_x", stderr: "" }] });
	const output = await launchHunkInteractive(ex, ctxLike(), ["diff"]);
	assert.match(output, /Otty pane beside this session/);
	assert.match(output, /hunk diff/);
});

test("launchHunkInteractive: anchored split passes --pane when OTTY_PANE_ID is set", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const ex: HunkExecLike = {
		exec: async (command, args) => {
			calls.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	const previousPaneId = process.env.OTTY_PANE_ID;
	process.env.OTTY_PANE_ID = "p_1a0bf8aaf9c_7";
	try {
		await launchHunkInteractive(ex, ctxLike(), ["diff"]);
	} finally {
		if (previousPaneId === undefined) {
			delete process.env.OTTY_PANE_ID;
		} else {
			process.env.OTTY_PANE_ID = previousPaneId;
		}
	}
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.command, "otty");
	const splitArgs = calls[0]?.args ?? [];
	assert.deepEqual(splitArgs.slice(0, 6), ["pane", "split", "--direction", "right", "--size", "50"]);
	assert.match(splitArgs.join(" "), /--pane p_1a0bf8aaf9c_7/);
	assert.match(splitArgs.join(" "), /--cwd /);
	assert.match(splitArgs.join(" "), /--title hunk/);
	assert.match(splitArgs.join(" "), /--quiet/);
});

test("formatHunkCommand: quoting only when needed", () => {
	assert.equal(formatHunkCommand(["diff"]), "hunk diff");
	assert.equal(formatHunkCommand(["show", "HEAD~1"]), "hunk show HEAD~1");
	assert.equal(formatHunkCommand(["diff", "--", "my file.ts"]), 'hunk diff -- "my file.ts"');
});

// ---- skill resolution ----

test("resolveHunkSkillPath: resolves, caches, and degrades", async (t) => {
	resetHunkSkillPathForTests();
	const skillDir = mkdtempSync(join(tmpdir(), "aio-hunk-skill-"));
	const skillFile = join(skillDir, "SKILL.md");
	writeFileSync(skillFile, "# hunk-review\n");
	t.after(() => rmSync(skillDir, { recursive: true, force: true }));

	let calls = 0;
	const ok = async (command: string, args: string[]) => {
		calls += 1;
		assert.deepEqual([command, args], ["hunk", ["skill", "path"]]);
		return { code: 0, stdout: `${skillFile}\n`, stderr: "" };
	};
	assert.equal(await resolveHunkSkillPath(ok), skillFile);
	assert.equal(await resolveHunkSkillPath(ok), skillFile);
	assert.equal(calls, 1, "the skill path resolves once and caches");

	resetHunkSkillPathForTests();
	const failing = async () => ({ code: 1, stdout: "", stderr: "not installed" });
	assert.equal(await resolveHunkSkillPath(failing), undefined);

	resetHunkSkillPathForTests();
	const throwing = async () => {
		throw new Error("ENOENT");
	};
	assert.equal(await resolveHunkSkillPath(throwing), undefined);

	resetHunkSkillPathForTests();
	const missing = async () => ({ code: 0, stdout: "/tmp/aio-hunk-skill-missing/SKILL.md\n", stderr: "" });
	assert.equal(await resolveHunkSkillPath(missing), undefined);

	resetHunkSkillPathForTests();
});

// ---- launcher helpers + fall-through integration ----

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function ctxLike(): ExtensionContext {
	return { cwd: "/tmp/aio-hunk-launch-test" } as ExtensionContext;
}

/**
 * Scripted exec: each command gets a queue of results; an empty queue
 * reports exit 127 (binary missing), which every launcher treats as a
 * fall-through failure.
 */
function fakeLauncherExec(script: Record<string, Array<{ code: number; stdout?: string; stderr?: string }>>): HunkExecLike {
	const queues = new Map(Object.entries(script));
	return {
		exec: async (command) => {
			const queue = queues.get(command) ?? [];
			const next = queue.shift();
			if (!next) {
				return { code: 127, stdout: "", stderr: "command not found" };
			}
			return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
		},
	};
}

async function withPaneEnv<T>(paneId: string | undefined, run: () => Promise<T>): Promise<T> {
	const previous = process.env.OTTY_PANE_ID;
	if (paneId === undefined) {
		delete process.env.OTTY_PANE_ID;
	} else {
		process.env.OTTY_PANE_ID = paneId;
	}
	try {
		return await run();
	} finally {
		if (previous === undefined) {
			delete process.env.OTTY_PANE_ID;
		} else {
			process.env.OTTY_PANE_ID = previous;
		}
	}
}

test("launchHunkInteractive: falls through otty split failure to the otty tab attempt", async () => {
	const ex = fakeLauncherExec({
		// Two otty calls: the anchored split fails (app not running), then the
		// tab attempt succeeds.
		otty: [{ code: 127 }, { code: 0 }],
	});
	const output = await withPaneEnv("p_1", async () => launchHunkInteractive(ex, ctxLike(), ["diff"]));
	assert.match(output, /new Otty tab/);
});

test("launchHunkInteractive: tmux attempt sits between the otty attempts", async () => {
	// Inside tmux but outside Otty: the split attempt is absent from the
	// plan, the tmux attempt runs first and succeeds.
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-0/default,123,0";
	try {
		const ex = fakeLauncherExec({ tmux: [{ code: 0 }] });
		const output = await withPaneEnv(undefined, async () => launchHunkInteractive(ex, ctxLike(), ["diff"]));
		assert.match(output, /new tmux window/);
	} finally {
		if (previousTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = previousTmux;
		}
	}
});

test("launchHunkInteractive: falls through tmux to the otty tab attempt", async () => {
	const ex = fakeLauncherExec({
		tmux: [], // 127 — not inside tmux
		otty: [{ code: 0 }],
	});
	const output = await withPaneEnv(undefined, async () => launchHunkInteractive(ex, ctxLike(), ["diff"]));
	assert.match(output, /new Otty tab/);
});

test("launchHunkInteractive: falls through otty to macOS and ends at print", async () => {
	const ex = fakeLauncherExec({
		otty: [],
		osascript: [], // 127 — no launcher permission
	});
	const output = await withPaneEnv(undefined, async () => launchHunkInteractive(ex, ctxLike(), ["diff", "--staged"]));
	assert.match(output, /run this command yourself/);
	assert.match(output, /hunk diff --staged/);
});

test("launchHunkInteractive: tab attempt never runs when the split attempt succeeds", async () => {
	const ex = fakeLauncherExec({
		otty: [{ code: 0 }, { code: 0 }],
	});
	const output = await withPaneEnv("p_1", async () => launchHunkInteractive(ex, ctxLike(), ["diff"]));
	assert.match(output, /Otty pane beside this session/);
});
