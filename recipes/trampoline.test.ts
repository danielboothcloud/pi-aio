import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import {
	AIO_RECIPE_EXTENSION_PATH,
	decideRelaunch,
	cliArgsFromArgv,
	execRelaunch,
	relaunchNotice,
	stripRecipeInvocation,
	type RelaunchSpec,
	type TrampolineDecision,
	type TrampolineOptions,
} from "./trampoline.ts";
import {
	ACTIVE_RECIPE_ENV,
	RECIPE_STAGE_ENV,
	RECIPES_FILE_ENV,
	parseRecipeConfig,
	type RecipeDefinition,
} from "./config.ts";

// The bridge sees only global recipes (project trust is not resolved at
// factory time), so the test recipe universe is built directly instead of
// loading config files.
const tmp = mkdtempSync(join(tmpdir(), "aio-recipes-trampoline-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env[RECIPES_FILE_ENV] = join(tmp, "agent", "aio-recipes.json");

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env[RECIPES_FILE_ENV];
});

function recipe(name: string, raw: Record<string, unknown>): RecipeDefinition {
	const parsed = parseRecipeConfig(name, "global", "/base", raw);
	assert.ok(parsed, `recipe ${name} parses`);
	return parsed;
}

const WORK = recipe("work", {
	model: "anthropic/claude-5",
	models: ["openai-codex/*"],
	extensions: ["/opt/extensions/work-int.ts"],
});
const HOME = recipe("home", {
	model: "anthropic/claude-haiku-5",
	mcpServers: { linear: { url: "https://mcp.example.com/linear" } },
});
const WORK_LITE = recipe("work-lite", { extensions: ["/opt/e.ts"] });
const SCOPE_ONLY = recipe("scope", { models: ["anthropic/*"] });
const BROKEN = recipe("broken", { extensions: ["missing-ext"] });

const BASE_ENV = { PATH: "/usr/bin" } as Record<string, string | undefined>;
const BASE_RECIPES: Record<string, RecipeDefinition> = { work: WORK, home: HOME };

function decide(
	args: string[],
	overrides: Partial<TrampolineOptions> = {},
): TrampolineDecision {
	return decideRelaunch({
		argv: ["/bin/pi", "/bin/pi", ...args],
		command: "/bin/pi",
		env: { ...BASE_ENV },
		recipes: { ...BASE_RECIPES },
		aioExtensionPath: "/aio/index.ts",
		...overrides,
	});
}

function relaunchSpec(decision: TrampolineDecision): RelaunchSpec | undefined {
	return decision.action === "relaunch" ? decision.spec : undefined;
}

function sessionNote(decision: TrampolineDecision): string {
	return decision.action === "session-apply" ? (decision.note ?? "") : "";
}

test("cliArgsFromArgv drops the binary and script slots", () => {
	assert.deepEqual(
		cliArgsFromArgv(["/bin/pi", "/bin/pi", "--recipe", "work"]),
		["--recipe", "work"],
	);
	assert.deepEqual(
		cliArgsFromArgv(["/bin/node", "/pi/dist/cli.js", "-p", "hi"]),
		["-p", "hi"],
	);
});

test("compiled Bun relaunch never forwards its virtual entry point as a prompt", () => {
	const decision = decide([], {
		argv: ["bun", "/$bunfs/root/pi", "--recipe", "work"],
		command: "/opt/pi/pi",
	});
	const spec = relaunchSpec(decision);
	assert.ok(spec);
	assert.equal(spec.command, "/opt/pi/pi");
	assert.equal(spec.args.includes("/$bunfs/root/pi"), false);
	assert.deepEqual(parseArgs(spec.args).messages, []);
	assert.deepEqual(parseArgs(spec.args).extensions, [
		"/aio/index.ts",
		"/opt/extensions/work-int.ts",
	]);
	assert.deepEqual(parseArgs(spec.args).models, ["openai-codex/*"]);
});

