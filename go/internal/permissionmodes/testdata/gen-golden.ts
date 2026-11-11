// Regenerate golden.json from the TypeScript permission-modes (the reference):
//   npx tsx go/internal/permissionmodes/testdata/gen-golden.ts [--check]
// It drives the real tool_call gate, todo tool, and before_agent_start
// handler through a minimal harness. Paths are written with @@ROOT@@ and @@HOME@@
// placeholders; the Go test rebuilds the same workspace and substitutes them.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "aio-modes-golden-")));
const cwd = join(root, "repo");
for (const dir of ["repo/src", "outside", "repo-sibling"]) mkdirSync(join(root, dir), { recursive: true });
writeFileSync(join(cwd, "src", "a.ts"), "const a = 1;\n");
symlinkSync(join(root, "outside"), join(cwd, "link-out"));
const savedCwd = process.cwd();
process.chdir(cwd);
delete process.env.AIO_SUBAGENT_CHILD;
delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;

const utils = await import(join(repo, "permission-modes", "utils.ts"));
const guard = await import(join(repo, "permission-modes", "workspace-guard.ts"));
const { registerPermissionModes } = await import(join(repo, "permission-modes", "index.ts"));
const { getPermissionModeAccess } = await import(join(repo, "permission-modes", "mode-access.ts"));

