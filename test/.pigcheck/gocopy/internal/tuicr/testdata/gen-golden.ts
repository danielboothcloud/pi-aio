// Regenerate golden.json from the TypeScript tuicr port (the reference):
//   npx tsx go/internal/tuicr/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const core = await import(join(repo, "tuicr", "core.ts"));
const picker = await import(join(repo, "tuicr", "picker.ts"));

// A fake world: command → stdout (null = failure).
type World = Record<string, string | null>;
const worlds: Record<string, World> = {
	originHead: { "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/develop", "git rev-parse --abbrev-ref HEAD": "feat", "git rev-parse --verify --quiet origin/develop": "abc" },
	onMain: { "git rev-parse --abbrev-ref HEAD": "main", "git rev-parse --verify --quiet main": "abc", "git rev-parse --verify --quiet master": "def" },
	localMaster: { "git rev-parse --abbrev-ref HEAD": "x", "git rev-parse --verify --quiet master": "abc" },
	none: {},
	comments: {
		"tuicr review list --all": JSON.stringify([{ path: "/s1", comment_count: 2 }, { path: "/s0", comment_count: 0 }, { path: "/s2", comment_count: 1 }]),
		"tuicr review comments --session /s1": JSON.stringify([{ id: "a", location: "src/a.ts:3", comment_type: "issue", content: "  fix\n\nthis  " }, { id: "b", path: "b.ts", comment_type: "none", content: "ok" }]),
		"tuicr review comments --session /s2": JSON.stringify([{ id: "c", content: "general" }]),
	},
	badJson: { "tuicr review list --all": "{nope" },
	notArray: { "tuicr review list --all": "{}" },
};
const capture = (world: World) => (command: string, args: string[]) => {
	const key = [command, ...args].join(" ");
	return Object.hasOwn(world, key) ? world[key] : null;
};
const results: Record<string, unknown> = {};
for (const [name, world] of Object.entries(worlds)) {
	let comments: unknown;
	try {
		comments = core.allComments("/w", capture(world));
	} catch (error) {
		comments = { error: (error as Error).message.replace(/printed malformed JSON: .*/, "printed malformed JSON") };
	}
	results[name] = { base: core.baseBranch("/w", capture(world)), comments };
}

const formats = [[], [{ id: "a", location: "src/a.ts:3", comment_type: "issue", content: "  fix\n\nthis  " }, { id: "b", path: "b.ts", comment_type: "none", content: "ok" }, { id: "c", content: "general\nnote", comment_type: "nit" }]]
	.map((comments) => ({ comments, text: core.format(comments) }));

// The picker: answer each label in turn, with input answers for prompts.
const pickers: unknown[] = [];
for (const base of ["origin/main", null]) {
	const labels: string[] = [];
	await picker.pickTarget({ cwd: "/w", ui: { select: async (_t: string, options: string[]) => { labels.push(...options); return undefined; } } } as never,
		() => null);
	for (const answer of ["HEAD~3..HEAD", "  ", undefined]) {
		const world: World = base ? { "git rev-parse --abbrev-ref HEAD": "x", "git rev-parse --verify --quiet origin/main": "abc" } : {};
		const all: string[] = [];
		await picker.pickTarget({ cwd: "/w", ui: { select: async (_t: string, options: string[]) => { all.push(...options); return undefined; } } } as never, capture(world));
		for (const label of all) {
			const args = await picker.pickTarget({ cwd: "/w", ui: { select: async () => label, input: async () => answer } } as never, capture(world));
			pickers.push({ base, label, answer: answer ?? null, args });
		}
	}
}

const doc = `${JSON.stringify({ worlds, results, formats, pickers }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== doc) {
		console.error("tuicr golden.json is stale: run npx tsx go/internal/tuicr/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`tuicr golden.json is current (${pickers.length} picker choices)`);
} else {
	writeFileSync(goldenPath, doc);
	console.log(`tuicr golden.json: ${Object.keys(worlds).length} worlds, ${pickers.length} picker choices`);
}