test("compiled Bun relaunch preserves real prompts, files, and the -- boundary", () => {
	const spec = relaunchSpec(decide([], {
		argv: ["bun", "/$bunfs/root/pi", "--recipe=work", "--", "@notes.md", "--recipe", "literal prompt"],
		command: "/opt/pi/pi",
	}));
	assert.ok(spec);
	assert.deepEqual(parseArgs(spec.args).fileArgs, ["notes.md"]);
	assert.deepEqual(parseArgs(spec.args).messages, ["--recipe", "literal prompt"]);
});

test("Windows compiled Bun relaunch omits its virtual entry point", () => {
	const spec = relaunchSpec(decide([], {
		argv: ["bun", "B:\\~BUN\\root\\pi.exe", "--recipe", "work"],
		command: "C:\\Tools\\pi.exe",
	}));
	assert.ok(spec);
	assert.deepEqual(parseArgs(spec.args).messages, []);
});

test("Node and uncompiled Bun launches retain their on-disk CLI script", () => {
	for (const runtime of ["/opt/node/bin/node", "/opt/bun/bin/bun"]) {
		const spec = relaunchSpec(decide([], {
			argv: [runtime, "/local packages/pi/cli.js", "--recipe", "work", "actual prompt"],
			command: runtime,
		}));
		assert.ok(spec);
		assert.equal(spec.args[0], "/local packages/pi/cli.js");
		assert.deepEqual(parseArgs(spec.args.slice(1)).messages, ["actual prompt"]);
	}
});

test("stripRecipeInvocation removes both flag forms and leaves the tail", () => {
	assert.deepEqual(stripRecipeInvocation(["--recipe", "work", "-p"]), ["-p"]);
	assert.deepEqual(stripRecipeInvocation(["--recipe=work", "-p"]), ["-p"]);
	// `--recipe --print` parses as a bare boolean flag in pi's parser: the next
	// token is not consumed then either.
	assert.deepEqual(stripRecipeInvocation(["--recipe", "--print", "hi"]), [
		"--print",
		"hi",
	]);
	assert.equal(stripRecipeInvocation(["-p"]), undefined);
	// The terminator guards everything behind it: no recipe token before it,
	// so nothing to strip (pi's parser never sees one there either).
	assert.equal(stripRecipeInvocation(["--", "--recipe", "work"]), undefined);
	// Stripping preserves message-style tail tokens untouched.
	assert.deepEqual(
		stripRecipeInvocation(["--recipe", "work", "--", "--recipe", "x"]),
		["--", "--recipe", "x"],
	);
});

test("no --recipe flag -> none", () => {
	assert.deepEqual(decide(["-p", "hi"]), { action: "none", reason: "no-recipe" });
	assert.deepEqual(decide([]), { action: "none", reason: "no-recipe" });
	// node dev layout: no --recipe anywhere.
	assert.deepEqual(decide([], { argv: ["/bin/node", "/pi/dist/cli.js", "-p"] }), {
		action: "none",
		reason: "no-recipe",
	});
});

test("stage guard, subagent children, and sessionless launches never bridge", () => {
	assert.deepEqual(
		decide(["--recipe", "work"], { env: { ...BASE_ENV, [RECIPE_STAGE_ENV]: "1" } }),
		{ action: "none", reason: "stage" },
	);
	assert.deepEqual(
		decide(["--recipe", "work"], { env: { ...BASE_ENV, AIO_SUBAGENT_CHILD: "1" } }),
		{ action: "none", reason: "child" },
	);
	assert.deepEqual(decide(["update"]), { action: "none", reason: "sessionless" });
	assert.deepEqual(decide(["--recipe", "work", "--help"]), {
		action: "none",
		reason: "sessionless",
	});
	assert.deepEqual(decide(["-h", "--recipe", "work"]), {
		action: "none",
		reason: "sessionless",
	});
	assert.deepEqual(decide(["--recipe", "work", "-v"]), {
		action: "none",
		reason: "sessionless",
	});
	assert.deepEqual(decide(["--recipe", "work", "--export", "in.jsonl"]), {
		action: "none",
		reason: "sessionless",
	});
	assert.deepEqual(decide(["--recipe", "work", "--list-models"]), {
		action: "none",
		reason: "sessionless",
	});
	assert.deepEqual(decide(["--recipe"]), { action: "none", reason: "bare-flag" });
});

