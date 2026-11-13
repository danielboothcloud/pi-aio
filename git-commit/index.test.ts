import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGitCommit, runGitCommit, suggestPlan, type PlanCompleteFn } from "./index.js";
import { createGitRunner } from "./git.js";

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

	it("registers the /git command and no agent tool", () => {
		delete process.env.AIO_SUBAGENT_CHILD;
		const { pi, commands, tools } = fakePi();
		registerGitCommit(pi);
		assert.deepEqual(commands, ["git"]);
		assert.deepEqual(tools, []);
	});

	it("registers nothing in subagent children", () => {
		process.env.AIO_SUBAGENT_CHILD = "1";
		const { pi, commands, tools } = fakePi();
		registerGitCommit(pi);
		assert.deepEqual(commands, []);
		assert.deepEqual(tools, []);
	});
});

function reply(text: string): PlanCompleteFn {
	return async () => ({ content: [{ type: "text", text }], stopReason: "stop" });
}

describe("/git flow (dialog fallback) in a scratch repository", () => {
	let repo: string;
	const saved = { ...process.env };

	before(() => {
		Object.assign(process.env, GIT_ENV);
		repo = mkdtempSync(join(tmpdir(), "aio-git-flow-"));
		sh(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "a\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "chore(repo): init");
	});

	after(() => {
		rmSync(repo, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	});

	function ctx(answers: { confirm: boolean[]; editor: Array<string | undefined> }, notes: string[]) {
		return {
			cwd: repo,
			hasUI: true,
			mode: "rpc",
			model: { provider: "test", id: "m" },
			modelRegistry: { complete: () => { throw new Error("unused"); } },
			ui: {
				confirm: async () => answers.confirm.shift() ?? false,
				editor: async (_title: string, prefill?: string) => {
					const next = answers.editor.shift();
					return next === "<keep>" ? prefill : next;
				},
				notify: (message: string) => notes.push(message),
			},
		} as unknown as ExtensionContext;
	}

	it("stages all after confirmation and makes the suggested grouped commits", async () => {
		writeFileSync(join(repo, "a.txt"), "a\nb\n");
		writeFileSync(join(repo, "docs.md"), "# docs\n");
		const notes: string[] = [];
		const complete = reply(JSON.stringify({
			commits: [
				{ message: "fix(a): append b", files: ["a.txt"] },
				{ message: "docs(readme): add docs", files: ["docs.md"] },
			],
		}));
		await runGitCommit(ctx({ confirm: [true, true], editor: ["<keep>", "docs(readme): add the docs page"] }, notes), { complete });
		assert.equal(sh(repo, "log", "-3", "--format=%s").trim(), "docs(readme): add the docs page\nfix(a): append b\nchore(repo): init");
		assert.equal(sh(repo, "status", "--porcelain").trim(), "");
		assert.match(notes.at(-1) ?? "", /Committed on main/);
	});

	it("does nothing when staging is declined or the tree is clean", async () => {
		const notes: string[] = [];
		await runGitCommit(ctx({ confirm: [], editor: [] }, notes), { complete: reply("{}") });
		assert.match(notes.at(-1) ?? "", /nothing to commit/);

		writeFileSync(join(repo, "a.txt"), "changed\n");
		await runGitCommit(ctx({ confirm: [false], editor: [] }, notes), { complete: reply("{}") });
		assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
		sh(repo, "checkout", "--", "a.txt");
	});

	it("falls back to one editable group when the suggestion fails", async () => {
		writeFileSync(join(repo, "a.txt"), "x\n");
		sh(repo, "add", "a.txt");
		const result = await suggestPlan({
			git: createGitRunner(repo),
			files: [{ path: "a.txt", status: "M" }],
			model: {},
			complete: async () => ({ content: [], stopReason: "error", errorMessage: "rate limited" }),
			signal: new AbortController().signal,
		});
		assert.equal(result.groups.length, 1);
		assert.match(result.notice ?? "", /Suggestion failed: rate limited/);
		sh(repo, "reset", "-q");
		sh(repo, "checkout", "--", "a.txt");
	});
});
