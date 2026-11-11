// Regenerate golden.json from the TypeScript pretty-tools feature (the
// reference):
//   npx tsx go/internal/prettytools/testdata/gen-golden.ts [--check]
// It drives the real modules: config (backgrounds from aio-pretty.json and
// the theme, icons, languages), the render helpers, the bash grep guard, the
// find glob helpers, rtk/tool-routing, the FFF autocomplete provider with a
// mock finder, and registerPrettyTools with FFF missing (the path the Go port
// takes): tool metadata, read/bash/ls/find/grep execute with scripted rtk
// runs and scripted built-in tools, the renderers at several widths, the
// session_start and ctrl+shift+o handlers, and the /fff-* commands. Shiki is
// replaced by difftools/testdata/shiki-stub.mjs. Paths are written as
// @@ROOT@@.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
const agentDir = join(root, "agent");
const home = join(root, "home");
const work = join(root, "work");
for (const dir of [agentDir, home, work]) mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = home;
for (const key of Object.keys(process.env)) if (key.startsWith("PRETTY_")) delete process.env[key];
Object.defineProperty(process.stdout, "columns", { value: 104, configurable: true });
Object.defineProperty(process.stderr, "columns", { value: 104, configurable: true });
process.chdir(work);

register(pathToFileURL(join(here, "hooks.mjs")).href);

const config = await import(join(repo, "pretty-tools", "config.ts"));
const helpers = await import(join(repo, "pretty-tools", "helpers.ts"));
const render = await import(join(repo, "pretty-tools", "render.ts"));
const guard = await import(join(repo, "pretty-tools", "grep-guard.ts"));
const bashTool = await import(join(repo, "pretty-tools", "tools", "bash.ts"));
const findGlob = await import(join(repo, "pretty-tools", "find-glob.ts"));
const routing = await import(join(repo, "rtk", "tool-routing.ts"));
const autocomplete = await import(join(repo, "pretty-tools", "autocomplete.ts"));
const prettyIndex = await import(join(repo, "pretty-tools", "index.ts"));

function parseJSON<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`cannot parse ${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const clone = <T>(value: T): T => parseJSON<T>(JSON.stringify(value), "a cloned value");
function ph<T>(value: T): T {
	if (value === undefined) return value;
	return parseJSON<T>(JSON.stringify(value).split(root).join("@@ROOT@@"), "a placeholder substitution");
}
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const ROLE_CODES = parseJSON<{ roleCodes: Record<string, number> }>(
	readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8"),
	"chrome golden",
).roleCodes;
/** 24-bit background colors the "rgb" test theme's getBgAnsi returns. Shared with the Go test. */
const BG_RGB: Record<string, string> = { toolSuccessBg: "20;30;25", toolErrorBg: "40;20;20" };
const code = (role: string) => ROLE_CODES[role] ?? 37;
const baseTheme = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${code(role) + 10}m${text}\x1b[49m`,
};
const themes: Record<string, Record<string, unknown>> = {
	// getBgAnsi returns 24-bit colors and throws for unknown roles.
	rgb: {
		...baseTheme,
		getBgAnsi: (role: string) => {
			if (!BG_RGB[role]) throw new Error(`Unknown theme color: ${role}`);
			return `\x1b[48;2;${BG_RGB[role]}m`;
		},
	},
	// No getBgAnsi; bg is an SGR code, which is not a 24-bit color.
	sgr: { ...baseTheme },
	// Neither getBgAnsi nor bg: the backgrounds stay as they are.
	none: { fg: baseTheme.fg, bold: baseTheme.bold },
};
const theme = themes.rgb;

// ---------------------------------------------------------------------------
// config.ts: backgrounds (a sequence, because they are module state)
// ---------------------------------------------------------------------------

const configDirs = join(root, "configs");
const bgSteps: Array<{ config: string | null; theme: string; base?: string; error?: string }> = [
	{ config: null, theme: "none" },
	{ config: null, theme: "sgr" },
	{ config: null, theme: "rgb" },
	{ config: null, theme: "none" },
	{ config: '{"background":{"tool":"#102030"}}', theme: "rgb" },
	{ config: '{"background":{"tool":"#102030","error":"#300000"}}', theme: "none" },
	{ config: '{"background":{"tool":"102030","error":"nothex"}}', theme: "rgb" },
	{ config: '{"background":{"tool":"#12345","error":"#300000"}}', theme: "sgr" },
	{ config: '{"background":{"error":"#300000"}}', theme: "rgb" },
	{ config: "{not json", theme: "rgb" },
	{ config: '{"background":{"tool":"#ABCDEF"}}', theme: "sgr" },
	{ config: '{"other":true}', theme: "none" },
	{ config: null, theme: "rgb" },
];
for (const [i, step] of bgSteps.entries()) {
	const dir = join(configDirs, String(i));
	mkdirSync(dir, { recursive: true });
	if (step.config !== null) writeFileSync(join(dir, "aio-pretty.json"), step.config);
	process.env.PRETTY_CONFIG_DIR = dir;
	config.resolveBaseBackground(themes[step.theme]);
	step.base = config.BG_BASE;
	step.error = config.BG_ERROR;
}
// Renders below use the rgb theme and no aio-pretty.json.
process.env.PRETTY_CONFIG_DIR = join(configDirs, "0");
config.resolveBaseBackground(theme);

