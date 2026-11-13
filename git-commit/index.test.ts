import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerCommit, runCommit, suggestMessage, type MessageCompleteFn } from "./index.js";
import { createGitRunner } from "./git.js";
import { FALLBACK_MESSAGE, MESSAGE_INSTRUCTIONS } from "./message.js";

// The TUI loader renders key hints through Pi's global theme.
initTheme("dark", false);

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

function fakePi() {
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerShortcut: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	return { pi, commands, tools };
}

describe("registration", () => {
	const saved = process.env.AIO_SUBAGENT_CHILD;
	afterEach(() => {
		if (saved === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = saved;
	});

	it("registers the /commit command and no agent tool", () => {
		delete process.env.AIO_SUBAGENT_CHILD;
		const { pi, commands, tools } = fakePi();
		registerCommit(pi);
		assert.deepEqual(commands, ["commit"]);
		assert.deepEqual(tools, []);
	});

	it("registers nothing in subagent children", () => {
		process.env.AIO_SUBAGENT_CHILD = "1";
		const { pi, commands, tools } = fakePi();
		registerCommit(pi);
		assert.deepEqual(commands, []);
		assert.deepEqual(tools, []);
	});
});

function reply(text: string): MessageCompleteFn {
	return async () => ({ content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }], stopReason: "stop" });
}

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

interface Answers {
	confirm?: boolean[];
	editor?: Array<string | undefined>;
	select?: Array<string | undefined>;
	/** Overlay keys, one per opening of the commit view (TUI only). */
	keys?: string[];
}

interface Seen {
	notes: string[];
	confirmTitles: string[];
}

describe("/commit flow in a scratch repository", () => {
	let dir: string;
	let repo: string;
	let remote: string;
	const saved = { ...process.env };

	before(() => {
		Object.assign(process.env, GIT_ENV);
		dir = mkdtempSync(join(tmpdir(), "aio-commit-flow-"));
		repo = join(dir, "work");
		remote = join(dir, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "a.txt"), "a\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "chore(repo): init");
		sh(repo, "remote", "add", "origin", remote);
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	});

	function ctx(mode: "rpc" | "tui", answers: Answers, seen: Seen) {
		const keys = [...(answers.keys ?? [])];
		return {
			cwd: repo,
			hasUI: true,
			mode,
			model: { provider: "test", id: "m" },
			modelRegistry: { complete: () => { throw new Error("unused"); } },
			ui: {
				confirm: async (title: string) => {
					seen.confirmTitles.push(title);
					return answers.confirm?.shift() ?? false;
				},
				editor: async (_title: string, prefill?: string) => {
					const next = answers.editor?.shift();
					return next === "<keep>" ? prefill : next;
				},
				select: async () => answers.select?.shift(),
				notify: (message: string) => seen.notes.push(message),
				custom: (factory: (...args: unknown[]) => { handleInput?: (data: string) => void; dispose?: () => void }, options?: { overlay?: boolean }) =>
					new Promise((resolve) => {
						let component: { handleInput?: (data: string) => void; dispose?: () => void } | undefined;
						const done = (value: unknown) => {
							component?.dispose?.();
							resolve(value);
						};
						component = factory({ requestRender: () => {}, terminal: { rows: 40 } }, theme, {}, done);
						if (options?.overlay) {
							const key = keys.shift();
							assert.ok(key, "the overlay opened more often than the test expected");
							setImmediate(() => component?.handleInput?.(key));
						}
					}),
			},
		} as unknown as ExtensionContext;
	}

	const fresh = (): Seen => ({ notes: [], confirmTitles: [] });

	it("RPC: stages all after confirmation and commits the suggested message", async () => {
		writeFileSync(join(repo, "a.txt"), "a\nb\n");
		writeFileSync(join(repo, "docs.md"), "# docs\n");
		const seen = fresh();
		await runCommit(ctx("rpc", { confirm: [true], editor: ["<keep>"], select: ["Commit"] }, seen), {
			complete: reply("```\nfeat(a): append b and add docs\n```"),
		});
		assert.equal(sh(repo, "log", "-1", "--format=%s").trim(), "feat(a): append b and add docs");
		assert.equal(sh(repo, "status", "--porcelain").trim(), "");
		assert.match(seen.notes.at(-1) ?? "", /Committed on main: \w+ feat\(a\): append b and add docs/);
	});

	it("RPC: commit and push asks first and pushes after a yes", async () => {
		writeFileSync(join(repo, "a.txt"), "c\n");
		sh(repo, "add", "a.txt");
		const seen = fresh();
		await runCommit(ctx("rpc", { confirm: [true], editor: ["fix(a): set c"], select: ["Commit and push"] }, seen), {
			complete: reply("fix(a): change a"),
		});
		assert.deepEqual(seen.confirmTitles, ["Are you sure you want to commit and push?"]);
		assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), "fix(a): set c");
		assert.match(seen.notes.at(-1) ?? "", /Committed and pushed to origin\/main \(new upstream\)/);
	});

	it("TUI: e edits, a declined p stays in the view, and c commits without a push", async () => {
		writeFileSync(join(repo, "a.txt"), "d\n");
		sh(repo, "add", "a.txt");
		const before = sh(repo, "rev-parse", "HEAD").trim();
		const seen = fresh();
		await runCommit(ctx("tui", { keys: ["e", "p", "c"], editor: ["docs(a): edited"], confirm: [false] }, seen), {
			complete: reply("chore(a): suggested"),
		});
		assert.deepEqual(seen.confirmTitles, ["Are you sure you want to commit and push?"]);
		assert.equal(sh(repo, "log", "-1", "--format=%s").trim(), "docs(a): edited");
		assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), before,
			"the declined push did not push");
	});

	it("TUI: p pushes after a yes, and esc cancels without a commit", async () => {
		writeFileSync(join(repo, "a.txt"), "e\n");
		sh(repo, "add", "a.txt");
		let seen = fresh();
		await runCommit(ctx("tui", { keys: ["p"], confirm: [true] }, seen), { complete: reply("feat(a): push e") });
		assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), "feat(a): push e");
		assert.match(seen.notes.at(-1) ?? "", /Committed and pushed to origin\/main: /);

		writeFileSync(join(repo, "a.txt"), "f\n");
		sh(repo, "add", "a.txt");
		seen = fresh();
		await runCommit(ctx("tui", { keys: ["\u001b"] }, seen), { complete: reply("feat(a): never") });
		assert.equal(sh(repo, "log", "-1", "--format=%s").trim(), "feat(a): push e");
		assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "a.txt");
		sh(repo, "reset", "-q");
		sh(repo, "checkout", "--", "a.txt");
	});

	it("does nothing when staging is declined or the tree is clean", async () => {
		const seen = fresh();
		await runCommit(ctx("rpc", {}, seen), { complete: reply("x") });
		assert.match(seen.notes.at(-1) ?? "", /nothing to commit/);

		writeFileSync(join(repo, "a.txt"), "changed\n");
		await runCommit(ctx("rpc", { confirm: [false] }, seen), { complete: reply("x") });
		assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
		sh(repo, "checkout", "--", "a.txt");
	});
});