test("unknown recipes hand back to the session path", () => {
	assert.deepEqual(decide(["--recipe", "ghost"]), {
		action: "unknown-recipe",
		name: "ghost",
	});
	// Home has no restart-scoped keys: still applies, just without the bridge.
	assert.deepEqual(decide(["--recipe", "home"]), {
		action: "session-apply",
		name: "home",
	});
});

test("restart-scoped recipe gets a relaunch spec with guarded child env", () => {
	const decision = decide(["--recipe", "work", "-p", "hi"]);
	const spec = relaunchSpec(decision);
	assert.ok(spec, "restart-scoped recipe relaunches");
	assert.equal(spec.command, "/bin/pi");
	assert.equal(spec.recipeName, "work");
	assert.deepEqual(spec.reasons, ["extension set", "model scope"]);
	assert.deepEqual(spec.args, [
		"/bin/pi",
		"-ne",
		"-e",
		"/aio/index.ts",
		"-e",
		"/opt/extensions/work-int.ts",
		"--models",
		"openai-codex/*",
		"-p",
		"hi",
	]);
	assert.equal(spec.env[RECIPE_STAGE_ENV], "1");
	assert.equal(spec.env[ACTIVE_RECIPE_ENV], "work");
	assert.equal(spec.env.PATH, "/usr/bin");
});

test("extensions-only recipe relaunches without --models", () => {
	const decision = decide(["--recipe", "work-lite"], {
		recipes: { "work-lite": WORK_LITE },
	});
	const spec = relaunchSpec(decision);
	assert.ok(spec);
	assert.equal(spec.args.includes("--models"), false);
	assert.deepEqual(spec.reasons, ["extension set"]);
});

test("models-only recipe relaunches without extension flags", () => {
	const decision = decide(["--recipe", "scope"], {
		recipes: { scope: SCOPE_ONLY },
	});
	const spec = relaunchSpec(decision);
	assert.ok(spec);
	assert.equal(spec.args.includes("-ne"), false);
	assert.deepEqual(spec.reasons, ["model scope"]);
});

test("explicit CLI flags override the recipe's restart keys", () => {
	// User-typed --models wins: no model-scope bridge, extensions still apply.
	const withUserModels = decide(["--recipe", "work", "--models", "z.ai/*"]);
	const spec = relaunchSpec(withUserModels);
	assert.ok(spec);
	// The forwarded args keep the USER's --models (verbatim tail), not the
	// recipe's (openai-codex/*), and the bridge injects no extra scope.
	assert.deepEqual(spec.args.slice(-2), ["--models", "z.ai/*"]);
	assert.equal(spec.args.filter((token) => token === "--models").length, 1);
	assert.equal(spec.env[ACTIVE_RECIPE_ENV], "work");
	assert.deepEqual(spec.reasons, ["extension set"]);

	// User-typed extension flags win for the extension set. For a recipe with
	// only extension keys there is nothing left to bridge: stand down.
	const userExt = decide(["--recipe", "work-lite", "-e", "./x.ts"], {
		recipes: { "work-lite": WORK_LITE, home: HOME },
	});
	assert.equal(userExt.action, "session-apply");
	assert.match(sessionNote(userExt), /explicit CLI flags/);
	// For a recipe with extension AND model keys, the models branch survives
	// a typed -e: the brief bridge relaunches with scope only.
	const stillScoped = decide(["--recipe", "work", "-e", "./x.ts"]);
	assert.deepEqual(relaunchSpec(stillScoped)?.reasons, ["model scope"]);

	const userBoth = decide(["--recipe", "work", "-ne", "--models", "z.ai/*"]);
	assert.equal(userBoth.action, "session-apply");
});

test("extension sources that do not resolve stand down with a note", () => {
	const decision = decide(["--recipe", "broken"], {
		recipes: { broken: BROKEN },
		exists: () => false,
	});
	assert.equal(decision.action, "session-apply");
	assert.match(sessionNote(decision), /no extension sources resolved/);
});

