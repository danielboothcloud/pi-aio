// Regenerate golden.json from the TypeScript recipes (the reference):
//   npx tsx go/internal/recipes/testdata/gen-golden.ts [--check]
// FIXTURES below are written into a temp tree; the Go test writes the same
// files. Paths are recorded with the @@ROOT@@ placeholder.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "aio-recipes-golden-")));

// Every value is the exact file text. The Go test reads FIXTURES from golden.json.
const FIXTURES: Record<string, string> = {
	"agent/aio-recipes.json": JSON.stringify({
		defaultRecipe: "home",
		recipes: {
			home: { description: "  Home setup  ", model: "anthropic/claude-x:high", thinkingLevel: "LOW", models: ["a/*", " ", 3], mcpServers: { docs: { url: "https://d" }, " ": { url: "x" }, bad: 1 }, extensions: ["npm:x", ""], permissionMode: " Plan ", style: "humanised", junk: true },
			shared: { description: "global shared", mode: "auto", style: "mentor" },
			blocky: { blocklist: ["rm -rf", { pattern: "^git push", regex: true, match: "command" }] },
			blockOff: { blocklist: { enabled: false, entries: ["x"] } },
			blockFileMode: { blocklist: { match: "command", entries: ["vault"] } },
			nullMode: { permissionMode: null, mode: "ask", thinkingLevel: "huge", style: "loud" },
			notObject: "x",
			"": { model: "m" },
		},
	}),
	"project/.pi/aio-recipes.json": JSON.stringify({
		defaultRecipe: "proj",
		recipes: { proj: { model: "openai/gpt" }, shared: { description: "project shared" } },
	}),
	"project/.pi-recipe": JSON.stringify({
		defaultRecipe: "dir",
		recipes: { dir: { models: ["openai-codex/*"], extensions: ["npm:pi-lens"] }, shared: { style: "off" } },
	}),
	"project/.pi-recipe.json": JSON.stringify({ recipes: { ignored: {} } }),
	"baddefault/.pi-recipe": JSON.stringify({ defaultRecipe: "home", recipes: { local: {} } }),
	"onlyjson/.pi-recipe.json": JSON.stringify({ defaultRecipe: "j", recipes: { j: { model: "x" } } }),
	"broken/.pi-recipe": "{ not json",
	"arrayrecipes/.pi-recipe": JSON.stringify({ defaultRecipe: "0", recipes: [{ model: "first" }] }),
	"empty/.keep": "",
	// Home recipes that `/recipe init --from` copies: raw text, because the
	// copy must keep JavaScript's key order (array-index keys first, a
	// repeated key at its first position with its last value).
	"templates/aio-recipes.json": `{"recipes":{
 "work":{"description":"Work subscriptions with a description longer than forty-two chars","model":"openai/gpt-5:high","models":["openai/*"," anthropic/claude-x "],
  "mcpServers":{"zeta":{"url":"https://z","headers":{"b":"2","a":"1","10":"ten","2":"two"}},"alpha":{"command":"npx","args":["-y","x"],"env":{"TOKEN":"secret"}}," ":{"url":"skip"},"bad":1,"10":{"url":"ten"},"list":[1,{"b":1,"a":2}],"zeta":{"url":"https://z2","b":1,"b":2,"q":"<&>\u2028"}},
  "extensions":["npm:pi-lens","./local.ts"," "],
  "blocklist":{"match":"command","entries":["vault",{"pattern":" ^git push ","regex":true,"reason":"  no  ","match":"text"},{"pattern":"x"},{"pattern":"y","reason":"  "},{"pattern":"z","match":"command"},"  ",3,{"pattern":7}]},
  "permissionMode":"Plan","style":"humanised","junk":1},
 "plain":{},
 "home":{"description":"Home","model":"anthropic/claude-x","thinkingLevel":"low","blocklist":["rm -rf",{"pattern":"p"}],"mode":"ask"},
 "Ünï":{"description":"unicode name","model":"m:max"},
 "blockoff":{"blocklist":{"enabled":false,"entries":["x"]}}
}}`,
	"notemplates/aio-recipes.json": JSON.stringify({ recipes: {} }),
};
for (const [path, text] of Object.entries(FIXTURES)) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

process.env.AIO_RECIPES_FILE = join(root, "agent", "aio-recipes.json");
process.env.AIO_RECIPE_TRUST_FILE = join(root, "agent", "aio-recipe-trust.json");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const savedStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (() => true) as typeof process.stderr.write; // config warnings are not part of parity