const iconPaths = ["a.ts", "b.TSX", "c.js", "Makefile", "Dockerfile", "README.md", "readme.MD", "package.json", ".gitignore", ".env", "x.env", "LICENSE", "license.txt", "noext", "dir/sub/x.go", "y.lock", "z.unknown", "a.b.c.py", ".hidden"];
const icons = iconPaths.map((path) => ({ path, out: config.fileIcon(path) }));
const langPaths = [...iconPaths, "x.h", "x.hpp", "x.less", "x.jsonc", "x.mdx", "GNUmakefile", "gnumakefile", "x.zig", "x.nim", "x.elixir", "x.yml", "x.sh", "x.zsh", "x.vue", "x.svelte", "x.graphql", "x.dockerfile", "x.makefile"];
const langs = langPaths.map((path) => ({ path, out: config.detectLang(path) ?? null }));

// ---------------------------------------------------------------------------
// render.ts and helpers.ts
// ---------------------------------------------------------------------------

const contrastParams = ["30", "90", "38;5;0", "38;5;8", "38;5;9", "38;2;0;0;0", "38;2;100;100;100", "38;2;60;60;60", "38;2;255;0;0", "38;2;1;2", "38;2;a;b;c", "1", "", "38;2;30;30;30"];
const contrast = contrastParams.map((params) => ({ params, out: render.isLowContrastShikiFg(params) }));
const boxInputs = [
	"plain",
	"\x1b[0mreset\x1b[m",
	"\x1b[31;42mred on green\x1b[49m",
	"\x1b[38;2;1;2;3;48;2;4;5;6mrgb\x1b[0m",
	"\x1b[38;5;9;48;5;1mx\x1b[39m",
	"\x1b[1;4;103mbright\x1b[22m",
	"\x1b[48;2;1;2;3m",
	"\x1b[38mbad\x1b[48mbad",
	"\x1b[;1m",
];
const box = boxInputs.map((input) => ({ input, out: render.preserveBoxBackground(input) }));
const fillInputs = ["", "one", " indented", "\x1b[31m red\x1b[39m", "a\nb\n", "wide 漢字 text that is long enough to be truncated at small widths", "\x1b[2m dim lead"];
const fills: unknown[] = [];
for (const text of fillInputs) {
	for (const width of [undefined, 1, 8, 30]) {
		for (const bg of [undefined, "", "\x1b[48;2;9;9;9m"]) {
			fills.push({ text, width: width ?? null, bg: bg ?? null, out: render.fillToolBackground(text, bg, width) });
		}
	}
}
const shortPaths = [
	{ cwd: work, home, p: "" },
	{ cwd: work, home, p: "src/a.ts" },
	{ cwd: work, home, p: join(work, "src", "b.ts") },
	{ cwd: work, home, p: work },
	{ cwd: work, home, p: join(home, "notes", "x.md") },
	{ cwd: work, home, p: "/etc/hosts" },
	{ cwd: work, home: "", p: "/etc/hosts" },
	{ cwd: work, home, p: "../sibling/x" },
].map((c) => ({ ...c, out: helpers.shortPath(c.cwd, c.home, c.p) }));
const elapsed = [undefined, 0, 0.4, 12.5, 999.4, 999.6, 1000, 1534, 9949, 9951, 10000, 12345, Number.NaN, Number.POSITIVE_INFINITY].map((ms) => ({ ms: ms === undefined || !Number.isFinite(ms) ? String(ms) : ms, out: helpers.formatElapsedMs(ms) }));
const chars = [undefined, 0, -3, 1, 999, 1000, 1049, 1050, 9999, 10000, 10499, 10500, 123456, Number.NaN].map((n) => ({ n: n === undefined || !Number.isFinite(n) ? String(n) : n, out: helpers.formatCharCount(n) }));
const exitTexts = ["", "Command exited with code 2", "exit code: 3", "Process exited with 5", "exit status 7", "bash: foo: command not found", "ls: x: No such file or directory", "EXIT CODE 9 here", "all good"];
const exitCodes = exitTexts.flatMap((text) => [null, 0, 1].map((fallback) => ({ text, fallback, out: helpers.inferBashExitCode(text, fallback) })));
const stripTexts = ["a\nCommand exited with code 1\nb", "  command exited with code 12  ", "x\r\ny\rz", "Command exited with code 1 extra"];
const strips = stripTexts.map((text) => ({ text, out: helpers.stripBashExitStatusLine(text) }));
const compactTexts = ["", "  \n\nerror\n\n\nnext\n \n", "a\r\n\r\n\r\nb", "\n\none\n"];
const compacts = compactTexts.map((text) => ({ text, out: helpers.compactErrorLines(text) }));
const treeTexts = ["", "a.ts\nsrc/\nREADME.md\n", "  spaced/  \n\nx.json", "only/"];
const trees = treeTexts.map((text) => ({ text, out: render.renderTree(text, ".") }));
const findTexts = ["", "a.ts", "src/a.ts\nsrc/b.ts\nlib/c.go\nsrc/d.ts\n", " ./x/y.md \n/abs/z"];
const findRenders = findTexts.flatMap((text) => [
	{ text, theme: true, out: render.renderFindResults(text, theme) },
	{ text, theme: false, out: render.renderFindResults(text) },
]);
const grepTexts = [
	["", "x"],
	["src/a.ts:3:const Foo = foo;\nsrc/a.ts-4-ctx\n--\nsrc/b.ts:10:FOO bar foo", "foo"],
	["no match format\nfile.txt:1:x", ""],
	["a:1:İstanbul ı", "i"],
	["a.go-12-ctx before\r\na.go:13:hit hit", "hit"],
] as const;
const grepRenders = grepTexts.map(([text, pattern]) => ({ text, pattern, out: render.renderGrepResults(text, pattern) }));
const fileContents: Array<{ content: string; path: string; maxLines?: number; width: number; out?: string }> = [
	{ content: "const a = 1;\n// note\nconst b = 2;", path: "x.ts", width: 40 },
	{ content: "const a = 1;\r\nconst longer = 'a value that will need truncation';", path: "x.ts", width: 20 },
	{ content: "def f():\n    return 1", path: "x.py", width: 40 },
	{ content: "plain text\nline two", path: "notes.txt", width: 8 },
	{ content: "", path: "x.ts", width: 40 },
	{ content: "a\nb\nc\nd", path: "x.ts", maxLines: 2, width: 40 },
	{ content: "\tindented()", path: "x.go", width: 6 },
];
for (const c of fileContents) c.out = await render.renderFileContent(c.content, c.path, 0, c.maxLines, c.width);
const metricsInputs: Array<Record<string, unknown> | undefined> = [undefined, {}, { __prettyElapsedMs: 12.4 }, { __prettyOutputChars: 1534 }, { __prettyElapsedMs: 1534, __prettyOutputChars: 12 }];
const metrics = metricsInputs.map((details) => ({ details: details ?? null, out: render.renderToolMetrics({ content: [], details } as never), duration: render.renderToolDuration({ content: [], details } as never) }));