test("--recipe after the message terminator stays a message", () => {
	assert.deepEqual(decide(["--", "--recipe", "work"]), {
		action: "none",
		reason: "no-recipe",
	});
});

test("AIO_RECIPE_EXTENSION_PATH anchors to this package entry point", () => {
	assert.match(AIO_RECIPE_EXTENSION_PATH, /index\.ts$/);
});

test("relaunchNotice names the recipe and reasons", () => {
	const spec: RelaunchSpec = {
		command: "/bin/pi",
		args: [],
		env: {},
		recipeName: "work",
		reasons: ["extension set", "model scope"],
	};
	assert.equal(
		relaunchNotice(spec),
		'recipes: restarting pi with recipe "work" (extension set + model scope)',
	);
});

test("execRelaunch spawns with inherited stdio and relays the exit code", async () => {
	const child = new EventEmitter();
	const spawns: Array<{ command: string; args: string[]; options: unknown }> = [];
	const exitCalls: number[] = [];
	const successPromise = execRelaunch(
		{
			command: "/bin/pi",
			args: ["-p"],
			env: { X: "1" },
			recipeName: "work",
			reasons: ["extension set"],
		},
		{
			spawn: ((command: string, args: string[], options: unknown) => {
				spawns.push({ command, args, options });
				return child as never;
			}) as never,
			exit: ((code: number) => {
				exitCalls.push(code);
				throw new Error("test exit");
			}) as never,
			stderr: () => {},
		},
	);
	// While the child is open the runner stays pending, and exit has not fired.
	let resolvedValue: boolean | undefined;
	void successPromise.then(
		(ok) => {
			resolvedValue = ok;
		},
		() => {},
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(exitCalls.length, 0);
	assert.equal(resolvedValue, undefined);

	// The child closing is the terminal handback: exit runs with its code and
	// the promise itself never settles.
	assert.throws(() => child.emit("close", 3, null), /test exit/);
	assert.deepEqual(exitCalls, [3]);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(resolvedValue, undefined, "close path exits instead of resolving");

	assert.equal(spawns.length, 1);
	assert.equal(spawns[0]!.command, "/bin/pi");
	assert.deepEqual(spawns[0]!.args, ["-p"]);
	const options = spawns[0]!.options as {
		stdio: string;
		env: Record<string, string | undefined>;
		windowsHide: boolean;
	};
	assert.equal(options.stdio, "inherit");
	assert.equal(options.windowsHide, true);
	assert.equal(options.env.X, "1");
});

test("execRelaunch reports spawn errors and yields false (in-session fallback)", async () => {
	const lines: string[] = [];
	const ok = await execRelaunch(
		{
			command: "/gone/pi",
			args: [],
			env: {},
			recipeName: "work",
			reasons: ["extension set"],
		},
		{
			spawn: (() => {
				throw new Error("spawn ENOENT");
			}) as never,
			exit: (() => undefined) as never,
			stderr: (line) => lines.push(line),
		},
	);
	assert.equal(ok, false);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /could not relaunch.*ENOENT/);
});

test("execRelaunch recovers from an async spawn error followed by close", async () => {
	const child = new EventEmitter();
	const lines: string[] = [];
	const exitCalls: number[] = [];
	const okPromise = execRelaunch(
		{
			command: "/bin/pi",
			args: [],
			env: {},
			recipeName: "work",
			reasons: ["model scope"],
		},
		{
			spawn: (() => child) as never,
			exit: ((code: number) => { exitCalls.push(code); }) as never,
			stderr: (line) => lines.push(line),
		},
	);
	// The spawn error surfaces asynchronously through the "error" event.
	child.emit("error", new Error("async spawn ENOENT"));
	assert.equal(await okPromise, false);
	// Node emits close after error even when no process was started. It must
	// not kill the parent session after the in-process fallback has resumed.
	child.emit("close", -2, null);
	assert.deepEqual(exitCalls, []);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /failed.*async spawn ENOENT/);
});
