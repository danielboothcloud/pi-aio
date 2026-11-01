import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_SESSION_VERSION, SessionManager, parseArgs } from "@earendil-works/pi-coding-agent";
import { continuedRecipeForLaunch } from "./continue.js";
import { RECIPE_ORIGIN_ENV, RECIPE_STATE_ENTRY, RECIPE_STAGE_ENV, parseRecipeConfig } from "./config.js";
import { decideRelaunch } from "./trampoline.js";

const root = mkdtempSync(join(process.cwd(), "test/.recipe-continue-"));
const cwd = join(root, "project");
const agent = join(root, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agent, { recursive: true });
const savedAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
test.after(() => {
	if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgent;
	rmSync(root, { recursive: true, force: true });
});

function sessionFile(dir?: string, name: string | null = "work"): string {
	const file = SessionManager.create(cwd, dir).getSessionFile()!;
	const timestamp = new Date().toISOString();
	writeFileSync(file, [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: "session-test", timestamp, cwd },
		{ type: "custom", id: "recipe", parentId: null, timestamp, customType: RECIPE_STATE_ENTRY, data: { name } },
		// This later recipe is abandoned: the active leaf points around it.
		{ type: "custom", id: "abandoned", parentId: "recipe", timestamp, customType: RECIPE_STATE_ENTRY, data: { name: "home" } },
		{ type: "message", id: "leaf", parentId: "recipe", timestamp, message: { role: "user", content: "hello", timestamp: Date.now() } },
	].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

function continued(args: string[] = ["--continue"], env: Record<string, string | undefined> = {}) {
	return continuedRecipeForLaunch({ argv: ["pi", "/$bunfs/root/pi", ...args], env, cwd });
}

test("--continue restores the branch's own recipe, never an abandoned branch or directory default", () => {
	const file = sessionFile();
	const selected = continued();
	assert.deepEqual(selected, { name: "work", file });
	for (const flag of ["--continue", "-c"]) {
		const work = parseRecipeConfig("work", "directory", cwd, { models: ["provider/one"] })!;
		const home = parseRecipeConfig("home", "directory", cwd, { models: ["provider/two"] })!;
		const decision = decideRelaunch({
			argv: ["pi", "/$bunfs/root/pi", flag, "--", "--continue"], command: "pi", env: {},
			recipes: { work, home }, directoryRecipe: "home", continuedRecipe: selected,
		});
		assert.ok(decision.action === "relaunch");
		assert.equal(decision.spec.origin, "session");
		assert.equal(decision.spec.env[RECIPE_ORIGIN_ENV], "session");
		const parsed = parseArgs(decision.spec.args);
		assert.deepEqual(parsed.models, ["provider/one"]);
		assert.equal(parsed.session, file, "pin the exact file we inspected");
		assert.equal(parsed.continue, undefined);
		assert.deepEqual(parsed.messages, ["--continue"], "literal prompt flags survive");
		const override = decideRelaunch({
			argv: ["pi", "/$bunfs/root/pi", flag, "--models", "provider/override"], command: "pi", env: {},
			recipes: { work }, continuedRecipe: selected,
		});
		assert.equal(override.action, "session-apply", "explicit --models still wins");
	}
});

test("continue relaunch preserves flag-shaped option values and literal prompt flags", () => {
	const work = parseRecipeConfig("work", "directory", cwd, { models: ["provider/one"] })!;
	for (const value of ["-c", "--continue", "--"]) {
		const decision = decideRelaunch({
			argv: ["pi", "/$bunfs/root/pi", "--append-system-prompt", value, "-c", "--continue", "--", "-c"],
			command: "pi", env: {}, recipes: { work }, continuedRecipe: { name: "work", file: "/saved.jsonl" },
		});
		assert.ok(decision.action === "relaunch");
		const parsed = parseArgs(decision.spec.args);
		assert.deepEqual(parsed.appendSystemPrompt, [value]);
		assert.equal(parsed.continue, undefined);
		assert.equal(parsed.session, "/saved.jsonl");
		assert.deepEqual(parsed.messages, ["-c"]);
	}
});

test("continued recipe off is not replaced with the directory default", () => {
	const dir = join(root, "off");
	sessionFile(dir, null);
	assert.equal(continued(["--continue", "--session-dir", dir]), undefined);
});

test("continue honors CLI > env > settings session directories", () => {
	const cliDir = join(root, "cli");
	const envDir = join(root, "env");
	const settingDir = join(root, "setting");
	const cliFile = sessionFile(cliDir, "cli");
	const envFile = sessionFile(envDir, "env");
	const settingFile = sessionFile(settingDir, "setting");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessionDir: settingDir }));
	assert.equal(continued(["-c", "--session-dir", cliDir], { PI_CODING_AGENT_SESSION_DIR: envDir })?.file, cliFile);
	assert.equal(continued(["-c"], { PI_CODING_AGENT_SESSION_DIR: envDir })?.file, envFile);
	assert.equal(continued()?.file, settingFile);
});

test("non-continue launches, explicit recipes, sessionless commands, children and stages do not inspect sessions", () => {
	for (const args of [[], ["--resume"], ["--session", "x"], ["--continue", "--recipe", "work"],
		["--continue", "--recipe"], ["--continue", "--no-session"], ["--continue", "--help"],
		["--continue", "--list-models"], ["list", "--continue"], ["--", "--continue"]]) {
		assert.equal(continued(args), undefined, args.join(" "));
	}
	assert.equal(continued(["-c"], { [RECIPE_STAGE_ENV]: "1" }), undefined);
	assert.equal(continued(["-c"], { AIO_SUBAGENT_CHILD: "1" }), undefined);
	assert.equal(continued(["-c", "--session-dir", join(root, "empty")]), undefined);
});