// ---------------------------------------------------------------------------
// grep-guard.ts and the bash guard message
// ---------------------------------------------------------------------------

const guardCommands = [
	"", "ls -la", "grep -r foo .", "cat log.txt | grep error", "sudo grep foo /etc/hosts", "sudo -n grep foo file",
	"egrep -n foo file", "fgrep foo file", "ggrep foo file", "/usr/bin/grep foo file", "FOO=bar grep foo file",
	"ls && grep foo", "ls; grep foo", "ls || grep foo", "echo $(grep foo file)", "bash -c \"grep foo file\"",
	"find . -name x | xargs grep foo", "env -u X grep foo", "git grep foo", "git log --grep foo", "pgrep -fl node",
	"cat greplog.txt", "echo \"grep is a tool\"", "echo \"a; grep b\"", "cat <<'EOF' | grep foo\nbody\nEOF",
	"cat > x.mts <<'EOF'\nconsole.log(f(`rg 'a|grep -r' .`));\nEOF\nnpx tsx x.mts",
	"rg -n foo", "rg -rn \"sveltos\" x.tf", "rg -irn foo .", "rg foo src -rn", "rtk rg -rl foo", "cd x && /opt/bin/rg -rni foo | head",
	"rg -n 'a|grep -r' .", "rg -n \"x|grep\" src", "rg -r '$1' foo", "rg pat -r X", "rg --replace=n foo", "rg -e -rn foo",
	"rg --glob -rn foo", "rg --glob=x -rn foo", "rg -A2 -rn foo", "rg -A -rn foo", "rg -- -rn foo", "rg -r1 foo", "rg -nr foo",
	"rg -", "echo 'unbalanced", "source x.sh", "nice -n 5 grep x", "time grep x", "command grep x", "xargs -0 egrep x",
];
const guards = guardCommands.map((command) => ({
	command,
	gnu: guard.findGnuGrepInvocation(command) ?? null,
	misuse: guard.findRgReplaceMisuse(command) ?? null,
	message: bashTool.grepGuardMessage(command) ?? null,
}));

const globPatterns = ["", "  ", "*.ts", "**/*", "src/*.ts", "**/x", "name.txt", "a?c", "[ab].go", " *.md ", "dir/"];
const globs = globPatterns.map((pattern) => ({ pattern, normalized: findGlob.normalizeFindGlobPattern(pattern), likely: findGlob.isLikelyGlobPattern(pattern) }));

// ---------------------------------------------------------------------------
// rtk/tool-routing.ts
// ---------------------------------------------------------------------------

const truncInputs: Array<{ text: string; maxLines?: number; maxBytes?: number }> = [
	{ text: "" },
	{ text: "a\r\nb\rc\n\n" },
	{ text: Array.from({ length: 2005 }, (_, i) => `line ${i}`).join("\n") },
	{ text: "x".repeat(60 * 1024) },
	{ text: "é".repeat(30) + "\n" + "ü".repeat(30), maxBytes: 70 },
	{ text: "one\ntwo\nthree", maxLines: 2 },
	{ text: "🙂🙂\nb", maxBytes: 9 },
];
const truncations = truncInputs.map((c) => ({ ...c, maxLines: c.maxLines ?? null, maxBytes: c.maxBytes ?? null, out: routing.truncateRtkOutput(c.text, c.maxLines, c.maxBytes) }));
const limitInputs = [["", 3], ["a\nb\nc\n", 2], ["a\r\nb", 0], ["a\nb", -1], ["a\nb\n\n", 5]] as const;
const limits = limitInputs.map(([text, limit]) => ({ text, limit, out: routing.limitRtkLines(text, limit) }));
const requireInputs = [
	{ result: { stdout: "", stderr: "", code: 0, killed: false } },
	{ result: { stdout: "", stderr: "", code: 1, killed: false } },
	{ result: { stdout: "", stderr: "", code: 1, killed: false }, accepted: [0, 1] },
	{ result: { stdout: "out\n", stderr: "  err  ", code: 2, killed: false } },
	{ result: { stdout: " only out ", stderr: "", code: 2, killed: false } },
	{ result: { stdout: "", stderr: "", code: 0, killed: true } },
];
const requires = requireInputs.map((c) => {
	try {
		routing.requireRtkSuccess("grep", c.result, c.accepted);
		return { ...c, accepted: c.accepted ?? null, error: null };
	} catch (error) {
		return { ...c, accepted: c.accepted ?? null, error: (error as Error).message };
	}
});

