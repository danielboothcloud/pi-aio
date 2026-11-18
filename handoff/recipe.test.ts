/**
 * handoff/recipe.ts — the `.pi-recipe` default a handoff enforces. Sandboxed:
 * agent dir, trust store, and global recipes file live under a temp root.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ACTIVE_RECIPE_ENV, RECIPES_FILE_ENV, RECIPE_STAGE_ENV } from "../recipes/config.ts";
import { RECIPE_TRUST_FILE_ENV, TRUST_CHOICE_LABELS, recipeFileTrust, recordRecipeFileTrust } from "../recipes/trust.ts";
import { resolveHandoffRecipe } from "./recipe.ts";

const tmp = mkdtempSync(join(tmpdir(), "aio-handoff-recipe-"));
const agentDir = join(tmp, "agent");
const dir = join(tmp, "repo");
const file = join(dir, ".pi-recipe");
const SAVED = {
	agentDir: process.env.PI_CODING_AGENT_DIR,
	recipesFile: process.env[RECIPES_FILE_ENV],
	trustFile: process.env[RECIPE_TRUST_FILE_ENV],
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env[RECIPES_FILE_ENV] = join(agentDir, "aio-recipes.json");
process.env[RECIPE_TRUST_FILE_ENV] = join(agentDir, "aio-recipe-trust.json");

function restore(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

test.after(() => {
	restore("PI_CODING_AGENT_DIR", SAVED.agentDir);
	restore(RECIPES_FILE_ENV, SAVED.recipesFile);
	restore(RECIPE_TRUST_FILE_ENV, SAVED.trustFile);
	rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify({
		defaultRecipe: "proj",
		recipes: { proj: { model: "anthropic/claude-5:high", style: "concise", extensions: ["./ext.ts"] } },
	}));
});

function ctx(picks: Array<string | undefined> = []) {
	const asked: string[] = [];
	return {
		asked,
		value: {
			cwd: dir,
			hasUI: true,
			isProjectTrusted: () => false,
			ui: {
				select: async (title: string) => {
					asked.push(title);
					return picks.shift();
				},
			},
		},
	};
}

const argv = ["node", "pi"];

test("no .pi-recipe: nothing to enforce, no question", async () => {
	rmSync(file);
	const c = ctx();
	assert.deepEqual(await resolveHandoffRecipe(c.value as never, { argv, env: {} }), {});
	assert.equal(c.asked.length, 0);
});

test("a trusted default is enforced with the keys it owns and a restart note", async () => {
	recordRecipeFileTrust(file, true);
	const c = ctx();
	const result = await resolveHandoffRecipe(c.value as never, { argv, env: {} });
	assert.equal(c.asked.length, 0);
	assert.deepEqual(result.recipe?.owns, ["model", "thinking", "style"]);
	assert.equal(result.recipe?.name, "proj");
	assert.match(result.recipe?.restartNote ?? "", /need a restart/);

	// A launch already bridged for this recipe has its extensions: no note.
	const bridged = await resolveHandoffRecipe(c.value as never, { argv, env: { [RECIPE_STAGE_ENV]: "1", [ACTIVE_RECIPE_ENV]: "proj" } });
	assert.equal(bridged.recipe?.restartNote, undefined);
	const other = await resolveHandoffRecipe(c.value as never, { argv, env: { [RECIPE_STAGE_ENV]: "1", [ACTIVE_RECIPE_ENV]: "work" } });
	assert.match(other.recipe?.restartNote ?? "", /recipe "work"/);
});

test("an unknown version asks once; trust enforces it, other answers keep the old state", async () => {
	const trusting = ctx([TRUST_CHOICE_LABELS.trust]);
	const trusted = await resolveHandoffRecipe(trusting.value as never, { argv, env: {} });
	assert.equal(trusting.asked.length, 1);
	assert.match(trusting.asked[0]!, /Trust this recipe file\?/);
	assert.equal(trusted.recipe?.name, "proj");
	assert.equal(recipeFileTrust(file), "trusted");

	writeFileSync(file, JSON.stringify({ defaultRecipe: "proj", recipes: { proj: {} } }));
	const skipping = ctx([undefined]);
	const skipped = await resolveHandoffRecipe(skipping.value as never, { argv, env: {} });
	assert.equal(skipped.recipe, undefined);
	assert.match(skipped.note ?? "", /not trusted yet/);
	assert.equal(recipeFileTrust(file), "unknown");

	const denying = ctx([TRUST_CHOICE_LABELS.deny]);
	const denied = await resolveHandoffRecipe(denying.value as never, { argv, env: {} });
	assert.match(denied.note ?? "", /\.pi-recipe is not trusted;/);
	assert.equal(recipeFileTrust(file), "denied");
});

test("--no-approve and a missing default are notes, not enforcement", async () => {
	recordRecipeFileTrust(file, true);
	const c = ctx();
	const noApprove = await resolveHandoffRecipe(c.value as never, { argv: [...argv, "--no-approve"], env: {} });
	assert.match(noApprove.note ?? "", /not trusted/);
	assert.equal(c.asked.length, 0);

	writeFileSync(file, JSON.stringify({ recipes: { proj: {} } }));
	recordRecipeFileTrust(file, true);
	const noDefault = await resolveHandoffRecipe(c.value as never, { argv, env: {} });
	assert.match(noDefault.note ?? "", /no valid defaultRecipe/);
});