const home = homedir();
/** Replace the temp root and the home directory with placeholders; the shape stays T. */
function placeholders<T>(value: T): T {
	const text = JSON.stringify(value ?? null).split(root).join("@@ROOT@@").split(home).join("@@HOME@@");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`placeholder substitution broke the JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function harness(answers: Array<string | undefined>, hasUI: boolean, provider = "anthropic") {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const prompts: string[] = [];
	const notes: string[] = [];
	const queue = [...answers];
	const pi = {
		appendEntry: () => {},
		getActiveTools: () => ["read", "edit", "write", "bash"],
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
		registerFlag: () => {},
		registerShortcut: () => {},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		sendUserMessage: () => {},
		sendMessage: () => {},
		setActiveTools: () => {},
	};
	const ctx = {
		cwd,
		hasUI,
		model: { provider, id: "m" },
		ui: {
			notify: (message: string) => notes.push(message),
			select: async (prompt: string) => {
				prompts.push(prompt);
				return queue.shift();
			},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			theme: { fg: (_c: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};
	registerPermissionModes(pi as never, ["node", "pi"]);
	return { handlers, commands, tools, prompts, notes, ctx };
}

// ---- pure functions ----
const commands = [
	"ls", "ls -la", "  cat file.txt", "cat-editor x", "rg -n foo src", "rg --pre cat foo", "rg --p''re cat foo",
	"git status", "git status-extra", "git ls-files", "git branch", "git branch -a -v", "git branch -D x",
	"git remote -v", "git remote add x y", "git diff", "git log", "git show HEAD", "node --version", "python3.12 --version",
	"python3 -c 'print(1)'", "echo hi > out.txt", "echo a >> b", "cat <file", "diff a b", "grep -o x f", "sort -o out f",
	"rm -rf x", "RM x", "mv a b", "sudo ls", "npm install", "npm test", "echo $HOME", "ls; rm x", "ls && pwd", "ls | wc",
	"ls `pwd`", "ls (x)", "echo {a,b}", "ls *.ts", "ls [ab]", "echo 'a\\b'", "ls\tsrc", "ls\u00a0src", "ls\u000bsrc",
	"cat\u00a0x", "eza --tree", "ps aux", "which go", "type ls", "printenv", "uname -a", "du -sh .", "df -h",
	"git ls-tree HEAD", "head -n 5 f", "tail -f log", "wc -l f", "stat f", "echo --output=x", "curl https://x",
	"find . -name x", "env", "vim f", "code .", "kill 1", "git push", "git add .", "brew install x", "pip install x",
	"cat file | head", "", "   ", "echo \"a\"", "echo \u2028x", "ls -o", "ls --color=auto", "touch f", "ln -s a b",
];
const safety = commands.map((command) => ({
	command,
	safe: utils.isSafeCommand(command),
	destructive: utils.isDestructiveCommand(command),
}));

const messages = [
	"Plan:\n1. Use the `read` tool to inspect **index.ts**\n2) Run tests\n3. - skip\n4. /cmd x\n5. Check `config.json` for **bad** values and fix them all carefully please\n",
	"**Plan:**\n\n  1. **Update the README with notes**\n  2. Add tests for the parser module\n",
	"plan: \t \n1. Write docs\n10. Verify the whole thing works end to end\nNo plan here",
	"No header\n1. Step one\n",
	"Plan:\n1. ab\n2. `code first`\n3. Remove the obsolete flags from the CLI parser\n",
	"Thoughts\nPLAN:\n1. Execute the migration script now\n\n2. Read the logs [DONE:1]\n",
	"Plan:\n1. Ünïcödé step with ünïcödé text that is very long indeed\n2. 日本語のステップを確認する\n",
];
const todos = messages.map((message) => ({ message, items: utils.extractTodoItems(message) }));
const steps = [
	"Use the **bold** `code` step", "  run   many    spaces  ", "install the package", "x".repeat(60), "ab", "verify THE thing",
];
const cleaned = steps.map((text) => ({ text, cleaned: utils.cleanStepText(text) }));
const doneTexts = ["[DONE:1] [done:3] [DONE:x] [DONE:22]", "none"].map((text) => ({ text, steps: utils.extractDoneSteps(text) }));

const patchInputs: Array<Record<string, unknown>> = [
	{ changes: [{ path: "src/a.ts", action: "update", oldText: "a", newText: "b" }, { path: "src/b.ts", action: "move", movePath: "../outside/b.ts" }] },
	{ changes: [{ path: "x", action: "move", move_path: "/etc/y" }, { action: "add", path: 1 }, "junk"] },
	{ patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n" },
	{ patch: "--- /dev/null\n+++ b/../outside/new.ts\n@@ -0,0 +1 @@\n+x\n" },
	{ patch: "--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n" },
	{ patch: "--- a/same.ts\n+++ b/same.ts\n@@ -1 +1 @@\n x\n" },
	{ patch: "diff --git a/one b/two\n--- a/one\r\n+++ b/two\r\n@@ -1 +1 @@\n-a\n+b\n" },
	{ patch: "" },
];
const targets = patchInputs.map((input) => ({ input, paths: guard.mutationTargetPaths("apply_patch", input) }));

const guardCases: Array<[string, Record<string, unknown>]> = [
	["edit", { path: "src/a.ts" }], ["edit", { path: "@src/new/deep.ts" }], ["write", { path: "../repo-sibling/x" }],
	["write", { path: join(root, "outside", "x") }], ["write", { file_path: "~/aio-guard-probe.txt" }], ["edit", { path: "link-out/x" }],
	["edit", { path: "src/../../outside/y" }], ["write", { path: "~" }], ["read", { path: "/etc/hosts" }], ["write", { path: "  " }],
	["write", { path: "src\u00a0name.ts" }], ["apply_patch", patchInputs[0]], ["apply_patch", patchInputs[3]],
];
const outside = guardCases.map(([tool, input]) => {
	const found = guard.findOutsideTargets(tool, input, cwd, [], cwd);
	return { tool, input, outside: found, scopes: guard.approvalScopes(found) };
});

// ---- the tool_call gate ----
type GateCase = { mode: string; hasUI: boolean; answers: Array<string | undefined>; tool: string; id?: string; input: Record<string, unknown> };
const calls: Array<Pick<GateCase, "tool" | "input" | "id">> = [
	{ tool: "read", input: { path: "src/a.ts" } },
	{ tool: "bash", input: { command: "ls -la" } },
	{ tool: "bash", input: { command: "rm -rf build" } },
	{ tool: "hypa_shell", input: { command: "git push" } },
	{ tool: "bash", input: {} },
	{ tool: "edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } },
	{ tool: "write", input: { path: "src/new.ts", content: "x" } },
	{ tool: "write", input: { path: "../outside/x.ts", content: "x" } },
	{ tool: "apply_patch", input: { changes: [{ path: "src/a.ts", action: "update", oldText: "1", newText: "2" }, { path: "c", action: "add" }, { path: "d", action: "add" }, { path: "e", action: "add" }] } },
	{ tool: "apply_patch", input: patchInputs[3] },
	{ tool: "edit", id: "cursor-replay-1", input: { path: "src/a.ts" } },
	{ tool: "cursor", id: "cursor-replay-2", input: { activityTitle: "Shell command", toolName: "run" } },
	{ tool: "bash", id: "cursor-replay-3", input: { command: "ls" } },
	{ tool: "grep", input: { pattern: "x" } },
];
const answerSets: Array<Array<string | undefined>> = [
	["Allow"], ["Allow all (enable auto)"], ["Block"], [undefined], ["Allow once"], ["Allow this folder for the session"],
];
const gate: unknown[] = [];
for (const mode of ["default", "ask", "plan", "auto"]) {
	for (const hasUI of [true, false]) {
		for (const call of calls) {
			for (const answers of hasUI ? answerSets : [[]]) {
				const h = harness(answers, hasUI);
				await h.commands.get(mode)!.handler("", h.ctx);
				const event = { toolName: call.tool, toolCallId: call.id ?? "call-1", input: call.input };
				const result = await h.handlers.get("tool_call")![0](event, h.ctx);
				// The allowed folder must cover a second outside write there.
				const again = await h.handlers.get("tool_call")![0](event, h.ctx);
				gate.push(placeholders({
					mode, hasUI, answers: answers.map((a) => a ?? null), tool: call.tool, id: event.toolCallId, input: call.input,
					result: result ?? null, again: again ?? null,
					prompts: h.prompts.map((p) => p.split("\n\n")[0]), notes: h.notes,
					modeAfter: getPermissionModeAccess()?.getMode(),
				}));
			}
		}
	}
}

// ---- todo tool ----
const todoHarness = harness([], true);
const todoSteps = [
	{ action: "list" }, { action: "create", text: " first " }, { action: "create", text: "second" }, { action: "create", text: "zero", position: 1 },
	{ action: "create", text: "bad", position: 9 }, { action: "create", text: "  " }, { action: "toggle", step: 2 }, { action: "toggle", step: 9 },
	{ action: "toggle" }, { action: "rename", step: 1, text: "renamed" }, { action: "rename", step: 1, text: "" }, { action: "reorder", step: 3, position: 1 },
	{ action: "reorder", step: 1, position: 7 }, { action: "list" }, { action: "delete", step: 2 }, { action: "list" },
];
const todo: unknown[] = [];
for (const params of todoSteps) {
	const out = (await todoHarness.tools.get("todo")!.execute("t", params, undefined, undefined, todoHarness.ctx)) as {
		content: Array<{ text: string }>;
		details: unknown;
	};
	todo.push({ params, text: out.content[0].text, details: out.details });
}

// ---- before_agent_start context ----
const contexts: unknown[] = [];
for (const provider of ["anthropic", "cursor"]) {
	for (const mode of ["default", "ask", "plan", "auto"]) {
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		const h = harness([], true, provider);
		await h.commands.get(mode)!.handler("", h.ctx);
		const out = (await h.handlers.get("before_agent_start")![0]({}, h.ctx)) as { message: { content: string } };
		contexts.push({ provider, mode, content: out.message.content });
		await h.handlers.get("session_shutdown")?.[0]?.({}, h.ctx);
	}
}
delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;

process.chdir(savedCwd);
rmSync(root, { recursive: true, force: true });
const output = `${JSON.stringify({ safety, todos, cleaned, doneTexts, targets, outside: placeholders(outside), gate, todo, contexts }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("permission-modes golden.json is stale: run npx tsx go/internal/permissionmodes/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`permission-modes golden.json is current (${gate.length} gate cases)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`permission-modes golden.json: ${safety.length} commands, ${gate.length} gate cases`);
}