// ---------------------------------------------------------------------------
// autocomplete.ts with a mock finder
// ---------------------------------------------------------------------------

type FinderMode = "none" | "ok" | "empty" | "fail" | "throw";
const finderItems = [
	{ relativePath: "src/app.ts", fileName: "app.ts" },
	{ relativePath: "docs/my notes.md", fileName: "my notes.md" },
	{ relativePath: 'q/"quoted" file.txt', fileName: '"quoted" file.txt' },
	{ relativePath: "top.json", fileName: "top.json" },
];
const acInputs: Array<{ lines: string[]; line: number; col: number; finder: FinderMode }> = [
	{ lines: ["hello @sr"], line: 0, col: 9, finder: "ok" },
	{ lines: ["@"], line: 0, col: 1, finder: "ok" },
	{ lines: ["no mention"], line: 0, col: 10, finder: "ok" },
	{ lines: ["mail@host"], line: 0, col: 9, finder: "ok" },
	{ lines: ["a\t@x y"], line: 0, col: 4, finder: "ok" },
	{ lines: ["first", "x @do"], line: 1, col: 5, finder: "ok" },
	{ lines: ["x @do"], line: 0, col: 5, finder: "none" },
	{ lines: ["x @do"], line: 0, col: 5, finder: "empty" },
	{ lines: ["x @do"], line: 0, col: 5, finder: "fail" },
	{ lines: ["x @do"], line: 0, col: 5, finder: "throw" },
	{ lines: ["x @a@b"], line: 0, col: 6, finder: "ok" },
	{ lines: [], line: 3, col: 0, finder: "ok" },
];
const acCases: unknown[] = [];
for (const c of acInputs) {
	const calls: unknown[] = [];
	const current = {
		getSuggestions: async (lines: string[], line: number, col: number) => {
			calls.push({ fn: "getSuggestions", lines, line, col });
			return { items: [{ value: "native", label: "native" }], prefix: "native" };
		},
		applyCompletion: (lines: string[], line: number, col: number, item: unknown, prefix: string) => {
			calls.push({ fn: "applyCompletion", lines, line, col, item, prefix });
			return { lines: ["applied"], cursorLine: 0, cursorCol: 7 };
		},
		shouldTriggerFileCompletion: (lines: string[], line: number, col: number) => {
			calls.push({ fn: "shouldTrigger", lines, line, col });
			return line === 0;
		},
	};
	const searches: unknown[] = [];
	const finder = c.finder === "none" ? null : {
		fileSearch: (query: string, options: unknown) => {
			searches.push({ query, options });
			if (c.finder === "throw") throw new Error("boom");
			if (c.finder === "fail") return { ok: false, error: "nope" };
			return { ok: true, value: { items: c.finder === "empty" ? [] : finderItems } };
		},
	};
	const provider = autocomplete.createFffAutocompleteProvider(current as never, () => finder as never);
	const suggestions = await provider.getSuggestions(c.lines, c.line, c.col, { signal: new AbortController().signal });
	acCases.push({ ...c, suggestions, delegated: calls.length > 0, searches });
}

// ---------------------------------------------------------------------------
// registerPrettyTools with FFF missing
// ---------------------------------------------------------------------------

type ScriptStep = { result?: Record<string, unknown>; throw?: string };
type Harness = {
	tools: Map<string, any>;
	commands: Map<string, any>;
	shortcuts: Map<string, any>;
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	execScript: ScriptStep[];
	execCalls: unknown[];
	sdkScript: ScriptStep[];
	sdkCalls: unknown[];
};
const SDK_DESCRIPTIONS: Record<string, string> = {
	read: "Read the contents of a file.",
	bash: "Execute a bash command in the current working directory.",
	ls: "List directory contents.",
	find: "Search for files by glob pattern.",
	grep: "Search file contents for a pattern.",
};
const SDK_PARAMETERS = { type: "object", properties: { path: { type: "string" } } };

async function makeHarness(): Promise<Harness> {
	const h: Harness = { tools: new Map(), commands: new Map(), shortcuts: new Map(), handlers: new Map(), execScript: [], execCalls: [], sdkScript: [], sdkCalls: [] };
	const sdkTool = (name: string) => ({
		name,
		description: SDK_DESCRIPTIONS[name],
		parameters: SDK_PARAMETERS,
		async execute(tid: string, params: unknown, _sig: unknown, _upd: unknown, ctx: { cwd: string }) {
			h.sdkCalls.push({ tool: name, tid, params: clone(params), cwd: ctx.cwd });
			const step = h.sdkScript.shift() ?? { result: { content: [{ type: "text", text: "ok" }], details: {} } };
			if (step.throw) throw new Error(step.throw);
			return clone(step.result);
		},
	});
	const pi = {
		registerTool: (tool: any) => h.tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => h.commands.set(name, command),
		registerShortcut: (key: string, shortcut: any) => h.shortcuts.set(key, shortcut),
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			const list = h.handlers.get(name) ?? [];
			list.push(handler);
			h.handlers.set(name, list);
		},
		exec: async (command: string, args: string[], options: { cwd?: string }) => {
			h.execCalls.push({ command, args, cwd: options?.cwd ?? null });
			const step = h.execScript.shift() ?? { throw: "spawn rtk ENOENT" };
			if (step.throw) throw new Error(step.throw);
			return { stdout: "", stderr: "", code: 0, killed: false, ...step.result };
		},
	};
	await prettyIndex.default(pi as never, {
		sdk: {
			getAgentDir: () => agentDir,
			createReadToolDefinition: () => sdkTool("read"),
			createBashToolDefinition: () => sdkTool("bash"),
			createLsToolDefinition: () => sdkTool("ls"),
			createFindToolDefinition: () => sdkTool("find"),
			createGrepToolDefinition: () => sdkTool("grep"),
		},
	});
	return h;
}