const config = await import(join(repo, "recipes", "config.ts"));
const apply = await import(join(repo, "recipes", "apply.ts"));
const trust = await import(join(repo, "recipes", "trust.ts"));

function placeholders<T>(value: T): T {
	const text = JSON.stringify(value ?? null).split(root).join("@@ROOT@@");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`placeholder substitution broke the JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** A RecipesConfig without the `empty` flag, with blocklist entries made explicit. */
function view(loaded: { recipes: Record<string, { config: Record<string, unknown> }>; defaultRecipe?: string; defaultSource?: string; directoryFile?: string }) {
	const recipes: Record<string, unknown> = {};
	for (const [name, def] of Object.entries(loaded.recipes)) {
		const blocklist = (def.config.blocklist as unknown[] | undefined)?.map((entry) =>
			typeof entry === "string" ? { pattern: entry, regex: false, reason: "", command: false } : {
				pattern: (entry as { pattern: string }).pattern,
				regex: (entry as { regex?: boolean }).regex === true,
				reason: (entry as { reason?: string }).reason ?? "",
				command: (entry as { match?: string }).match === "command",
			});
		recipes[name] = { ...def, config: { ...def.config, blocklist } };
	}
	return { recipes, defaultRecipe: loaded.defaultRecipe ?? "", defaultSource: loaded.defaultSource ?? "", directoryFile: loaded.directoryFile ?? "" };
}

const loads: unknown[] = [];
for (const dir of ["project", "baddefault", "onlyjson", "broken", "arrayrecipes", "empty"]) {
	for (const [projectTrusted, directoryTrusted] of [[false, false], [true, false], [false, true], [true, true]]) {
		const loaded = config.loadRecipes(join(root, dir), { projectTrusted, directoryTrusted });
		loads.push({ dir, projectTrusted, directoryTrusted, result: view(loaded) });
	}
}

const specs = ["anthropic/claude:high", "hf:zai-org/GLM-5.3", "hf:zai/GLM:XHIGH", "m: max ", ":high", "plain", "a:b:off"].map((spec) => ({
	spec,
	result: config.parseModelSpec(spec),
}));

const branches = [
	[],
	[{ type: "custom", customType: "recipe-state", data: { name: " work " } }],
	[{ type: "custom", customType: "recipe-state", data: { name: "a" } }, { type: "custom", customType: "recipe-state", data: { name: null } }],
	[{ type: "custom", customType: "recipe-state", data: { name: "a" } }, { type: "message" }, { type: "custom", customType: "other" }],
	[{ type: "custom", customType: "recipe-state" }],
].map((entries) => ({ entries, result: apply.latestPersistedRecipe(entries) }));

// Trust store written by TypeScript, read by Go.
const dirFile = join(root, "project", ".pi-recipe");
trust.recordRecipeFileTrust(dirFile, true);
trust.recordRecipeFileTrust(join(root, "onlyjson", ".pi-recipe.json"), false);
const trustStates = ["project/.pi-recipe", "onlyjson/.pi-recipe.json", "broken/.pi-recipe"].map((path) => ({
	path,
	state: trust.recipeFileTrust(join(root, path)),
	hash: trust.hashRecipeFile(join(root, path)) ?? "",
}));
const descriptions = ["project/.pi-recipe", "broken/.pi-recipe", "baddefault/.pi-recipe"].map((path) => ({
	path,
	lines: trust.describeRecipeFile(join(root, path)),
}));
const trustStore = readFileSync(process.env.AIO_RECIPE_TRUST_FILE, "utf8").replace(/"decidedAt": "[^"]*"/g, '"decidedAt": "@@TIME@@"');

const extra = await import(join(here, "gen-golden-commands.ts"));
const commands = await extra.generate({ repo, root, placeholders, setStderr: (write: typeof process.stderr.write) => { process.stderr.write = write; } });

process.stderr.write = savedStderr;
rmSync(root, { recursive: true, force: true });
const output = `${JSON.stringify({ fixtures: FIXTURES, loads: placeholders(loads), specs, branches, trustStates, descriptions: placeholders(descriptions), trustStore: placeholders(trustStore), ...commands.golden }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("recipes golden.json is stale: run npx tsx go/internal/recipes/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`recipes golden.json is current (${loads.length} loads, ${commands.counts})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`recipes golden.json: ${loads.length} loads, ${commands.counts}`);
}
