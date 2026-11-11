// Regenerate golden.json from the TypeScript nvim feature and the
// yaml-hooks tool-path helpers it uses:
//   npx tsx go/internal/nvim/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const core = await import(join(repo, "nvim", "core.ts"));
const toolPaths = await import(join(repo, "yaml-hooks", "tool-paths.ts"));
const { default: registerNvim } = await import(join(repo, "nvim", "index.ts"));

const targets = ["a.ts", "a.ts:42", "a.ts:42:7", " a b.ts:3 ", "a.ts:0", "a.ts:5:0", "C:10:20", "dir:x/a.ts:9", ":5", "a.ts:", "a.ts:x"]
	.map((target) => ({ target, parsed: core.parseFileTarget(target) }));
const strips = ["@a.ts", '@"a b.ts"', "a.ts", "  @x ", '@"', "@@a"].map((token) => ({ token, result: core.stripAtReference(token) }));
const splits = ["", "a b.ts", "@a.ts:3 @b.ts", "  @a   @b  ", "x @y"].map((args) => ({ args, result: core.splitNvimTargets(args) }));
const requests = [{ path: "/r/a.ts" }, { path: "/r/a b.ts", line: 4 }, { path: "/r/it's.ts", line: 2, column: 3, readOnly: true }, { path: "/r/x.ts", column: 5 }];
const commands = requests.map((request) => ({ request, args: core.buildNvimArgs(request), command: core.formatNvimCommand(request), title: core.nvimTitle(request) }));

// Drive the real /nvim command: record launcher calls; `succeed` picks the launcher that works.
const saved = { otty: process.env.OTTY_PANE_ID, tmux: process.env.TMUX };
const runs: unknown[] = [];
for (const [env, succeed] of [[{}, ""], [{ OTTY_PANE_ID: "p1", TMUX: "t" }, "otty"], [{ TMUX: "t" }, "tmux"], [{}, "otty"], [{}, "osascript"]] as const) {
	for (const args of ["", "help", "-r", "-r a.ts:3", "--read-only @a.ts @b.ts:4:2", "@\"a b.ts\" @/abs/c.ts", "src/with space.ts:12", "-h", "@-r @x.ts"]) {
		delete process.env.OTTY_PANE_ID;
		delete process.env.TMUX;
		Object.assign(process.env, env);
		const calls: string[][] = [];
		const notes: string[] = [];
		const commandsMap = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const pi = {
			on: () => {},
			registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) => commandsMap.set(name, o),
			exec: async (bin: string, a: string[]) => { calls.push([bin, ...a]); return { stdout: "", stderr: "", code: bin === succeed || (succeed === "otty" && bin === "otty") ? 0 : 1 }; },
		};
		registerNvim(pi as never);
		await commandsMap.get("nvim")!.handler(args, { cwd: "/r", hasUI: true, ui: { notify: (m: string, level?: string) => notes.push(`${level ?? "info"}:${m}`) } });
		runs.push({ env, succeed, args, calls, notes });
	}
}
if (saved.otty === undefined) delete process.env.OTTY_PANE_ID; else process.env.OTTY_PANE_ID = saved.otty;
if (saved.tmux === undefined) delete process.env.TMUX; else process.env.TMUX = saved.tmux;

const toolInputs: Array<[string, Record<string, unknown>, boolean]> = [
	["read", { path: "a.ts" }, false], ["read", { file_path: "b.ts" }, false], ["read", { path: "" }, false], ["read", { path: "a.ts" }, true],
	["write", { path: "w.ts" }, false], ["edit", { path: "e.ts", edits: [{ oldText: "a" }, { path: "f.ts" }, { oldText: "b" }] }, false],
	["edit", { file_path: "x", fromPath: "y" }, false], ["edit", { path: "x", move: "z" }, false], ["write", { path: "c", op: "create" }, false],
	["apply_patch", { changes: [{ path: "a", action: "add" }, { path: "b", action: "delete" }, { path: "c", action: "move", fromPath: "d" }, { movePath: "e" }, { path: "f" }, "junk"] }, false],
	["apply_patch", { patch: "*** Begin Patch\n*** Add File: n.ts\n+x\n*** Update File: u.ts\n*** Move to: v.ts\n*** Update File: w.ts\n@@\n*** Delete File: d.ts\n*** End Patch" }, false],
	["patch", { input: "*** Update File: p.ts\n" }, false],
	["bash", { command: "rm -rf a b && git mv c d; cp -r e f || touch 'g h' \"i\" && mkdir -p j -- -k && git rm --cached l && echo x" }, false],
	["bash", { command: "mv only" }, false], ["bash", { cmd: "touch a\\ b" }, false], ["grep", { pattern: "x" }, false],
];
const tools = toolInputs.map(([tool, input, isError]) => ({
	tool, input, isError,
	result: core.filePathsFromToolResult({ toolName: tool, input, isError } as never),
	changes: toolPaths.getToolFileChanges(tool, input),
	structured: toolPaths.applyPatchStructuredChanges(input),
}));

let entries: unknown[] = [];
const touches: unknown[] = [];
for (const [paths, edited, now] of [[["/r/a"], false, 1], [["/r/b", "/r/c"], true, 2], [["/r/a"], true, 3], [["/r/c", "/r/c"], false, 4], [Array.from({ length: 45 }, (_, i) => `/r/f${i}`), false, 5]] as const) {
	entries = core.touchSessionFiles(entries as never, paths, edited, now);
	touches.push({ paths, edited, now, entries });
}
const session = [{ path: "/r/src/a.ts", edited: true, touchedAt: 1 }, { path: "/r/b.ts", edited: false, touchedAt: 1 }, { path: "/other/x.ts", edited: false, touchedAt: 1 }];
const completions = ["", "@src", "B.TS", "x", "@", "zzz"].map((prefix) => ({ prefix, items: core.buildNvimCompletions(prefix, session, ["src/a.ts", "c.ts", "../up.ts"], "/r", 3) }));

const doc = `${JSON.stringify({ targets, strips, splits, commands, runs, tools, touches, completions }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== doc) {
		console.error("nvim golden.json is stale: run npx tsx go/internal/nvim/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`nvim golden.json is current (${runs.length} command runs)`);
} else {
	writeFileSync(goldenPath, doc);
	console.log(`nvim golden.json: ${runs.length} command runs, ${tools.length} tool inputs`);
}