// Tool metadata under PRETTY_DISABLE_TOOLS variants.
const registrations: unknown[] = [];
for (const disabled of [undefined, "bash", " READ , Bash ,", "ls,find,grep"]) {
	if (disabled === undefined) delete process.env.PRETTY_DISABLE_TOOLS;
	else process.env.PRETTY_DISABLE_TOOLS = disabled;
	const h = await makeHarness();
	registrations.push({
		disabled: disabled ?? null,
		tools: [...h.tools.values()].map((t) => ({
			name: t.name, label: t.label, description: t.description, promptSnippet: t.promptSnippet ?? null,
			promptGuidelines: t.promptGuidelines ?? null, renderShell: t.renderShell, parameters: t.parameters,
		})),
		commands: [...h.commands.entries()].map(([name, c]) => ({ name, description: c.description })),
		shortcuts: [...h.shortcuts.entries()].map(([key, s]) => ({ key, description: s.description })),
		events: [...h.handlers.keys()],
	});
}
delete process.env.PRETTY_DISABLE_TOOLS;
const h = await makeHarness();

// Lifecycle: session_start, ctrl+shift+o, and the /fff-* commands.
function uiRecorder(mode: string) {
	const calls: unknown[] = [];
	const ctx = {
		mode,
		cwd: work,
		hasUI: mode !== "print",
		ui: {
			setToolsExpanded: (value: boolean) => calls.push({ fn: "setToolsExpanded", value }),
			notify: (message: string, level: string) => calls.push({ fn: "notify", message, level }),
			setStatus: (key: string, value: unknown) => calls.push({ fn: "setStatus", key, value: value ?? null }),
			addAutocompleteProvider: () => calls.push({ fn: "addAutocompleteProvider" }),
		},
	};
	return { ctx, calls };
}
const lifecycle: unknown[] = [];
for (const mode of ["tui", "rpc", "print"]) {
	for (const step of ["session_start", "shortcut", "fff-health", "fff-rescan", "session_shutdown"]) {
		const { ctx, calls } = uiRecorder(mode);
		if (step === "session_start" || step === "session_shutdown") {
			for (const handler of h.handlers.get(step) ?? []) await handler({ type: step }, ctx);
		} else if (step === "shortcut") {
			await h.shortcuts.get("ctrl+shift+o").handler(ctx);
		} else {
			await h.commands.get(step).handler("", ctx);
		}
		await settle();
		lifecycle.push({ mode, step, calls });
	}
}

