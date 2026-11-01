import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_SESSION_VERSION, SessionManager, parseArgs } from "@earendil-works/pi-coding-agent";
import { resumedRecipeForLaunch } from "./continue.js";
import { RECIPE_INJECTED_ARGS_ENV, RECIPE_STAGE_ENV, RECIPE_STATE_ENTRY, parseRecipeConfig } from "./config.js";
import { argvForSessionSwitch, relaunchFromSession, selectedSessionRelaunch } from "./resume.js";
import { decideRelaunch, pinSessionInvocation } from "./trampoline.js";

const root = mkdtempSync(join(process.cwd(), "test/.recipe-resume-"));
const cwd = join(root, "project");
const agent = join(root, "agent");
const sessions = join(root, "sessions");
for (const dir of [cwd, agent, sessions]) mkdirSync(dir, { recursive: true });
const saved = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
test.after(() => {
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

function session(name: string | null = "work", id = "resume-123", directory = cwd) {
	const file = SessionManager.create(directory, sessions).getSessionFile()!;
	const timestamp = new Date().toISOString();
	writeFileSync(file, [
		{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: directory },
		{ type: "custom", id: "recipe", parentId: null, timestamp, customType: RECIPE_STATE_ENTRY, data: { name } },
		{ type: "message", id: "leaf", parentId: "recipe", timestamp, message: { role: "user", content: "hello", timestamp: Date.now() } },
	].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

function resumed(args: string[]) {
	return resumedRecipeForLaunch({ argv: ["pi", "/$bunfs/root/pi", ...args, "--session-dir", sessions], env: {}, cwd });
}

test("--session restores the same recipe by path, exact ID and local partial ID; --session-id too", async () => {
	const file = session();
	for (const args of [["--session", file], ["--session", "resume-123"], ["--session", "resume-1"], ["--session-id", "resume-123"]]) {
		const selected = await resumed(args);
		assert.deepEqual(selected, { name: "work", file, cwd });
		const work = parseRecipeConfig("work", "directory", cwd, { models: ["fixture/one"], extensions: ["/work.ts"] })!;
		const decision = decideRelaunch({
			argv: ["pi", "/$bunfs/root/pi", ...args], command: "pi", env: {}, recipes: { work }, continuedRecipe: selected,
		});
		assert.ok(decision.action === "relaunch");
		const parsed = parseArgs(decision.spec.args);
		assert.equal(parsed.session, file);
		assert.equal(parsed.sessionId, undefined);
		assert.deepEqual(parsed.models, ["fixture/one"]);
		assert.ok(parsed.extensions?.includes("/work.ts"));
	}
});

test("a path session uses its own cwd's recipe configuration", async () => {
	const other = join(root, "other-project");
	mkdirSync(other);
	const file = session("other", "other-project-session", other);
	assert.deepEqual(await resumed(["--session", file]), { name: "other", file, cwd: other });
});

test("off, missing references, fresh IDs and the native --resume picker are not guessed", async () => {
	const file = session(null, "off-session");
	assert.equal(await resumed(["--session", file]), undefined);
	assert.equal(await resumed(["--session", "missing-session"]), undefined);
	assert.equal(await resumed(["--session-id", "new-session"]), undefined);
	assert.equal(await resumed(["--resume"]), undefined);
});

test("the native CLI picker restores its committed session without reopening the picker", () => {
	const def = parseRecipeConfig("work", "directory", cwd, { models: ["fixture/one"], extensions: ["/work.ts"] })!;
	const decision = selectedSessionRelaunch({
		argv: ["pi", "/$bunfs/root/pi", "--resume", "initial prompt"], command: "pi", env: {},
		reason: "startup", file: "/chosen.jsonl", def,
	});
	assert.ok(decision?.action === "relaunch");
	const parsed = parseArgs(decision.spec.args);
	assert.equal(parsed.session, "/chosen.jsonl");
	assert.equal(parsed.resume, undefined);
	assert.deepEqual(parsed.messages, ["initial prompt"], "a not-yet-run initial prompt is retained");
	assert.deepEqual(parsed.models, ["fixture/one"]);
	assert.ok(parsed.extensions?.includes("/work.ts"));
});

test("TUI /resume removes the previous recipe injection and old prompts, not explicit flags", () => {
	const def = parseRecipeConfig("next", "global", cwd, { models: ["fixture/two"], extensions: ["/next.ts"] })!;
	const argv = ["pi", "/$bunfs/root/pi", "-ne", "-e", "/aio.ts", "-e", "/old.ts", "--models", "fixture/one", "--offline", "@old-file", "old prompt"];
	const env = { [RECIPE_STAGE_ENV]: "1", [RECIPE_INJECTED_ARGS_ENV]: "7" };
	assert.deepEqual(argvForSessionSwitch(argv, env).slice(2), ["--offline"]);
	const decision = selectedSessionRelaunch({ argv, command: "pi", env, reason: "resume", file: "/next.jsonl", def });
	assert.ok(decision?.action === "relaunch");
	const parsed = parseArgs(decision.spec.args);
	assert.deepEqual(parsed.models, ["fixture/two"]);
	assert.ok(parsed.extensions?.includes("/next.ts"));
	assert.ok(!parsed.extensions?.includes("/old.ts"));
	assert.deepEqual(parsed.messages, []);
	assert.deepEqual(parsed.fileArgs, []);
	assert.equal(parsed.offline, true);
	const overridden = selectedSessionRelaunch({
		argv: ["pi", "/$bunfs/root/pi", "--models", "fixture/user", "-e", "/user.ts"], command: "pi", env: {},
		reason: "resume", file: "/next.jsonl", def,
	});
	assert.equal(overridden?.action, "session-apply");
	assert.equal(selectedSessionRelaunch({ argv, command: "pi", env, reason: "reload", file: "/next.jsonl", def }), undefined);
	assert.deepEqual(selectedSessionRelaunch({ argv: [...argv, "--session", "/next.jsonl"], command: "pi", env, reason: "startup", file: "/next.jsonl", def }), { action: "none", reason: "stage" });
});

test("switching to off or an unscoped recipe clears the previous recipe's launch injection", () => {
	const argv = ["pi", "/$bunfs/root/pi", "-ne", "-e", "/aio.ts", "-e", "/old.ts", "--models", "fixture/one", "--offline"];
	const env = { [RECIPE_STAGE_ENV]: "1", [RECIPE_INJECTED_ARGS_ENV]: "7" };
	const unscoped = parseRecipeConfig("unscoped", "global", cwd, { model: "fixture/two" })!;
	for (const def of [undefined, unscoped]) {
		const decision = selectedSessionRelaunch({ argv, command: "pi", env, reason: "resume", file: "/next.jsonl", def });
		assert.ok(decision?.action === "relaunch");
		const parsed = parseArgs(decision.spec.args);
		assert.equal(parsed.session, "/next.jsonl");
		assert.equal(parsed.noExtensions, undefined);
		assert.equal(parsed.models, undefined);
		assert.deepEqual(parsed.extensions ?? [], []);
		assert.equal(parsed.offline, true);
		assert.equal(decision.spec.env[RECIPE_INJECTED_ARGS_ENV], "0");
	}
});

test("switching removes obsolete fork/no-session/name flags, preserving their literal option values", () => {
	for (const args of [["--fork", "/old.jsonl"], ["--no-session"], ["--name", "old name"], ["-n", "old name"]]) {
		const result = parseArgs(argvForSessionSwitch(["pi", "/$bunfs/root/pi", ...args, "--offline"], {}).slice(2));
		assert.equal(result.fork, undefined);
		assert.equal(result.noSession, undefined);
		assert.equal(result.name, undefined);
		assert.equal(result.offline, true);
	}
	for (const value of ["--fork", "--no-session", "--name", "-n"]) {
		const result = parseArgs(argvForSessionSwitch(["pi", "/$bunfs/root/pi", "--append-system-prompt", value], {}).slice(2));
		assert.deepEqual(result.appendSystemPrompt, [value]);
	}
});

test("resume keeps recipe-shaped option values and resolves injected relative extensions at the recipe file", () => {
	for (const value of ["--recipe", "--recipe=literal"]) {
		const argv = argvForSessionSwitch(["pi", "/$bunfs/root/pi", "--append-system-prompt", value, "--offline"], {});
		assert.deepEqual(parseArgs(argv.slice(2)).appendSystemPrompt, [value]);
		assert.equal(parseArgs(argv.slice(2)).offline, true);
	}
	const def = parseRecipeConfig("other", "directory", "/project-B", { extensions: ["./provider.ts"] })!;
	const decision = selectedSessionRelaunch({
		argv: ["pi", "/$bunfs/root/pi", "--session", "/chosen.jsonl"], command: "pi", env: {},
		reason: "startup", file: "/chosen.jsonl", def,
	});
	assert.ok(decision?.action === "relaunch");
	assert.ok(parseArgs(decision.spec.args).extensions?.includes("/project-B/provider.ts"));
});

test("terminal relaunch stops the TUI and restores it on failure", async () => {
	const calls: string[] = [];
	const ctx = { mode: "tui", ui: { custom: async (factory: Function) => {
		let result: boolean | undefined;
		await factory({ stop: () => calls.push("stop"), start: () => calls.push("start"), requestRender: () => calls.push("render") }, {}, {}, (value: boolean) => { result = value; });
		return result;
	} } };
	const spec = { command: "pi", args: [], env: {}, recipeName: "work", reasons: ["model scope"] };
	assert.equal(await relaunchFromSession(ctx as never, spec, async () => { calls.push("spawn"); return false; }), false);
	assert.deepEqual(calls, ["stop", "spawn", "start", "render"]);
	calls.length = 0;
	await assert.rejects(relaunchFromSession(ctx as never, spec, async () => { throw new Error("spawn failed"); }), /spawn failed/);
	assert.deepEqual(calls, ["stop", "start", "render"]);
});

test("pinning any resume selection preserves flag-shaped option values and prompt literals", () => {
	for (const args of [["--resume"], ["-r"], ["--continue"], ["--session", "old"], ["--session-id", "old"]]) {
		for (const value of ["--session", "--session-id", "--resume", "-r", "--"]) {
			const pinned = pinSessionInvocation(["--append-system-prompt", value, ...args, "--", "--session", "literal"], "/chosen.jsonl");
			const parsed = parseArgs(pinned);
			assert.equal(parsed.session, "/chosen.jsonl");
			assert.equal(parsed.sessionId, undefined);
			assert.equal(parsed.resume, undefined);
			assert.equal(parsed.continue, undefined);
			assert.deepEqual(parsed.appendSystemPrompt, [value]);
			assert.deepEqual(parsed.messages, ["--session", "literal"]);
		}
	}
});
