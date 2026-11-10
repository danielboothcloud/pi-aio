import assert from "node:assert/strict";
import test from "node:test";
import { parseRecipeConfig, type RecipeDefinition } from "./config.ts";
import { isPigHost, pigHarnessBinary } from "./pig-host.ts";
import { selectedSessionRelaunch } from "./resume.ts";
import { decideRelaunch } from "./trampoline.ts";

/** The environment PiG gives an extension cell (observed with pig 0.7.0). */
const PIG_ENV = {
	PATH: "/usr/bin",
	AI_AGENT: "pig",
	PIG_HARNESS_BINARY: "/Users/me/go/bin/pig",
};

/** PiG's cell argv: the Node helper, not the `pig` CLI. */
const PIG_ARGV = [
	"/usr/local/bin/node",
	"/Users/me/.config/pig/cache/cells/node/abc/runtime/harness/cli.mjs",
];

function recipe(name: string, raw: Record<string, unknown>): RecipeDefinition {
	const parsed = parseRecipeConfig(name, "directory", "/repo", raw);
	assert.ok(parsed);
	return parsed;
}

const RECIPES: Record<string, RecipeDefinition> = {
	scoped: recipe("scoped", { models: ["anthropic/*"], extensions: ["/opt/ext.ts"] }),
	light: recipe("light", { model: "anthropic/claude-5" }),
};

test("pigHarnessBinary needs both PiG markers", () => {
	assert.equal(pigHarnessBinary(PIG_ENV), "/Users/me/go/bin/pig");
	assert.equal(isPigHost(PIG_ENV), true);
	assert.equal(isPigHost({}), false);
	assert.equal(isPigHost({ AI_AGENT: "pig" }), false);
	assert.equal(isPigHost({ ...PIG_ENV, PIG_HARNESS_BINARY: "  " }), false);
	// Real pi resets AI_AGENT=pi at startup, so an inherited PIG_HARNESS_BINARY
	// (a `pi` launched from a PiG shell) is still Pi.
	assert.equal(isPigHost({ ...PIG_ENV, AI_AGENT: "pi" }), false);
});

test("bridge: under PiG a restart-scoped recipe applies in-session instead of relaunching", () => {
	for (const args of [["--recipe", "scoped"], []]) {
		const decision = decideRelaunch({
			argv: [...PIG_ARGV, ...args],
			command: "/usr/local/bin/node",
			env: PIG_ENV,
			recipes: RECIPES,
			directoryRecipe: "scoped",
			aioExtensionPath: "/aio/index.ts",
		});
		assert.equal(decision.action, "session-apply", JSON.stringify(args));
		assert.ok(decision.action === "session-apply");
		assert.equal(decision.name, "scoped");
		assert.match(decision.note ?? "", /PiG cannot restart/);
		assert.match(decision.note ?? "", /aio-pig\.mjs launcher/);
		assert.match(decision.note ?? "", /extension set and model scope not applied/);
	}
});

test("bridge: after the aio-pig launcher, pig keeps Pi's notes and never spawns", () => {
	const env = { ...PIG_ENV, AIO_PIG_LAUNCHER: "1" };
	const base = { command: "node", env, recipes: RECIPES, aioExtensionPath: "/aio/index.ts" };
	// The launcher already applied it, so the child is staged.
	assert.deepEqual(
		decideRelaunch({ ...base, argv: [...PIG_ARGV, "--recipe", "scoped"], env: { ...env, AIO_RECIPE_STAGE: "1" } }),
		{ action: "none", reason: "stage" },
	);
	// Explicit CLI flags: the same note Pi gives.
	const overridden = decideRelaunch({
		...base,
		argv: [...PIG_ARGV, "--recipe", "scoped", "-e", "/x.ts", "--models", "a/*"],
	});
	assert.ok(overridden.action === "session-apply");
	assert.match(overridden.note ?? "", /overridden by explicit CLI flags/);
	// Inputs that would still relaunch never spawn from inside pig.
	const mismatch = decideRelaunch({ ...base, argv: [...PIG_ARGV, "--recipe", "scoped"] });
	assert.ok(mismatch.action === "session-apply");
	assert.match(mismatch.note ?? "", /launcher did not apply/);
});

test("bridge: under PiG session-only recipes and unknown names keep their decisions", () => {
	const base = { argv: PIG_ARGV, command: "node", env: PIG_ENV, recipes: RECIPES };
	assert.deepEqual(
		decideRelaunch({ ...base, argv: [...PIG_ARGV, "--recipe", "light"] }),
		{ action: "session-apply", name: "light" },
	);
	assert.deepEqual(
		decideRelaunch({ ...base, argv: [...PIG_ARGV, "--recipe", "nope"] }),
		{ action: "unknown-recipe", name: "nope" },
	);
});

test("bridge: the same launch outside PiG still relaunches", () => {
	const decision = decideRelaunch({
		argv: ["/bin/pi", "/bin/pi", "--recipe", "scoped"],
		command: "/bin/pi",
		env: { ...PIG_ENV, AI_AGENT: "pi" },
		recipes: RECIPES,
		aioExtensionPath: "/aio/index.ts",
	});
	assert.equal(decision.action, "relaunch");
});

test("session switches never relaunch under PiG; picker and /resume get a restart hint", () => {
	const def = RECIPES.scoped;
	const call = (argv: string[], reason: "resume" | "startup") =>
		selectedSessionRelaunch({ argv: [...PIG_ARGV, ...argv], command: "node", env: PIG_ENV, reason, file: "/s.jsonl", def });
	for (const [argv, reason] of [[[], "resume"], [["--resume"], "startup"]] as const) {
		const hint = call([...argv], reason);
		assert.ok(hint?.action === "session-apply", reason);
		assert.equal(hint.name, "scoped");
		assert.match(hint.note ?? "", /needs a restart for its extension set \+ model scope: pig --session "\/s\.jsonl"/);
	}
	// Direct references were resolved by the launcher or reported by the factory.
	assert.equal(call(["--continue"], "startup"), undefined);
	assert.equal(call(["--session", "/s.jsonl"], "startup"), undefined);
	// A session-only recipe needs no restart.
	assert.equal(
		selectedSessionRelaunch({ argv: PIG_ARGV, command: "node", env: PIG_ENV, reason: "resume", file: "/s.jsonl", def: RECIPES.light }),
		undefined,
	);
});