// Execute cases.
const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text", text }], details });
type ExecCase = { tool: string; label: string; params: Record<string, unknown>; exec?: ScriptStep[]; sdk?: ScriptStep[]; env?: Record<string, string>; out?: unknown };
const rtkRead = (lines: string[]) => ({ result: { stdout: lines.map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`).join("\n") + "\n" } });
const execCases: ExecCase[] = [
	{ tool: "read", label: "rtk", params: { path: "src/a.ts" }, exec: [rtkRead(["const a = 1;", "", "const b = 2;"])] },
	{ tool: "read", label: "rtk-offset-limit", params: { path: "src/a.ts", offset: 2, limit: 2 }, exec: [rtkRead(["one", "two", "three", "four"])] },
	{ tool: "read", label: "rtk-offset-zero", params: { path: "a.txt", offset: 0, limit: 0 }, exec: [rtkRead(["one", "two"])] },
	{ tool: "read", label: "rtk-pipe-crlf", params: { path: "a.txt" }, exec: [{ result: { stdout: "1 | alpha\r\n  2 |beta\r\nnoise line\n10 │ ten\n" } }] },
	{ tool: "read", label: "rtk-empty", params: { path: "empty.txt" }, exec: [{ result: { stdout: "" } }] },
	{ tool: "read", label: "rtk-fails", params: { path: "missing.txt" }, exec: [{ result: { code: 1, stderr: "Error: No such file\n" } }] },
	{ tool: "read", label: "rtk-killed", params: { path: "slow.txt" }, exec: [{ result: { code: 0, killed: true } }] },
	{ tool: "read", label: "rtk-throws", params: { path: "a.txt", offset: 3 }, exec: [{ throw: "spawn rtk ENOENT" }], sdk: [{ result: textResult("x\r\ny", { truncation: { truncated: false } }) }] },
	{ tool: "read", label: "image", params: { path: "pic.PNG" }, sdk: [{ result: { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "aGk=", mimeType: "image/png" }], details: undefined } }] },
	{ tool: "read", label: "image-text-only", params: { path: "pic.jpeg" }, sdk: [{ result: textResult("not an image after all") }] },
	{ tool: "read", label: "sdk-throws", params: { path: "x.gif" }, sdk: [{ throw: "EACCES: permission denied" }] },
	{ tool: "read", label: "missing-path", params: {}, exec: [rtkRead(["?"])] },
	{ tool: "bash", label: "ok", params: { command: "echo hi" }, sdk: [{ result: textResult("hi\n", { truncation: null }) }] },
	{ tool: "bash", label: "no-details", params: { command: "true" }, sdk: [{ result: { content: [{ type: "text", text: "" }] } }] },
	{ tool: "bash", label: "grep-blocked", params: { command: "cat x | grep foo" } },
	{ tool: "bash", label: "rg-rn-blocked", params: { command: "rg -rn foo ." } },
	{ tool: "bash", label: "guard-off", params: { command: "grep foo" }, env: { PRETTY_BASH_GREP_GUARD: "Off" }, sdk: [{ result: textResult("foo\n") }] },
	{ tool: "bash", label: "guard-zero", params: { command: "grep foo" }, env: { PRETTY_BASH_GREP_GUARD: "0" }, sdk: [{ result: textResult("foo\n") }] },
	{ tool: "bash", label: "guard-yes", params: { command: "grep foo" }, env: { PRETTY_BASH_GREP_GUARD: "yes" } },
	{ tool: "bash", label: "throws", params: { command: "exit 3", timeout: 5 }, sdk: [{ throw: "Command exited with code 3\nboom" }] },
	{ tool: "bash", label: "multi-text", params: { command: "x" }, sdk: [{ result: { content: [{ type: "text", text: "a\r\nb" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "c" }], details: { keep: 1 } } }] },
	{ tool: "ls", label: "rtk", params: { path: "src" }, exec: [{ result: { stdout: "a.ts\nlib/\n\nb.go\n" } }] },
	{ tool: "ls", label: "rtk-limit", params: { limit: 2 }, exec: [{ result: { stdout: "a\nb\nc\n" } }] },
	{ tool: "ls", label: "rtk-limit-zero", params: { limit: 0 }, exec: [{ result: { stdout: "a\nb\n" } }] },
	{ tool: "ls", label: "rtk-empty", params: {}, exec: [{ result: { stdout: "" } }] },
	{ tool: "ls", label: "rtk-fails", params: { path: "nope" }, exec: [{ result: { code: 2, stderr: "ls: nope: No such file or directory" } }] },
	{ tool: "ls", label: "sdk", params: { path: "." }, exec: [{ throw: "spawn rtk ENOENT" }], sdk: [{ result: textResult(" a.ts\nb/ \n", { entryLimitReached: 500 }) }] },
	{ tool: "find", label: "rtk", params: { pattern: "*.ts" }, exec: [{ result: { stdout: "./  a.ts b.ts\nsrc/ c.ts\n\n2 files\n" } }] },
	{ tool: "find", label: "rtk-path-limit", params: { pattern: "src/lib/*.go", path: "repo", limit: 2 }, exec: [{ result: { stdout: "repo/src/lib/ x.go y.go z.go\n" } }] },
	{ tool: "find", label: "rtk-absolute", params: { pattern: "/etc/**/hosts" }, exec: [{ result: { stdout: "no structured lines\nsecond" } }] },
	{ tool: "find", label: "rtk-dot-slash", params: { pattern: "./docs/*.md", limit: 0 }, exec: [{ result: { stdout: "docs/ a.md\n" } }] },
	{ tool: "find", label: "rtk-empty", params: { pattern: "*.none" }, exec: [{ result: { stdout: "" } }] },
	{ tool: "find", label: "rtk-fails", params: { pattern: "*.ts" }, exec: [{ result: { code: 1, stderr: "" } }] },
	{ tool: "find", label: "wildcard-dir", params: { pattern: "src/*/x.ts" }, sdk: [{ result: textResult("src/a/x.ts\nsrc/b/x.ts", { notices: ["prior"] }) }] },
	{ tool: "find", label: "wildcard-dir-bad-notices", params: { pattern: "a?/x" }, sdk: [{ result: textResult("", { notices: "not-array" }) }] },
	{ tool: "find", label: "rtk-throws", params: { pattern: "**/*.md" }, exec: [{ throw: "spawn rtk ENOENT" }], sdk: [{ result: textResult("a.md\n") }] },
	{ tool: "find", label: "missing-pattern", params: {}, exec: [{ result: { stdout: "./ x\n" } }] },
	{ tool: "grep", label: "rtk", params: { pattern: "foo|bar" }, exec: [{ result: { stdout: "src/a.ts:1:foo\r\nsrc/b.ts:9:bar\n" } }] },
	{ tool: "grep", label: "rtk-all-flags", params: { pattern: "x", path: "src", glob: "*.ts", context: 2, limit: 5, literal: true, ignoreCase: true }, exec: [{ result: { stdout: "" } }] },
	{ tool: "grep", label: "rtk-case-alias", params: { pattern: "x", caseInsensitive: true, limit: 0, context: 0 }, exec: [{ result: { code: 1 } }] },
	{ tool: "grep", label: "rtk-fails", params: { pattern: "(" }, exec: [{ result: { code: 2, stderr: "grep: parentheses not balanced" } }] },
	{ tool: "grep", label: "rtk-truncated", params: { pattern: "l" }, exec: [{ result: { stdout: Array.from({ length: 2003 }, (_, i) => `f.txt:${i + 1}:l`).join("\n") } }] },
	{ tool: "grep", label: "sdk", params: { pattern: "foo" }, exec: [{ throw: "spawn rtk ENOENT" }], sdk: [{ result: { content: [{ type: "text", text: "a.ts:1:foo\r\nb.ts:2:foo\r" }, { type: "text", text: "c" }], details: { matchLimitReached: 100 } } }] },
	{ tool: "grep", label: "sdk-no-text", params: { pattern: "foo" }, exec: [{ throw: "x" }], sdk: [{ result: { content: [], details: null } }] },
];
for (const c of execCases) {
	h.execScript = clone(c.exec ?? []);
	h.sdkScript = clone(c.sdk ?? []);
	h.execCalls = [];
	h.sdkCalls = [];
	for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
	let out: Record<string, unknown>;
	try {
		const result = await h.tools.get(c.tool).execute(`call-${c.label}`, clone(c.params), undefined, undefined, { cwd: work });
		const details = result.details ? { ...result.details } : result.details;
		if (details && typeof details.__prettyElapsedMs === "number") details.__prettyElapsedMs = "ELAPSED";
		out = { content: result.content, isError: result.isError ?? false, details: details ?? null };
	} catch (error) {
		out = { error: (error as Error).message };
	}
	for (const k of Object.keys(c.env ?? {})) delete process.env[k];
	c.out = { ...out, execCalls: h.execCalls, sdkCalls: h.sdkCalls };
}

// Renderers.
const WIDTHS = [24, 60, 104, 150];
async function renderLines(component: any, width: number): Promise<string[]> {
	component.render(width);
	await settle();
	return component.render(width);
}
type RenderCase = { tool: string; phase: "call" | "result"; label: string; args?: unknown; result?: unknown; ctx: { expanded: boolean; isError: boolean }; width: number; out?: string[]; text?: string };
const renderCases: RenderCase[] = [];
const ctxs = [
	{ expanded: false, isError: false },
	{ expanded: true, isError: false },
	{ expanded: false, isError: true },
];
const callArgs: Array<{ tool: string; label: string; args: Record<string, unknown> }> = [
	{ tool: "read", label: "path", args: { path: "src/a.ts", offset: 3 } },
	{ tool: "bash", label: "short", args: { command: "ls -la" } },
	{ tool: "bash", label: "timeout", args: { command: "sleep 1", timeout: 30 } },
	{ tool: "bash", label: "empty", args: {} },
	{ tool: "bash", label: "long", args: { command: `echo ${"word ".repeat(40)}` } },
	{ tool: "ls", label: "default", args: {} },
	{ tool: "ls", label: "home", args: { path: join(home, "proj"), limit: 20 } },
	{ tool: "ls", label: "empty-path", args: { path: "" } },
	{ tool: "find", label: "pattern", args: { pattern: "*.ts", path: "src", limit: 10 } },
	{ tool: "find", label: "missing", args: {} },
	{ tool: "grep", label: "all", args: { pattern: "TODO", path: join(work, "src"), glob: "*.go", limit: 3, literal: true, ignoreCase: true } },
	{ tool: "grep", label: "missing", args: { caseInsensitive: true } },
	{ tool: "grep", label: "empty-pattern", args: { pattern: "", path: "." } },
];
for (const a of callArgs) {
	for (const ctx of ctxs) {
		for (const width of WIDTHS) {
			const component = h.tools.get(a.tool).renderCall(clone(a.args), theme, { ...ctx, state: {}, lastComponent: undefined });
			const out = await renderLines(component, width);
			renderCases.push({ tool: a.tool, phase: "call", label: a.label, args: a.args, ctx, width, out, text: component.text });
		}
	}
}
const withTiming = (details: Record<string, unknown>, ms = 1534, chars = 2048) => ({ ...details, __prettyElapsedMs: ms, __prettyOutputChars: chars });
const resultSets: Array<{ tool: string; label: string; result: Record<string, unknown> }> = [
	{ tool: "read", label: "file", result: { content: [{ type: "text", text: "const a = 1;\n// note\n\tconst b = 'a long value that is wide enough to be truncated at narrow widths';" }], details: withTiming({ _type: "readFile", filePath: "src/a.ts", content: "const a = 1;\n// note\n\tconst b = 'a long value that is wide enough to be truncated at narrow widths';", offset: 4, lineCount: 3 }) } },
	{ tool: "read", label: "file-many", result: { content: [{ type: "text", text: "x" }], details: { _type: "readFile", filePath: join(home, "n.py"), content: Array.from({ length: 12 }, (_, i) => `v${i} = ${i}`).join("\n"), offset: 0, lineCount: 12 } } },
	{ tool: "read", label: "skill", result: { content: [{ type: "text", text: "x" }], details: { _type: "readFile", filePath: join(work, "skills", "deploy", "SKILL.md"), content: "---\nname: 'Ship It'\ndescription: x\n---\nbody", offset: 0, lineCount: 5 } } },
	{ tool: "read", label: "skill-no-front", result: { content: [{ type: "text", text: "x" }], details: { _type: "readFile", filePath: "tools/review/SKILL.md", content: "# Review\nbody", offset: 0, lineCount: 2 } } },
	{ tool: "read", label: "skill-empty-name", result: { content: [{ type: "text", text: "x" }], details: { _type: "readFile", filePath: "a/b/SKILL.md", content: "---\nname: \"\"\n---", offset: 0, lineCount: 3 } } },
	{ tool: "read", label: "image", result: { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "aGk=", mimeType: "image/png" }], details: { _type: "readImage", filePath: "pic.png" } } },
	{ tool: "read", label: "image-no-note", result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], details: { _type: "readImage", filePath: "pic.png" } } },
	{ tool: "read", label: "error", result: { content: [{ type: "text", text: "ENOENT: no such file\n\n\nretry" }], details: null } },
	{ tool: "read", label: "no-details", result: { content: [{ type: "text", text: "y".repeat(130) }], details: null } },
	{ tool: "read", label: "empty-content", result: { content: [], details: { _type: "readFile", filePath: "e.txt", content: "", offset: 0, lineCount: 0 } } },
	{ tool: "bash", label: "ok", result: { content: [{ type: "text", text: "line one\nline two\nCommand exited with code 0" }], details: withTiming({ _type: "bashResult", text: "line one\nline two\nCommand exited with code 0", exitCode: 0, command: "x" }, 12.4) } },
	{ tool: "bash", label: "fail", result: { content: [{ type: "text", text: "err\n\n\nmore" }], details: { _type: "bashResult", text: "err\n\n\nmore", exitCode: 2, command: "x" } } },
	{ tool: "bash", label: "sdk-plain", result: { content: [{ type: "text", text: "plain out\nexit code: 4" }], details: withTiming({}, 20000) } },
	{ tool: "bash", label: "sdk-empty", result: { content: [{ type: "text", text: "" }], details: {} } },
	{ tool: "bash", label: "sdk-blank-lines", result: { content: [{ type: "text", text: "   \n  " }], details: { _type: "bashResult", text: "   \n  ", exitCode: null, command: "" } } },
	{ tool: "bash", label: "wide", result: { content: [{ type: "text", text: "w" }], details: { _type: "bashResult", text: `${"wide ".repeat(40)}\n\ttab`, exitCode: 0, command: "x" } } },
	{ tool: "ls", label: "entries", result: { content: [{ type: "text", text: "a.ts\nsrc/\n" }], details: withTiming({ _type: "lsResult", text: "a.ts\nsrc/\npackage.json", path: ".", entryCount: 3 }) } },
	{ tool: "ls", label: "error", result: { content: [{ type: "text", text: "boom" }], details: null } },
	{ tool: "ls", label: "empty", result: { content: [{ type: "text", text: "(empty directory)" }], details: { _type: "lsResult", text: "", path: ".", entryCount: 0 } } },
	{ tool: "ls", label: "plain", result: { content: [], details: null } },
	{ tool: "find", label: "files", result: { content: [{ type: "text", text: "x" }], details: withTiming({ _type: "findResult", text: "src/a.ts\nsrc/b.ts\nlib/c.go", pattern: "*", matchCount: 3, notices: ["Search engine: RTK find."] }, 250) } },
	{ tool: "find", label: "none", result: { content: [{ type: "text", text: "" }], details: { _type: "findResult", text: "  ", pattern: "*", matchCount: 0, notices: ["RTK could not execute; results from SDK find (fd)."] } } },
	{ tool: "find", label: "none-no-notice", result: { content: [{ type: "text", text: "" }], details: { _type: "findResult", text: "", pattern: "*", matchCount: 0 } } },
	{ tool: "find", label: "no-notices", result: { content: [{ type: "text", text: "x" }], details: { _type: "findResult", text: "a.md", pattern: "*", matchCount: 1 } } },
	{ tool: "find", label: "plain", result: { content: [{ type: "text", text: "z".repeat(130) }], details: null } },
	{ tool: "find", label: "plain-empty", result: { content: [], details: null } },
	{ tool: "grep", label: "matches", result: { content: [{ type: "text", text: "x" }], details: { _type: "grepResult", text: "src/a.ts:3:const foo = 1;\nsrc/a.ts-4-ctx\n--\nb.go:7:FOO()", pattern: "foo", matchCount: 4 } } },
	{ tool: "grep", label: "error", result: { content: [{ type: "text", text: "bad\n\n\nregex" }, { type: "text", text: "x" }], details: null } },
	{ tool: "grep", label: "empty", result: { content: [{ type: "text", text: "No matches found" }], details: { _type: "grepResult", text: "", pattern: "x", matchCount: 0 } } },
	{ tool: "grep", label: "plain", result: { content: [], details: null } },
];
for (const r of resultSets) {
	for (const ctx of ctxs) {
		for (const width of WIDTHS) {
			const component = h.tools.get(r.tool).renderResult(clone(r.result), { expanded: ctx.expanded, isPartial: false }, theme, { ...ctx, state: {}, lastComponent: undefined });
			const out = await renderLines(component, width);
			renderCases.push({ tool: r.tool, phase: "result", label: r.label, result: r.result, ctx, width, out, text: component.text });
		}
	}
}

const golden = {
	roleCodes: ROLE_CODES,
	bgRgb: BG_RGB,
	bgSteps: bgSteps.map((s, i) => ({ ...s, dir: String(i) })),
	icons,
	dirIcon: config.dirIcon(),
	langs,
	contrast,
	box,
	fills,
	shortPaths: ph(shortPaths),
	elapsed,
	chars,
	exitCodes,
	strips,
	compacts,
	trees,
	findRenders,
	grepRenders,
	fileContents,
	metrics,
	guards,
	globs,
	truncations,
	limits,
	requires,
	acCases,
	registrations: ph(registrations),
	lifecycle: ph(lifecycle),
	work: ph(work),
	home: ph(home),
	execCases: ph(execCases),
	renderCases: ph(renderCases),
};
rmSync(root, { recursive: true, force: true });

const output = `${JSON.stringify(golden, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("prettytools golden.json is stale: run npx tsx go/internal/prettytools/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	const counts = Object.entries(golden)
		.filter(([, v]) => Array.isArray(v))
		.map(([k, v]) => `${k}=${(v as unknown[]).length}`)
		.join(" ");
	console.log(`wrote ${counts}`);
}