describe("suggestMessage", () => {
	let repo: string;
	const saved = { ...process.env };

	before(() => {
		Object.assign(process.env, GIT_ENV);
		repo = mkdtempSync(join(tmpdir(), "aio-commit-suggest-"));
		sh(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "a\n");
		sh(repo, "add", "-A");
	});

	after(() => {
		rmSync(repo, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	});

	const input = (complete: MessageCompleteFn) => ({
		git: createGitRunner(repo),
		files: [{ path: "a.txt", status: "A" as const }],
		model: {},
		complete,
		signal: new AbortController().signal,
	});

	it("sends the instructions in the user message", async () => {
		let sent = "";
		const result = await suggestMessage(input(async (_model, context) => {
			sent = context.messages[0]!.content;
			return { content: [{ type: "text", text: "feat(a): add a" }], stopReason: "stop" };
		}));
		assert.equal(result.message, "feat(a): add a");
		assert.equal(result.notice, undefined);
		assert.ok(sent.startsWith(MESSAGE_INSTRUCTIONS));
		assert.match(sent, /A a\.txt/);
	});

	it("falls back to the template with a notice", async () => {
		const failed = await suggestMessage(input(async () => ({ content: [], stopReason: "error", errorMessage: "rate limited" })));
		assert.deepEqual(failed, { message: FALLBACK_MESSAGE, notice: "Suggestion failed: rate limited" });

		const length = await suggestMessage(input(async () => ({ content: [{ type: "thinking", thinking: "…" }], stopReason: "length" })));
		assert.match(length.notice ?? "", /whole output budget/);

		const empty = await suggestMessage(input(async () => ({ content: [{ type: "text", text: "  " }], stopReason: "stop" })));
		assert.match(empty.notice ?? "", /did not contain a commit message/);

		const thrown = await suggestMessage(input(async () => { throw new Error("offline"); }));
		assert.equal(thrown.notice, "Suggestion failed: offline");

		const none = await suggestMessage({ ...input(reply("x")), model: undefined });
		assert.match(none.notice ?? "", /No model is active/);
	});
});
