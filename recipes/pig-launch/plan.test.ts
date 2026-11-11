import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager as PiSessionManager, parseArgs } from "@earendil-works/pi-coding-agent";
import { RECIPES_FILE_ENV, RECIPE_STATE_ENTRY } from "../config.ts";
import { RECIPE_TRUST_FILE_ENV, recordRecipeFileTrust, type TrustChoice } from "../trust.ts";
import { PIG_LAUNCHER_ENV, PIG_TRUST_ASKED_ENV, aliasPigletToRecipe, execEnvArgs, planPigLaunch, type PigLaunchOptions } from "./plan.ts";
import { SessionManager, pigAgentDir, pigSessionDirEnv } from "./pi-shim.ts";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = mkdtempSync(join(repo, "test/.pig-launch-"));
const project = join(root, "project");
const agent = join(root, "agent");
const sessions = join(root, "sessions");
const globalRecipes = join(root, "aio-recipes.json");
const trustFile = join(root, "trust.json");
for (const dir of [project, agent, sessions]) mkdirSync(dir, { recursive: true });

const savedEnv = { recipes: process.env[RECIPES_FILE_ENV], trust: process.env[RECIPE_TRUST_FILE_ENV] };
process.env[RECIPES_FILE_ENV] = globalRecipes;
process.env[RECIPE_TRUST_FILE_ENV] = trustFile;
test.after(() => {
	for (const [key, value] of [[RECIPES_FILE_ENV, savedEnv.recipes], [RECIPE_TRUST_FILE_ENV, savedEnv.trust]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

writeFileSync(globalRecipes, JSON.stringify({
	recipes: {
		work: { models: ["anthropic/*"], extensions: ["/opt/work.ts"] },
		light: { model: "anthropic/claude-5" },
	},
}));

const directoryRecipe = join(project, ".pi-recipe");
function writeDirectoryRecipe(trusted: boolean | undefined): void {
	writeFileSync(directoryRecipe, JSON.stringify({
		defaultRecipe: "repo",
		recipes: { repo: { models: ["openai-codex/*"], extensions: ["npm:repo-ext"] } },
	}));
	rmSync(trustFile, { force: true });
	if (trusted !== undefined) recordRecipeFileTrust(directoryRecipe, trusted);
}

/** A clean, PiG-default-mode environment: no inherited AIO/agent markers. */
const ENV = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	PIG_CODING_AGENT_DIR: agent,
	PIG_CODING_AGENT_SESSION_DIR: sessions,
};

function options(args: string[], overrides: Partial<PigLaunchOptions> = {}): PigLaunchOptions {
	return {
		args,
		env: { ...ENV },
		cwd: project,
		pigBinary: "/bin/pig",
		stdinIsTTY: false,
		stdoutIsTTY: false,
		promptTrust: async () => assert.fail("unexpected trust prompt"),
		aioExtensionPath: "/aio/index.ts",
		...overrides,
	};
}

test("a trusted .pi-recipe default starts pig once with Pi's relaunch arguments", async () => {
	writeDirectoryRecipe(true);
	const launch = await planPigLaunch(options(["-p", "hi"]));
	assert.equal(launch.command, "/bin/pig");
	assert.equal(launch.recipeName, "repo");
	assert.deepEqual(launch.args, [
		"-ne", "-e", "/aio/index.ts",
		"-e", "builtin:mcp", "-e", "builtin:codemode", "-e", "builtin:tool-search",
		"-e", "npm:repo-ext", "--models", "openai-codex/*",
		"-p", "hi",
	]);
	assert.equal(launch.env.AIO_RECIPE_STAGE, "1");
	assert.equal(launch.env.AIO_RECIPE_ACTIVE, "repo");
	assert.equal(launch.env.AIO_RECIPE_ORIGIN, "directory");
	assert.equal(launch.env[PIG_LAUNCHER_ENV], "1");
});

test("--recipe beats the default and is stripped; session-only recipes pass through", async () => {
	writeDirectoryRecipe(true);
	const work = await planPigLaunch(options(["--recipe", "work", "msg"]));
	assert.equal(work.recipeName, "work");
	assert.equal(work.args.includes("--recipe"), false);
	assert.deepEqual(parseArgs(work.args).models, ["anthropic/*"]);
	assert.deepEqual(parseArgs(work.args).messages, ["msg"]);

	const light = await planPigLaunch(options(["--recipe", "light"]));
	assert.equal(light.recipeName, undefined);
	assert.deepEqual(light.args, ["--recipe", "light"], "AIO in pig applies it in-session");
	assert.equal(light.env[PIG_LAUNCHER_ENV], "1");
	assert.equal(light.env.AIO_RECIPE_STAGE, undefined);
});

test("--piglet is an alias for --recipe only when that recipe exists", async () => {
	writeDirectoryRecipe(true);
	const recipes = { work: {} } as never;
	assert.deepEqual(aliasPigletToRecipe(["--piglet", "work", "x"], recipes), ["--recipe", "work", "x"]);
	assert.deepEqual(aliasPigletToRecipe(["--piglet=work"], recipes), ["--recipe=work"]);
	assert.equal(aliasPigletToRecipe(["--piglet", "other"], recipes), undefined);
	assert.equal(aliasPigletToRecipe(["--piglet", "./work.yaml"], recipes), undefined);
	assert.equal(aliasPigletToRecipe(["--", "--piglet", "work"], recipes), undefined);

	const aliased = await planPigLaunch(options(["--piglet", "work"]));
	assert.equal(aliased.recipeName, "work");
	assert.equal(aliased.env.AIO_RECIPE_ORIGIN, "flag");
	const native = await planPigLaunch(options(["--piglet", "research"]));
	assert.deepEqual(native.args.slice(-2), ["--piglet", "research"], "a real Piglet passes through");
});

test("pig subcommands and staged launches pass through untouched", async () => {
	writeDirectoryRecipe(true);
	const status = await planPigLaunch(options(["status", "--json"]));
	assert.deepEqual(status.args, ["status", "--json"]);
	assert.equal(status.env[PIG_LAUNCHER_ENV], undefined);
	const staged = await planPigLaunch(options([], { env: { ...ENV, AIO_RECIPE_STAGE: "1" } }));
	assert.deepEqual(staged.args, []);
	const child = await planPigLaunch(options(["-p", "x"], { env: { ...ENV, AIO_SUBAGENT_CHILD: "1" } }));
	assert.deepEqual(child.args, ["-p", "x"]);
	const picker = await planPigLaunch(options(["--resume"]));
	assert.deepEqual(picker.args, ["--resume"], "pig's own picker; AIO inside pig handles the choice");
});

test("an untrusted .pi-recipe asks once on an interactive terminal", async () => {
	for (const [choice, relaunched] of [["trust", true], ["skip", false], ["deny", false]] as const) {
		writeDirectoryRecipe(undefined);
		const asked: string[] = [];
		const launch = await planPigLaunch(options([], {
			stdinIsTTY: true,
			stdoutIsTTY: true,
			promptTrust: async (file): Promise<TrustChoice> => {
				asked.push(file);
				return choice;
			},
		}));
		assert.deepEqual(asked, [directoryRecipe], choice);
		assert.equal(launch.recipeName !== undefined, relaunched, choice);
		assert.equal(launch.env[PIG_TRUST_ASKED_ENV], "1", choice);
	}
	writeDirectoryRecipe(undefined);
	const quiet = await planPigLaunch(options(["-p", "x"], { stdinIsTTY: true, stdoutIsTTY: true }));
	assert.equal(quiet.recipeName, undefined, "print mode never asks and never applies an untrusted file");
});

function writeSession(name: string, id: string, entries: object[], mtime: number): string {
	const file = join(sessions, `${name}.jsonl`);
	const timestamp = new Date(mtime).toISOString();
	const lines = [{ type: "session", version: 3, id, timestamp, cwd: project }, ...entries];
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	utimesSync(file, mtime / 1000, mtime / 1000);
	return file;
}

const recipeEntry = (id: string, parentId: string | null, name: string | null) => ({
	type: "custom", id, parentId, timestamp: new Date().toISOString(), customType: RECIPE_STATE_ENTRY, data: { name },
});
const message = (id: string, parentId: string | null) => ({
	type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "hi", timestamp: 1 },
});

test("--continue restores the newest session's recipe and pins its file", async () => {
	writeDirectoryRecipe(true);
	writeSession("old", "old-1", [recipeEntry("r", null, "light")], 1_000_000);
	const file = writeSession("new", "new-1", [recipeEntry("r", null, "work"), message("m", "r")], 2_000_000);
	const launch = await planPigLaunch(options(["-c"]));
	assert.equal(launch.recipeName, "work");
	assert.equal(launch.env.AIO_RECIPE_ORIGIN, "session");
	const parsed = parseArgs(launch.args);
	assert.equal(parsed.session, file);
	assert.equal(parsed.continue, undefined);
	assert.deepEqual(parsed.models, ["anthropic/*"]);
});

test("the launcher shim finds and reads sessions like Pi's SessionManager", () => {
	const a = writeSession("branchy", "branch-1", [
		recipeEntry("r1", null, "work"),
		message("m1", "r1"),
		recipeEntry("r2", "m1", "light"),
		message("m2", "r1"),
	], 3_000_000);
	for (const dir of [sessions, undefined]) {
		const shim = dir ? SessionManager.continueRecent(project, dir) : undefined;
		const pi = dir ? PiSessionManager.continueRecent(project, dir) : undefined;
		if (shim && pi) assert.equal(shim.getSessionFile(), pi.getSessionFile());
	}
	assert.equal(SessionManager.findById(project, "branch-1", sessions), PiSessionManager.findById(project, "branch-1", sessions));
	assert.equal(SessionManager.findById(project, "missing", sessions), undefined);
	const shimBranch = SessionManager.open(a, sessions).getBranch().map((entry) => entry.id);
	const piBranch = PiSessionManager.open(a, sessions).getBranch().map((entry) => entry.id);
	assert.deepEqual(shimBranch, piBranch);
	assert.deepEqual(shimBranch, ["r1", "m2"], "the leaf is the last entry; its sibling branch is ignored");
	assert.equal(SessionManager.open(a, sessions).getCwd(), project);
});

test("PiG directory rules", () => {
	const home = process.env.HOME ?? "";
	assert.equal(pigAgentDir({}), join(home, ".pig", "agent"));
	assert.equal(pigAgentDir({ XDG_CONFIG_HOME: "/x" }), "/x/pig/agent");
	assert.equal(pigAgentDir({ PIG_HOME: "/p", XDG_CONFIG_HOME: "/x" }), "/p/agent");
	assert.equal(pigAgentDir({ PIG_HOME: "/p", PIG_CODING_AGENT_DIR: "/a" }), "/a");
	assert.equal(pigAgentDir({ PIG_HOME: " " }), join(home, ".pig", "agent"));
	assert.equal(pigAgentDir({ PIG_USE_PI_DIRS: "1", PIG_CODING_AGENT_DIR: "/a" }), join(home, ".pi", "agent"));
	assert.equal(pigAgentDir({ PIG_USE_PI_DIRS: "1", PI_CODING_AGENT_DIR: "~/pi" }), join(home, "pi"));
	assert.equal(pigSessionDirEnv({ PIG_CODING_AGENT_SESSION_DIR: "/s", PI_CODING_AGENT_SESSION_DIR: "/t" }), "/s");
	assert.equal(pigSessionDirEnv({ PIG_USE_PI_DIRS: "1", PIG_CODING_AGENT_SESSION_DIR: "/s", PI_CODING_AGENT_SESSION_DIR: "/t" }), "/t");
});

function runLauncher(args: string[], extraEnv: Record<string, string> = {}) {
	return spawnSync(process.execPath, [join(repo, "bin", "aio-pig.mjs"), ...args], {
		cwd: project,
		encoding: "utf8",
		env: { ...ENV, [RECIPES_FILE_ENV]: globalRecipes, [RECIPE_TRUST_FILE_ENV]: trustFile, ...extraEnv } as NodeJS.ProcessEnv,
		timeout: 60_000,
	});
}

test("bin/aio-pig.mjs plans through the shim (no Pi package) and passes the exit status through", () => {
	writeDirectoryRecipe(true);
	const dry = runLauncher(["-p", "hi"], { AIO_PIG_DRY_RUN: "1" });
	assert.equal(dry.status, 0, dry.stderr);
	assert.equal(dry.stderr, "", "planning succeeded without falling back");
	const plan = JSON.parse(dry.stdout) as { command: string; args: string[]; env: Record<string, string> };
	assert.equal(plan.command, "pig");
	assert.deepEqual(plan.args.slice(0, 3), ["-ne", "-e", join(repo, "index.ts")]);
	assert.deepEqual(parseArgs(plan.args).models, ["openai-codex/*"]);
	assert.equal(plan.env.AIO_RECIPE_ACTIVE, "repo");
	assert.equal(plan.env[PIG_LAUNCHER_ENV], "1");

	assert.equal(runLauncher(["status"], { AIO_PIG_BINARY: "true" }).status, 0);
	assert.equal(runLauncher(["status"], { AIO_PIG_BINARY: "false" }).status, 1);
	const echoed = runLauncher(["status", "--json"], { AIO_PIG_BINARY: "echo" });
	assert.equal(echoed.stdout.trim(), "status --json");
	const missing = runLauncher(["status"], { AIO_PIG_BINARY: join(root, "no-such-pig") });
	assert.equal(missing.status, 127);
	assert.match(missing.stderr, /could not start/);
});

test("execEnvArgs sets added/changed variables, unsets removed ones, and keeps args intact", () => {
	const launch = {
		command: "/bin/pig",
		args: ["-p", "two words", "", "line\nbreak"],
		env: { KEEP: "1", CHANGED: "new", ADDED: "x=y" },
	};
	assert.deepEqual(
		execEnvArgs({ KEEP: "1", CHANGED: "old", GONE: "z" }, launch),
		["-u", "GONE", "CHANGED=new", "ADDED=x=y", "/bin/pig", "-p", "two words", "", "line\nbreak"],
	);
	assert.deepEqual(execEnvArgs({ A: "1" }, { command: "pig", args: ["status"], env: { A: "1" } }), ["pig", "status"]);
});

test("--aio-print-exec prints a NUL-separated env plan and keeps the trust question on the terminal state given", () => {
	writeDirectoryRecipe(true);
	const out = runLauncher(["--aio-print-exec=pipe", "-p", "a b"]);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.endsWith("\0"));
	const words = out.stdout.slice(0, -1).split("\0");
	assert.ok(words.includes("AIO_RECIPE_ACTIVE=repo"));
	assert.ok(words.includes(`${PIG_LAUNCHER_ENV}=1`));
	const command = words.indexOf("pig");
	assert.ok(command > 0, "assignments come before the command");
	assert.deepEqual(parseArgs(words.slice(command + 1)).messages, ["a b"]);
	// A planning failure (here: a launcher copy without AIO next to it)
	// still prints plain pig with the same args.
	mkdirSync(join(root, "bin"), { recursive: true });
	copyFileSync(join(repo, "bin", "aio-pig.mjs"), join(root, "bin", "aio-pig.mjs"));
	const broken = spawnSync(process.execPath, [join(root, "bin", "aio-pig.mjs"), "--aio-print-exec=pipe", "x"], {
		cwd: project, encoding: "utf8", env: ENV as NodeJS.ProcessEnv, timeout: 60_000,
	});
	assert.equal(broken.status, 0);
	assert.match(broken.stderr, /starting pig unchanged/);
	assert.equal(broken.stdout, "pig\0x\0");
});

const fish = spawnSync("fish", ["--version"], { encoding: "utf8" }).status === 0;

test("bin/pig.fish runs pig through env with no launcher left alive", { skip: !fish && "fish not installed" }, () => {
	writeDirectoryRecipe(true);
	const fake = join(root, "fake-pig");
	writeFileSync(fake, [
		"#!/bin/sh",
		'printf "args=%s|" "$@"; echo',
		'echo "recipe=$AIO_RECIPE_ACTIVE launcher=$AIO_PIG_LAUNCHER"',
		'echo "parent=$(ps -o comm= -p $PPID)"',
		"exit 7",
	].join("\n"), { mode: 0o755 });
	const run = (env: Record<string, string>) => spawnSync("fish", ["--no-config", "-c", `source ${JSON.stringify(join(repo, "bin", "pig.fish"))}; pig --recipe work 'two words'`], {
		cwd: project,
		encoding: "utf8",
		env: { ...ENV, [RECIPES_FILE_ENV]: globalRecipes, [RECIPE_TRUST_FILE_ENV]: trustFile, AIO_PIG_BINARY: fake, ...env } as NodeJS.ProcessEnv,
		timeout: 60_000,
	});
	const launched = run({ AIO_PIG_LAUNCHER_PATH: join(repo, "bin", "aio-pig.mjs") });
	assert.equal(launched.status, 7, launched.stderr);
	assert.match(launched.stdout, /recipe=work launcher=1/);
	assert.match(launched.stdout, /args=--models\|args=anthropic\/\*\|args=two words\|/);
	assert.match(launched.stdout, /parent=\S*fish/, "env exec'd pig; no node launcher between fish and pig");
	// Without the launcher file, plain pig runs from PATH, args unchanged.
	const bin = join(root, "path-bin");
	mkdirSync(bin, { recursive: true });
	copyFileSync(fake, join(bin, "pig"));
	const plain = run({ AIO_PIG_LAUNCHER_PATH: join(root, "nope.mjs"), PATH: `${bin}:${process.env.PATH}` });
	assert.equal(plain.status, 7, plain.stderr);
	assert.match(plain.stdout, /^args=--recipe\|args=work\|args=two words\|\nrecipe= launcher=\n/);
});
