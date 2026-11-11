// Regenerate golden.json from the TypeScript yaml-hooks feature (the reference):
//   npx tsx go/internal/yamlhooks/testdata/gen-golden.ts [--check]
// It runs the pure loader, schema, glob, redaction, and executor functions
// on fixed inputs, real bash hooks with harmless commands, the runtime with
// a mocked host adapter, and the real registerYamlHooks through a scripted
// harness (fake pi and ctx, injected executeBash). File fixtures are built
// inside this testdata directory and removed afterwards; their path is
// written as @@ROOT@@. Every fixture operation is recorded, so the Go test
// replays the same file system steps.
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
const agentDir = join(root, "agent");
rmSync(root, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.GIT_CEILING_DIRECTORIES = root;
for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_YAML_HOOKS_") || key.startsWith("OPENCODE_")) delete process.env[key];
}
delete process.env.AIO_SUBAGENT_CHILD;

const composition = await import(join(repo, "yaml-hooks", "composition.ts"));
const unsupported = await import(join(repo, "yaml-hooks", "unsupported.ts"));
const discovery = await import(join(repo, "yaml-hooks", "discovery.ts"));
const paths = await import(join(repo, "yaml-hooks", "paths.ts"));
const pathFilter = await import(join(repo, "yaml-hooks", "path-filter.ts"));
const actions = await import(join(repo, "yaml-hooks", "actions.ts"));
const sessionState = await import(join(repo, "yaml-hooks", "session-state.ts"));
const bash = await import(join(repo, "yaml-hooks", "bash-executor.ts"));
const lineage = await import(join(repo, "yaml-hooks", "session-lineage.ts"));
const runtimeMod = await import(join(repo, "yaml-hooks", "runtime.ts"));
const envelope = await import(join(repo, "yaml-hooks", "yaml-envelope.ts"));
const registerYamlHooks = (await import(join(repo, "yaml-hooks", "index.ts"))).default;
const YAML = (await import("yaml")).default;

composition.setActiveHookPolicy(unsupported.createPiHookPolicy());

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON round trip with @@ROOT@@, pid, and time placeholders. */
function norm(value: unknown): Json {
	const text = JSON.stringify(value ?? null)
		.split(root)
		.join("@@ROOT@@")
		.replace(/pid \d+/g, "pid @@PID@@")
		.replace(/\\"ts\\":\\"[^"\\]*\\"/g, '\\"ts\\":\\"@@TIME@@\\"');
	return parseJson(text) as Json;
}

/** JSON.parse that names the failing text; the generator must stop on bad JSON. */
function parseJson(text: string): Json {
	try {
		return JSON.parse(text) as Json;
	} catch (error) {
		throw new Error(`gen-golden produced invalid JSON (${error instanceof Error ? error.message : String(error)}): ${text.slice(0, 200)}`);
	}
}

/** A JSON round trip (drops undefined members, as the golden file does). */
function clone<T>(value: T): T {
	return parseJson(JSON.stringify(value)) as T;
}

// ---- fixture operations (replayed by the Go test) ----
type FsOp =
	| { op: "write"; path: string; content: string; mode?: number }
	| { op: "rm"; path: string }
	| { op: "mkdir"; path: string }
	| { op: "symlink"; path: string; target: string }
	| { op: "git"; path: string };

function applyFs(ops: FsOp[]): void {
	for (const op of ops) {
		const p = join(root, op.path);
		switch (op.op) {
			case "write":
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, op.content);
				if (op.mode !== undefined) chmodSync(p, op.mode);
				break;
			case "rm":
				rmSync(p, { recursive: true, force: true });
				break;
			case "mkdir":
				mkdirSync(p, { recursive: true });
				break;
			case "symlink":
				mkdirSync(dirname(p), { recursive: true });
				symlinkSync(op.target.split("@@ROOT@@").join(root), p);
				break;
			case "git":
				mkdirSync(p, { recursive: true });
				execFileSync("git", ["init", "-q", p]);
				break;
		}
	}
}

function resetCaches(): void {
	discovery.__resetSnapshotCacheForTests();
	paths.__resetTrustListCacheForTests();
	lineage.resetSessionLineageCacheForTests();
}

function withEnv<T>(env: Record<string, string> | undefined, run: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		return run();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function withEnvAsync<T>(env: Record<string, string> | undefined, run: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		return await run();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Capture console.warn/info/error into records. */
function captureConsole<T>(records: unknown[], run: () => T): T {
	const saved = { warn: console.warn, info: console.info, error: console.error };
	console.warn = (text: unknown) => records.push({ op: "console", level: "warn", text: String(text) });
	console.info = (text: unknown) => records.push({ op: "console", level: "info", text: String(text) });
	console.error = (text: unknown) => records.push({ op: "console", level: "error", text: String(text) });
	try {
		return run();
	} finally {
		Object.assign(console, saved);
	}
}

const hookJson = (map: Map<string, unknown[]>) => Object.fromEntries(map);
const overrideJson = (o: any) => ({
	targetId: o.targetId,
	disable: o.disable,
	...(o.replacement ? { replacement: o.replacement } : {}),
	source: o.source,
});

// ---- YAML values ----
const yamlInputs = [
	"a: 014", "a: 0o14", "a: 0x1F", "a: +12", "a: 1e3", "a: .5", "a: yes", "a: ~", "a:", "a: 2001-12-14",
	"a: 1_000", "<<: {b: 1}", "1: x", "true: x", "a: !!str 12", "a: !!int \"12\"", "a: &x [1]\nb: *x",
	"a: 1\na: 2", "a: 1\n---\nb: 2", "", "# comment only", "[1, 2]", "a: \"\\u00e9 ✓\"", "a: 0.", "a: 1.5e+3",
	"a: NULL", "a: True", "a: tRue", "a: \"x", "hooks: [ { broken", "a: 'single ''quoted'''", "a: |\n  line1\n  line2\n",
	"a: >\n  folded\n  text\n", "nested:\n  list:\n    - {k: v, n: 2}\n    - [x, y]\n", "a: -0", "a: 12e", "x: [a, b,]",
];
const yamlValues = yamlInputs.map((yaml) => {
	const doc = YAML.parseDocument(yaml);
	if (doc.errors.length > 0) return { yaml, error: true };
	return { yaml, value: JSON.stringify(doc.toJS()) };
});

// ---- schema (loadHooksFile with the Pi policy) ----
const H = (body: string) => `hooks:\n${body}`;
const schemaInputs: Array<[string, string]> = [
	["valid hooks", H(`  - id: idle-notify\n    event: session.idle\n    actions:\n      - notify: "Agent is idle"\n  - id: guard-bash\n    event: tool.before.bash\n    action: stop\n    actions:\n      - bash: "./scripts/check.sh"\n        timeout: 5000\n`)],
	["all action forms", H(`  - id: forms\n    event: tool.after.write\n    scope: main\n    runIn: main\n    actions:\n      - bash: "echo hi"\n      - bash: {command: "echo obj", timeout: 1.5}\n      - notify: "done"\n      - notify: {text: "warn", level: warning}\n      - notify: {text: "plain"}\n      - setStatus: "working"\n      - setStatus: {text: "obj"}\n      - confirm: {title: "T", message: "M"}\n      - confirm: {message: "only"}\n      - tool: {name: bash, args: {command: "npm test", z: 1, a: [1, {b: 2}]}}\n      - tool: {name: read}\n`)],
	["conditions", H(`  - id: cond\n    event: file.changed\n    conditions:\n      - matchesCodeFiles\n      - matchesAnyPath: "src/**/*.ts"\n      - matchesAllPaths:\n          - "src/**"\n          - "**/*.ts"\n    actions:\n      - bash: "echo changed"\n  - event: session.idle\n    conditions: []\n    actions:\n      - bash: x\n  - event: tool.after.*\n    conditions: [matchesCodeFiles]\n    actions:\n      - bash: y\n`)],
	["async forms", H(`  - event: tool.after.write\n    async: true\n    actions:\n      - bash: a\n  - event: file.changed\n    async: {group: " uploads ", concurrency: 2}\n    actions:\n      - bash: b\n  - event: session.created\n    async: false\n    actions:\n      - bash: c\n  - event: session.deleted\n    async: {}\n    actions:\n      - bash: d\n  - event: file.changed\n    async: {group: uploads, concurrency: 2}\n    actions:\n      - bash: e\n`)],
	["command actions rejected", H(`  - id: command-hook\n    event: tool.after.write\n    actions:\n      - command: "npm test"\n  - event: tool.after.write\n    actions:\n      - command: {name: build, args: "--fast"}\n      - bash: ok\n  - event: session.idle\n    actions:\n      - bash: kept\n`)],
	["missing hooks", "not_hooks: []"],
	["hooks not array", "hooks: 3"],
	["hooks null", "hooks:"],
	["not an object", "- 1\n- 2"],
	["scalar document", "just text"],
	["empty document", ""],
	["yaml error", "hooks: [ { broken"],
	["duplicate yaml key", "hooks: []\nhooks: []"],
	["imports not array", "imports: x\nhooks: []"],
	["imports bad entry", "imports: [a.yaml, '  ', 3]\nhooks: []"],
	["hook not object", H("  - 3\n  - [x]\n  - null\n")],
	["bad id", H("  - id: ''\n    event: session.idle\n    actions:\n      - bash: x\n  - id: 7\n    event: session.idle\n    actions:\n      - bash: x\n")],
	["unknown event", H("  - event: nope\n    actions:\n      - bash: x\n  - event: tool.during.bash\n    actions:\n      - bash: x\n  - event: 3\n    actions:\n      - bash: x\n")],
	["missing actions", H("  - event: session.idle\n")],
	["empty actions", H("  - event: session.idle\n    actions: []\n")],
	["actions not array", H("  - event: session.idle\n    actions: {bash: x}\n")],
	["two action keys", H("  - event: session.idle\n    actions:\n      - bash: x\n        notify: y\n      - {}\n      - 5\n")],
	["bad action values", H("  - event: tool.after.bash\n    actions:\n      - bash: ''\n      - bash: {command: x, timeout: 0}\n      - bash: {command: x, timeout: -1}\n      - bash: {command: x, timeout: '5'}\n      - bash: {timeout: 5}\n      - notify: ''\n      - notify: {text: x, level: loud}\n      - notify: {level: info}\n      - confirm: x\n      - confirm: {message: ''}\n      - confirm: {message: m, title: ''}\n      - setStatus: ''\n      - setStatus: {text: ''}\n      - tool: x\n      - tool: {name: ''}\n      - tool: {name: t, args: [1]}\n      - command: ''\n      - command: {name: c, args: ''}\n")],
	["invalid scope and runIn", H("  - event: session.idle\n    scope: nope\n    runIn: elsewhere\n    actions:\n      - bash: x\n")],
	["action stop on non-before", H("  - event: session.idle\n    action: stop\n    actions:\n      - bash: x\n  - event: tool.before.bash\n    action: halt\n    actions:\n      - bash: x\n")],
	["prompt hooks are bash-only", H("  - event: user.prompt.submit\n    actions:\n      - notify: x\n")],
	["async on tool.before", H("  - event: tool.before.bash\n    async: true\n    actions:\n      - bash: x\n")],
	["async on idle and prompt", H("  - event: session.idle\n    async: true\n    actions:\n      - bash: x\n  - event: user.prompt.submit\n    async: true\n    actions:\n      - bash: x\n")],
	["async with stop", H("  - event: tool.after.bash\n    action: stop\n    async: true\n    actions:\n      - bash: x\n")],
	["async non-bash", H("  - event: tool.after.write\n    async: true\n    actions:\n      - notify: x\n")],
	["async bad config", H("  - event: file.changed\n    async: 1\n    actions:\n      - bash: x\n  - event: file.changed\n    async: {group: ''}\n    actions:\n      - bash: x\n  - event: file.changed\n    async: {group: g, concurrency: 1.5}\n    actions:\n      - bash: x\n  - event: file.changed\n    async: {group: g, concurrency: 0}\n    actions:\n      - bash: x\n  - event: file.changed\n    async: {group: g, extra: 1}\n    actions:\n      - bash: x\n")],
	["async concurrency without group", H("  - event: file.changed\n    async: {concurrency: 3}\n    actions:\n      - bash: x\n")],
	["async group mismatch", H("  - event: file.changed\n    async: {group: g}\n    actions:\n      - bash: x\n  - event: tool.after.write\n    async: {group: g, concurrency: 4}\n    actions:\n      - bash: y\n")],
	["conditions variants", H("  - event: file.changed\n    conditions: x\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - nope: x\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - 3\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - {matchesAnyPath: a, matchesAllPaths: b}\n    actions:\n      - bash: x\n  - event: tool.before.bash\n    conditions:\n      - matchesAnyPath:\n          - src/**\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - matchesAnyPath: []\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - matchesAllPaths: [a, '']\n    actions:\n      - bash: x\n  - event: file.changed\n    conditions:\n      - matchesAllPaths: 5\n    actions:\n      - bash: x\n")],
	["duplicate ids", H("  - id: a\n    event: session.idle\n    actions:\n      - bash: x\n  - id: a\n    event: session.created\n    actions:\n      - bash: x\n")],
	["overrides", H("  - id: idle-replacement\n    override: idle\n    event: session.idle\n    actions:\n      - notify: \"Project idle\"\n  - override: other\n    disable: true\n  - override: x\n    disable: 'yes'\n    event: session.idle\n    actions:\n      - bash: x\n  - disable: true\n    event: session.idle\n    actions:\n      - bash: x\n  - override: ''\n    event: session.idle\n    actions:\n      - bash: x\n  - override: plain\n    event: session.idle\n    actions:\n      - bash: x\n")],
	["error dedupe", H("  - event: nope\n  - event: nope\n")],
	["oversized", `hooks: []\n# ${"x".repeat(1024 * 1024)}`],
];
const schema = schemaInputs.map(([name, yaml]) => {
	const filePath = `/tmp/${name.replace(/ /g, "-")}.yaml`;
	const parsed = composition.loadHooksFile(filePath, () => yaml);
	const result = {
		name,
		filePath,
		yaml: name === "oversized" ? undefined : yaml,
		oversized: name === "oversized" ? true : undefined,
		hooks: hookJson(parsed.hooks),
		overrides: parsed.overrides.map(overrideJson),
		errors: parsed.errors,
		yamlError: parsed.errors.some((e: any) => e.code === "invalid_frontmatter" && !/^(\[aio yaml hooks\]|hooks\.yaml must parse|Failed to read)/.test(e.message)),
	};
	return clone(result);
});
// readFile failure.
const readFailure = composition.loadHooksFile("/tmp/unreadable.yaml", () => {
	throw new Error("EACCES: permission denied, open '/tmp/unreadable.yaml'");
});

// ---- overrides (resolveOverrides) ----
const overrideCases = [
	{
		name: "replace and disable",
		base: H("  - id: idle\n    event: session.idle\n    actions:\n      - notify: \"Agent is idle\"\n  - id: other\n    event: session.created\n    actions:\n      - bash: \"echo ready\"\n  - id: third\n    event: session.idle\n    actions:\n      - bash: three\n"),
		override: H("  - id: idle-replacement\n    override: idle\n    event: session.idle\n    actions:\n      - notify: \"Project idle\"\n  - override: other\n    disable: true\n  - override: idle-replacement\n    event: file.changed\n    actions:\n      - bash: chained\n  - override: nope\n    disable: true\n"),
	},
	{
		name: "duplicates across files",
		base: H("  - id: a\n    event: session.idle\n    actions:\n      - bash: one\n"),
		override: H("  - id: a\n    event: session.created\n    actions:\n      - bash: two\n  - override: a\n    disable: true\n"),
	},
].map(({ name, base, override }) => {
	const b = composition.loadHooksFile("/tmp/base.yaml", () => base);
	const o = composition.loadHooksFile("/tmp/override.yaml", () => override);
	const merged = composition.mergeHookMaps(b.hooks, o.hooks);
	const resolved = composition.resolveOverrides(merged, o.overrides);
	return clone({ name, base, override, hooks: hookJson(resolved.hooks), errors: resolved.errors });
});

// ---- discovery + trust + imports ----
interface DiscoveryCase {
	name: string;
	fs: FsOp[];
	env?: Record<string, string>;
	project?: string;
	ignoreTrust?: boolean;
}
const G = "agent/hook/hooks.yaml";
const idle = (id: string, text = id) => H(`  - id: ${id}\n    event: session.idle\n    actions:\n      - notify: "${text}"\n`);
const trustFile = (...dirs: string[]): FsOp => ({ op: "write", path: "agent/trusted-projects.json", content: `${JSON.stringify(dirs.map((d) => `@@ROOT@@/${d}`), null, 2)}\n` });
const deep = Array.from({ length: 34 }, (_, i): FsOp => ({
	op: "write",
	path: `d10/.pi/hook/chain/f${i}.yaml`,
	content: `imports: [./f${i + 1}.yaml]\nhooks: []\n`,
}));
const discoveryCases: DiscoveryCase[] = [
	{ name: "no config", fs: [], project: "d01" },
	{ name: "global only", fs: [{ op: "write", path: G, content: idle("g1") }], project: "d02" },
	{ name: "global fallback candidate", fs: [{ op: "rm", path: "agent/hook" }, { op: "write", path: "agent/hooks.yaml", content: idle("g2") }], project: "d03" },
	{ name: "global-only load", fs: [], project: undefined },
	{ name: "untrusted project", fs: [{ op: "write", path: "d04/.pi/hook/hooks.yaml", content: idle("p1") }], project: "d04" },
	{ name: "trusted project", fs: [{ op: "write", path: "d05/.pi/hook/hooks.yaml", content: idle("p1") }, trustFile("d05")], project: "d05" },
	{ name: "trusted by env", fs: [{ op: "write", path: "d06/.pi/hooks.yaml", content: idle("p2") }], env: { PI_YAML_HOOKS_TRUST_PROJECT: "1" }, project: "d06" },
	{ name: "ignore trust preview", fs: [{ op: "write", path: "d07/.pi/hook/hooks.yaml", content: idle("p3") }], project: "d07", ignoreTrust: true },
	{ name: "nested cwd finds root", fs: [{ op: "write", path: "d08/.pi/hook/hooks.yaml", content: idle("p4") }, { op: "mkdir", path: "d08/src/deep" }, trustFile("d08")], project: "d08/src/deep" },
	{ name: "git worktree anchor", fs: [{ op: "git", path: "d09" }, { op: "write", path: "d09/pkg/.pi/hook/hooks.yaml", content: idle("p5") }, { op: "mkdir", path: "d09/pkg/sub" }, trustFile("d09")], project: "d09/pkg/sub" },
	{ name: "git worktree untrusted subdir trust", fs: [{ op: "git", path: "d11" }, { op: "write", path: "d11/.pi/hook/hooks.yaml", content: idle("p6") }, trustFile("d11/sub")], project: "d11" },
	{
		name: "project imports",
		fs: [
			{ op: "write", path: "d12/.pi/hook/hooks.yaml", content: `imports:\n  - ./parts/one.yaml\n  - ./dir\n${H("  - id: root\n    event: session.created\n    actions:\n      - bash: root\n")}` },
			{ op: "write", path: "d12/.pi/hook/parts/one.yaml", content: idle("one") },
			{ op: "write", path: "d12/.pi/hook/dir/b.yaml", content: idle("b") },
			{ op: "write", path: "d12/.pi/hook/dir/A.yml", content: idle("A") },
			{ op: "write", path: "d12/.pi/hook/dir/.hidden.yaml", content: idle("hidden") },
			{ op: "write", path: "d12/.pi/hook/dir/notes.txt", content: "x" },
			{ op: "mkdir", path: "d12/.pi/hook/dir/sub.yaml" },
			{ op: "write", path: "d12/.pi/hook/dir/_c.yaml", content: idle("c") },
			trustFile("d12"),
		],
		project: "d12",
	},
	{
		name: "import cycle and missing",
		fs: [
			{ op: "write", path: "d13/.pi/hook/hooks.yaml", content: `imports: [./a.yaml, ./missing.yaml]\nhooks: []\n` },
			{ op: "write", path: "d13/.pi/hook/a.yaml", content: `imports: [./b.yaml]\n${idle("a")}` },
			{ op: "write", path: "d13/.pi/hook/b.yaml", content: `imports: [./a.yaml, ./hooks.yaml]\n${idle("b")}` },
			trustFile("d13"),
		],
		project: "d13",
	},
	{ name: "import depth limit", fs: [{ op: "write", path: "d10/.pi/hook/hooks.yaml", content: `imports: [./chain/f0.yaml]\nhooks: []\n` }, ...deep, { op: "write", path: "d10/.pi/hook/chain/f34.yaml", content: idle("end") }, trustFile("d10")], project: "d10" },
	{
		name: "project import escapes anchor",
		fs: [
			{ op: "write", path: "d14/.pi/hook/hooks.yaml", content: `imports: [../../../outside.yaml]\nhooks: []\n` },
			{ op: "write", path: "outside.yaml", content: idle("outside") },
			trustFile("d14"),
		],
		project: "d14",
	},
	{
		name: "project import escape allowed",
		fs: [{ op: "write", path: "d15/.pi/hook/hooks.yaml", content: `imports: [../../../outside.yaml]\nhooks: []\n` }, trustFile("d15")],
		env: { PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR: "1" },
		project: "d15",
	},
	{ name: "global import refused", fs: [{ op: "write", path: G, content: `imports: [./more.yaml]\n${idle("g1")}` }, { op: "write", path: "agent/hook/more.yaml", content: idle("more") }], project: "d16" },
	{ name: "global import allowed", fs: [], env: { PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS: "1" }, project: "d17" },
	{
		name: "package imports",
		fs: [
			{ op: "rm", path: G },
			{ op: "write", path: "d18/.pi/hook/hooks.yaml", content: `imports: [hookpkg/hooks.yaml, missingpkg/x.yaml, hookpkg]\nhooks: []\n` },
			{ op: "write", path: "d18/node_modules/hookpkg/hooks.yaml", content: idle("pkg") },
			trustFile("d18"),
		],
		project: "d18",
	},
	{ name: "package imports allowed", fs: [], env: { PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS: "1" }, project: "d18" },
	{
		name: "project overrides global",
		fs: [
			{ op: "write", path: G, content: idle("idle", "global") + "  - id: g-other\n    event: session.created\n    actions:\n      - bash: g\n" },
			{ op: "write", path: "d19/.pi/hook/hooks.yaml", content: H("  - override: idle\n    event: session.idle\n    actions:\n      - notify: project\n  - override: g-other\n    disable: true\n  - id: idle\n    event: file.changed\n    actions:\n      - bash: dup\n") },
			trustFile("d19"),
		],
		project: "d19",
	},
	{ name: "invalid trusted project", fs: [{ op: "write", path: "d20/.pi/hook/hooks.yaml", content: H("  - id: broken\n    event: nope\n    actions:\n      - bash: x\n") }, trustFile("d20")], project: "d20" },
	{ name: "broken global yaml", fs: [{ op: "write", path: G, content: "hooks: [ { broken" }], project: "d21" },
	{ name: "broken trust file", fs: [{ op: "rm", path: G }, { op: "write", path: "d22/.pi/hook/hooks.yaml", content: idle("p") }, { op: "write", path: "agent/trusted-projects.json", content: "{not json" }], project: "d22" },
	{ name: "trust file relative and symlink", fs: [{ op: "write", path: "d23/.pi/hook/hooks.yaml", content: idle("p") }, { op: "symlink", path: "link23", target: "@@ROOT@@/d23" }, { op: "write", path: "agent/trusted-projects.json", content: `["relative/dir", 5, "@@ROOT@@/link23"]\n`.split("@@ROOT@@").join(root) }], project: "d23" },
	{ name: "oversized import", fs: [{ op: "write", path: "d24/.pi/hook/hooks.yaml", content: `imports: [./big.yaml]\nhooks: []\n` }, { op: "write", path: "d24/.pi/hook/big.yaml", content: `hooks: []\n#${"x".repeat(1024 * 1024)}` }, trustFile("d24")], project: "d24" },
	{ name: "import yaml error", fs: [{ op: "write", path: "d25/.pi/hook/hooks.yaml", content: `imports: [./bad.yaml]\n${idle("ok")}` }, { op: "write", path: "d25/.pi/hook/bad.yaml", content: "imports: 3\nhooks: []\n" }, trustFile("d25")], project: "d25" },
	{ name: "hooks.yaml is a directory", fs: [{ op: "mkdir", path: "d26/.pi/hook/hooks.yaml" }, trustFile("d26")], project: "d26" },
];
// The trust file content in "trust file relative and symlink" must stay a placeholder.
for (const c of discoveryCases) {
	for (const op of c.fs) if (op.op === "write") op.content = op.content.split(root).join("@@ROOT@@");
}
function applyFsWithRoot(ops: FsOp[]): void {
	applyFs(ops.map((op) => (op.op === "write" ? { ...op, content: op.content.split("@@ROOT@@").join(root) } : op)));
}

const discoveries = discoveryCases.map((c) => {
	resetCaches();
	applyFsWithRoot(c.fs);
	const consoleRecords: unknown[] = [];
	const result = withEnv(c.env, () =>
		captureConsole(consoleRecords, () => {
			const projectDir = c.project ? join(root, c.project) : undefined;
			const loaded = discovery.loadDiscoveredHooks({ projectDir, ignoreTrust: c.ignoreTrust });
			const resolution = projectDir ? paths.resolveProjectHookResolution({ projectDir }) : undefined;
			return {
				hooks: hookJson(loaded.hooks),
				errors: loaded.errors,
				advisories: loaded.advisories,
				sources: loaded.sources,
				files: loaded.files,
				signature: loaded.signature,
				resolution: resolution ?? null,
			};
		}),
	);
	return norm({ ...c, result, console: consoleRecords });
});

// ---- path filter ----
const extnames = [".bashrc", "a.", "a.b.c", "..x", "...x", "..", "x/.y.ts", "a.TS", "a/b.Ts/", "src/index.ts", "Makefile", "a/b.tf", "x.R", ""].map((p) => ({
	path: p,
	code: pathFilter.hasCodeExtension(p),
}));
const normalizeCases = [
	["/repo/project", "/repo/project/src/index.ts"], ["/repo/project", "src/index.ts"], ["/repo/project", "/elsewhere/index.ts"],
	["/repo/project", "./src\\lib.ts"], ["/repo/project", "/repo/project"], ["/repo/project", "/repo/projectx/a.ts"],
	["/repo/project", "/repo/project/../other/a.ts"], ["/repo/project/", "/repo/project/a/b/../c.ts"], ["/repo/project", "././a.ts"],
].map(([projectDir, file]) => ({ projectDir, file, out: pathFilter.normalizeConditionPath(projectDir, file) }));

const GLOB_PATHS = [
	"src/index.ts", "src/a/b/c.ts", "src/.hidden.ts", "src/.config/x.ts", "SRC/index.ts", "src/INDEX.TS", "docs/readme.md",
	"index.ts", ".env", "a/b", "a/c", "a/b/c", "/abs/x.ts", "/repo/project/src/x.ts", "x.tsx", "test/a.spec.ts", "a3.ts", "a10.ts",
	"src/x.ts", "src/z.ts", "lib/a.js", "a b/c.ts", "abc", "abd", "a.b", "file.min.js", "x", "Z", "ü.ts", "src/", "",
];
const GLOB_PATTERNS = [
	"src/**", "**/*.ts", "**/*.TS", "*.ts", "src/*.ts", "src/**/*.ts", "SRC/**", "**", "*", "a/**/c", "a/*", "a/b",
	"{src,lib}/**", "**/*.{ts,tsx}", "a{1..5}.ts", "a{01..10}.ts", "a{a..c}", "src/@(x|y).ts", "src/!(x).ts", "src/+(x|z).ts",
	"src/*(x).ts", "src/?(x).ts", "[abc]bc", "a[!c]d", "[[:alpha:]]", "[a-c]b?", "?.ts", "??", "*.*", ".*", "src\\*.ts",
	"!src/**", "#x", "", "**/a/**", "./src/*.ts", "src/../src/*.ts", "a/b/", "**/.config/**", "test/*.spec.ts", "*.min.js",
	"{a,b}", "{}", "a{,b}", "x{a}y", "a/**/**/c", "**/", "[]", "[a-]", "*/", "/abs/*.ts", "/**/*.ts", "a\\b",
];
const nocase = process.platform === "darwin" || process.platform === "win32";
const globs: Array<[string, string, boolean]> = [];
for (const pattern of GLOB_PATTERNS) for (const p of GLOB_PATHS) globs.push([p, pattern, matchesGlob(p, pattern)]);

const conditionCases = [
	{ files: ["src/index.ts"], conditions: ["matchesCodeFiles", { matchesAnyPath: ["src/**/*.ts"] }, { matchesAllPaths: ["src/**/*.ts"] }] },
	{ files: ["src/index.ts"], conditions: [{ matchesAnyPath: ["docs/**"] }] },
	{ files: ["src/index.ts", "docs/a.md"], conditions: [{ matchesAllPaths: ["src/**"] }] },
	{ files: ["src/index.ts", "docs/a.md"], conditions: [{ matchesAnyPath: ["docs/**", "x"] }, { matchesAllPaths: ["**"] }] },
	{ files: [], conditions: [{ matchesAnyPath: ["src/**"] }] },
	{ files: [], conditions: [{ matchesAllPaths: ["src/**"] }] },
	{ files: [], conditions: ["matchesCodeFiles"] },
	{ files: ["docs/notes.txt"], conditions: ["matchesCodeFiles"] },
	{ files: ["/repo/project/src/a.go"], conditions: [{ matchesAnyPath: "src/*.go" }] },
	{ changes: [{ operation: "rename", fromPath: "a.txt", toPath: "src/b.ts" }, { operation: "delete", path: "/repo/project/x.md" }], conditions: ["matchesCodeFiles", { matchesAllPaths: ["src/**", "x.md"] }] },
	{ files: ["a.ts"], changes: [], conditions: [{ matchesAnyPath: ["a.ts"] }] },
].map((c) => {
	const conditions = c.conditions.map((x) => (typeof x === "object" && typeof (x as any).matchesAnyPath === "string" ? { matchesAnyPath: [(x as any).matchesAnyPath] } : x));
	const ctx = pathFilter.buildPathMatchContext("/repo/project", c.files, c.changes);
	return clone({ ...c, conditions, context: ctx, failure: pathFilter.evaluatePathConditions(conditions, ctx) ?? null });
});

// ---- redaction + sanitize ----
const ghToken = ["ghp", "_", "0123456789abcdefghij"].join("");
const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghij"].join(".");
const redactInputs = [
	`token ${ghToken}`, "https://user:pass@example.com/x", "Authorization: Bearer abc123", "authorization:\u00a0bearer\u00a0zzz",
	"api_key=sk-abcdef123456", "API-KEY: x1, other", "password = hunter2 tail", "pwd:'quoted'", "MY_TOKEN=\"abc\" next",
	"AWS_SECRET: plain", "DB_PASSWORD='x'", jwt, "npm test", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
	["github", "_pat_", "A".repeat(22)].join(""), ["glpat", "-", "x".repeat(20)].join(""), ["xoxb", "-", "1".repeat(12)].join(""),
	"postgres://u:p@db/x and mysql://a:b@h", "secret:\tvalue", "tokens=abc", "my token=abc", "",
];
const redactions = redactInputs.map((input) => ({ input, out: actions.redactSensitiveContent(input) }));
const sanitizeInputs: unknown[] = [
	{ command: "npm test", api_key: "sk-123", token: "t-456", nested: { password: "p-789", safe: "ok", list: [{ Auth: 1 }, "x"] } },
	{ content: "x".repeat(70_000) },
	{ deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } } },
	{ PRIVATE_KEY: "x", "private-key": "y", apikey: "z", Bearer: "b", authorization: { x: 1 }, n: null, b: true, f: 1.5 },
	{},
];
const sanitize = sanitizeInputs.map((input) => ({ input, out: sessionState.sanitizeToolArgsForSerialization(input as any) }));

// ---- stdin serialization, utf8 trimming, env, result mapping ----
const stdinCases = [
	{ maxBytes: undefined, context: { session_id: "s", event: "tool.before.bash", cwd: "/p", prompt: "hi", files: ["a"], changes: [{ operation: "modify", path: "a" }], tool_name: "bash", tool_args: { command: "ls" } } },
	{ maxBytes: "200", context: { session_id: "s", event: "user.prompt.submit", cwd: "/p", prompt: "é".repeat(1500), files: ["a"] } },
	{ maxBytes: "300", context: { session_id: "s", event: "file.changed", cwd: "/p", files: Array.from({ length: 300 }, (_, i) => `file-${i}.ts`) } },
	{ maxBytes: "120", context: { session_id: "s", event: "file.changed", cwd: "/p", tool_args: { x: "y".repeat(500) } } },
	{ maxBytes: "50", context: { session_id: "session", event: "file.changed", cwd: "/p", prompt: "x".repeat(2000) } },
].map((c) => ({ ...c, out: withEnv(c.maxBytes ? { PI_YAML_HOOKS_MAX_STDIN_BYTES: c.maxBytes } : undefined, () => bash.serializeContextForStdinDetailed(c.context as any)) }));
const utf8Bytes = Buffer.from("aé中😀", "utf8");
const trims = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 100].map((n) => ({ max: n, out: bash.trimToUtf8Boundary(utf8Bytes, n) }));
const trimCorrupt = { bytes: [0x80, 0x80, 0x41], outs: [1, 2, 3].map((n) => bash.trimToUtf8Boundary(Buffer.from([0x80, 0x80, 0x41]), n)) };
const envCases = [
	{ inherited: [["PATH", "/usr/bin"], ["HOME", "/home/me"], ["MY_SECRET", "leak"], ["PI_SESSION_ID", "old"]], context: [["PI_PROJECT_DIR", "/repo"], ["PI_SESSION_ID", "s1"]] },
	{ inherited: [["PATH", "/usr/bin"], ["HOME", "/h"], ["MY_SECRET", "leak"], ["PI_YAML_HOOKS_ENV_ALLOWLIST", " HOME , PATH,bad-name,PI_SESSION_ID,HOME,MISSING"], ["PI_SESSION_ID", "old"]], context: [["PI_PROJECT_DIR", "/repo"], ["PI_SESSION_ID", "s1"]] },
].map((c) => ({ ...c, out: Object.entries(bash.buildBashEnvironment(Object.fromEntries(c.inherited), Object.fromEntries(c.context))) }));
const mapCases = [
	[0, false, "tool.before.bash"], [1, false, "tool.before.bash"], [2, false, "tool.before.bash"], [2, false, "tool.before.*"],
	[2, false, "tool.after.bash"], [2, false, "user.prompt.submit"], [124, true, "tool.before.bash"], [127, false, "session.idle"],
].map(([exitCode, timedOut, event]) => {
	const r = bash.mapBashProcessResultToHookResult({ command: "x", stdout: "", stderr: "", durationMs: 1, exitCode, signal: null, timedOut } as any, { session_id: "s", event, cwd: "/" } as any);
	return { exitCode, timedOut, event, status: r.status, blocking: r.blocking };
});

// ---- real bash execution ----
const bashCases: Array<{ name: string; fs?: FsOp[]; env?: Record<string, string>; command: string; event: string; timeout?: number; project: string; context?: Record<string, unknown> }> = [
	{ name: "stdout", command: "printf 'hello\\n'", event: "tool.after.bash", project: "b1" },
	{ name: "stderr exit 1", command: "echo oops >&2; exit 1", event: "tool.before.bash", project: "b1" },
	{ name: "exit 2 blocks before", command: "echo denied >&2; exit 2", event: "tool.before.bash", project: "b1" },
	{ name: "exit 2 after fails", command: "exit 2", event: "tool.after.bash", project: "b1" },
	{ name: "stdin payload", command: "cat", event: "tool.after.write", project: "b1", context: { tool_name: "write", tool_args: { path: "a.ts", content: "x" }, files: ["a.ts"], changes: [{ operation: "modify", path: "a.ts" }] } },
	{ name: "context env", command: "printf '%s|%s|%s|%s|%s' \"$PI_PROJECT_DIR\" \"$PI_WORKTREE_DIR\" \"$PI_SESSION_ID\" \"$OPENCODE_SESSION_ID\" \"${PI_GIT_COMMON_DIR-unset}\"; pwd", event: "session.created", project: "b1" },
	{ name: "git common dir", fs: [{ op: "git", path: "b2" }, { op: "mkdir", path: "b2/sub" }], command: "printf '%s|%s|%s' \"$PI_PROJECT_DIR\" \"$PI_WORKTREE_DIR\" \"$PI_GIT_COMMON_DIR\"", event: "session.created", project: "b2/sub" },
	{ name: "truncated output", env: { PI_YAML_HOOKS_MAX_OUTPUT_BYTES: "10" }, command: "printf 'aaaaaaaaé€xyz'; printf 'eeeeeeeeeeeeeeee' >&2", event: "tool.after.bash", project: "b1" },
	{ name: "stdin truncated", env: { PI_YAML_HOOKS_MAX_STDIN_BYTES: "60" }, command: "cat", event: "user.prompt.submit", project: "/", context: { prompt: "p".repeat(200) } },
	{ name: "allowlist", env: { PI_YAML_HOOKS_ENV_ALLOWLIST: "AIO_HOOK_VISIBLE", AIO_HOOK_VISIBLE: "yes", AIO_HOOK_HIDDEN: "no" }, command: "printf '%s|%s|%s' \"${AIO_HOOK_VISIBLE-unset}\" \"${AIO_HOOK_HIDDEN-unset}\" \"${PI_SESSION_ID-unset}\"", event: "session.created", project: "b1" },
	{ name: "timeout", command: "sleep 5", event: "tool.before.bash", timeout: 200, project: "b1" },
	{ name: "missing executable", env: { PI_YAML_HOOKS_BASH_EXECUTABLE: "/nonexistent/aio-bash" }, command: "true", event: "session.created", project: "b1" },
	{ name: "opencode executable", env: { OPENCODE_HOOKS_BASH_EXECUTABLE: "sh" }, command: "echo via-sh", event: "session.created", project: "b1" },
];
applyFs([{ op: "mkdir", path: "b1" }]);
/** The key order executeBashAction builds the hook context in. */
function canonicalContext(c: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["session_id", "event", "cwd", "prompt", "files", "changes", "tool_name", "tool_args"]) if (key in c) out[key] = c[key];
	return out;
}
const bashRuns: unknown[] = [];
for (const c of bashCases) {
	applyFs(c.fs ?? []);
	const project = c.project.startsWith("/") ? c.project : join(root, c.project);
	const r: any = await withEnvAsync(c.env, () =>
		bash.executeBashHook({ command: c.command, timeout: c.timeout, projectDir: project, context: canonicalContext({ session_id: "sess-1", event: c.event, cwd: project, ...(c.context ?? {}) }) as any }),
	);
	bashRuns.push(norm({ ...c, result: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, outputTruncated: r.outputTruncated, stdinTruncated: r.stdinTruncated, status: r.status, blocking: r.blocking } }));
}

// ---- session state ----
function sessionScript(): unknown[] {
	const out: unknown[] = [];
	let now = 1_000_000;
	const store = new sessionState.SessionStateStore({ nowFn: () => now });
	store.setPendingToolCall("c1", "s1", { command: "npm test" });
	out.push(["count", store.pendingToolCallCount()]);
	out.push(["consume", store.consumePendingToolCall("c1") ?? null]);
	out.push(["consume again", store.consumePendingToolCall("c1") ?? null]);
	store.setPendingToolCall("c2", "s1", { a: 1 });
	now += 4 * 60_000;
	store.setPendingToolCall("c3", "s2", { b: 2 });
	now += 2 * 60_000;
	store.setPendingToolCall("c4", "s1", {});
	out.push(["after ttl", store.pendingToolCallCount(), store.consumePendingToolCall("c2") ?? null, store.consumePendingToolCall("c3") ?? null]);
	store.setPendingToolCall("c5", "s9", {});
	store.deleteSession("s9");
	out.push(["deleted pending", store.consumePendingToolCall("c5") ?? null, store.isDeleted("s9"), store.isDeleted("s1")]);
	const changes = [{ operation: "modify", path: "src/index.ts" }, { operation: "rename", fromPath: "a", toPath: "b" }, { operation: "modify", path: "src/index.ts" }];
	store.addFileChanges("s1", changes as any);
	out.push(["changes", store.getFileChanges("s1"), store.getModifiedPaths("s1")]);
	store.beginIdleDispatch("s1", store.getFileChanges("s1"));
	store.addFileChanges("s1", [{ operation: "modify", path: "src/late.ts" }, { operation: "rename", fromPath: "a", toPath: "b" }] as any);
	store.consumeFileChanges("s1", [{ operation: "modify", path: "src/index.ts" }, { operation: "rename", fromPath: "a", toPath: "b" }] as any);
	out.push(["after idle", store.getFileChanges("s1"), store.getModifiedPaths("s1"), store.getFileChanges("none")]);
	store.deleteSession("s1");
	store.rememberSession("s1");
	out.push(["remembered", store.isDeleted("s1")]);
	return out;
}
async function scopeScript(): Promise<unknown[]> {
	const out: unknown[] = [];
	const store = new sessionState.SessionStateStore();
	store.rememberSession("child", "root");
	store.rememberSession("root", null);
	const none = async () => null;
	for (const [id, scope] of [["root", "all"], ["root", "main"], ["root", "child"], ["child", "main"], ["child", "child"], ["grandchild", "child"], ["loop-a", "main"]]) {
		const parents: Record<string, string> = { grandchild: "child", "loop-a": "loop-b", "loop-b": "loop-a" };
		out.push([id, scope, await store.evaluateScope(id, scope as any, async (s: string) => parents[s] ?? null)]);
	}
	out.push(["root of grandchild", await store.getRootSessionID("grandchild", none)]);
	return out;
}
const sessionScripts = { store: sessionScript(), scope: await scopeScript() };

// ---- lineage ----
const lineageFs: FsOp[] = [
	{ op: "write", path: "sessions/root.jsonl", content: `${JSON.stringify({ type: "session", id: "root-id", cwd: "/x" })}\n{"type":"message"}\n` },
	{ op: "write", path: "sessions/mid.jsonl", content: `${JSON.stringify({ type: "session", id: "mid-id", parentSession: "@@ROOT@@/sessions/root.jsonl" })}\n` },
	{ op: "write", path: "sessions/loop.jsonl", content: `${JSON.stringify({ type: "session", id: "loop-id", parentSession: "@@ROOT@@/sessions/loop.jsonl" })}\n` },
	{ op: "write", path: "sessions/bad.jsonl", content: "not json\n" },
	{ op: "write", path: "sessions/notsession.jsonl", content: `${JSON.stringify({ type: "other", id: "x" })}\n` },
];
applyFsWithRoot(lineageFs);
const lineageCases = [
	{ current: "cur", header: { id: "cur", parentSession: "@@ROOT@@/sessions/mid.jsonl" } },
	{ current: "cur", header: { id: "cur", parentSession: "@@ROOT@@/sessions/mid.jsonl" } },
	{ current: "other", header: { id: "cur" } },
	{ current: "solo", header: { id: "solo" } },
	{ current: "l", header: { id: "l", parentSession: "@@ROOT@@/sessions/loop.jsonl" } },
	{ current: "b", header: { id: "b", parentSession: "@@ROOT@@/sessions/bad.jsonl" } },
	{ current: "n", header: { id: "n", parentSession: "@@ROOT@@/sessions/notsession.jsonl" } },
	{ current: "m", header: { id: "m", parentSession: "@@ROOT@@/sessions/missing.jsonl" } },
	{ current: "h", header: null },
	{ current: "", header: { id: "" } },
].map((c) => {
	const header = c.header ? parseJson(JSON.stringify(c.header).split("@@ROOT@@").join(root)) : null;
	const out = lineage.getRootSessionId(c.current, { getHeader: () => header } as any);
	return { ...c, out };
});

// ---- runtime scenarios (mocked host adapter, as in dispatch.test.ts) ----
interface BashResponse { exitCode?: number; stdout?: string; stderr?: string; outputTruncated?: boolean; stdinTruncated?: boolean; throw?: string }
type RuntimeStep =
	| { op: "before"; tool: string; session?: string; call: string; args?: unknown }
	| { op: "after"; tool: string; session?: string; call: string; args?: unknown }
	| { op: "prompt"; session: string; prompt: string }
	| { op: "event"; type: string; properties?: unknown }
	| { op: "flush" }
	| { op: "advance"; ms: number };
interface RuntimeScenario {
	name: string;
	yaml: string;
	responses?: Record<string, BashResponse>;
	confirms?: boolean[];
	roots?: Record<string, string>;
	currentSession?: string;
	budgetMs?: number;
	env?: Record<string, string>;
	steps: RuntimeStep[];
}

function bashMock(responses: Record<string, BashResponse>, log: unknown[], asyncLog: unknown[], asyncCommands: Set<string>) {
	return async (request: any) => {
		const response = responses[request.command] ?? {};
		const entry = { op: "bash", command: request.command, timeout: request.timeout, projectDir: request.projectDir, stdin: bash.serializeContextForStdin(request.context) };
		(asyncCommands.has(request.command) ? asyncLog : log).push(entry);
		if (response.throw) throw new Error(response.throw);
		return bash.mapBashProcessResultToHookResult(
			{ command: request.command, stdout: response.stdout ?? "", stderr: response.stderr ?? "", durationMs: 1, exitCode: response.exitCode ?? 0, signal: null, timedOut: false, outputTruncated: response.outputTruncated, stdinTruncated: response.stdinTruncated } as any,
			request.context,
		);
	};
}

const runtimeScenarios: RuntimeScenario[] = [
	{
		name: "blocking and stop",
		yaml: H("  - id: guard\n    event: tool.before.bash\n    actions:\n      - bash: guard\n  - id: stopper\n    event: tool.before.*\n    action: stop\n    actions:\n      - bash: stopper\n"),
		responses: { guard: { exitCode: 2, stderr: "no cluster mutations token=abc" }, stopper: { exitCode: 2, stderr: "  " } },
		steps: [
			{ op: "before", tool: "bash", session: "s1", call: "c1", args: { command: "kubectl delete pod x" } },
			{ op: "before", tool: "read", session: "s1", call: "c2", args: { path: "a" } },
			{ op: "after", tool: "read", session: "s1", call: "c2" },
			{ op: "before", tool: "bash", call: "c3", args: {} },
		],
	},
	{
		name: "file.changed and idle",
		yaml: H("  - id: post-write\n    event: tool.after.write\n    actions:\n      - bash: post\n  - id: watcher\n    event: file.changed\n    conditions:\n      - matchesAnyPath: \"src/**\"\n    actions:\n      - notify: \"src changed\"\n      - bash: on-change\n  - id: idle\n    event: session.idle\n    conditions: [matchesCodeFiles]\n    actions:\n      - bash: idle\n      - notify: {text: idle, level: success}\n      - setStatus: settled\n"),
		steps: [
			{ op: "event", type: "session.idle", properties: { sessionID: "s1" } },
			{ op: "before", tool: "write", session: "s1", call: "c1", args: { path: "src/new.ts", content: "x" } },
			{ op: "after", tool: "write", session: "s1", call: "c1", args: {} },
			{ op: "after", tool: "bash", session: "s1", call: "c2", args: { command: "rm docs/old.md && mv src/a.ts src/b.ts" } },
			{ op: "after", tool: "apply_patch", session: "s1", call: "c3", args: { patch: "*** Begin Patch\n*** Add File: src/p.ts\n*** End Patch" } },
			{ op: "event", type: "session.idle", properties: { sessionID: "s1" } },
			{ op: "event", type: "session.idle", properties: { sessionID: "s1" } },
			{ op: "event", type: "session.idle", properties: { sessionID: "  " } },
			{ op: "event", type: "session.idle" },
		],
	},
	{
		name: "prompt context",
		yaml: H("  - id: ctx\n    event: user.prompt.submit\n    actions:\n      - bash: ctx-a\n      - bash: ctx-b\n      - bash: ctx-fail\n      - bash: ctx-trunc\n      - bash: ctx-big\n      - bash: ctx-c\n"),
		responses: { "ctx-a": { stdout: "  The time is 12:00.\n" }, "ctx-b": { stdout: "   " }, "ctx-fail": { exitCode: 1, stdout: "ignored" }, "ctx-trunc": { stdout: "partial", outputTruncated: true }, "ctx-big": { stdout: "x".repeat(70_000) }, "ctx-c": { stdout: "last" } },
		steps: [{ op: "prompt", session: "s1", prompt: "What time is it?" }],
	},
	{
		name: "ui actions and confirm",
		yaml: H("  - id: confirm-critical\n    event: tool.before.bash\n    actions:\n      - confirm: {title: \"Run command?\", message: \"Approve this bash call.\"}\n      - bash: after-confirm\n  - id: after-tool\n    event: tool.after.bash\n    actions:\n      - tool: {name: bash, args: {command: \"npm test\"}}\n      - setStatus: done\n  - event: tool.after.read\n    actions:\n      - confirm: {message: never blocks}\n      - notify: read\n"),
		confirms: [false, true, false],
		currentSession: "s1",
		steps: [
			{ op: "before", tool: "bash", session: "s1", call: "c1", args: { command: "terraform apply" } },
			{ op: "before", tool: "bash", session: "s1", call: "c2", args: { command: "terraform apply" } },
			{ op: "after", tool: "bash", session: "s1", call: "c2", args: { command: "npm run build" } },
			{ op: "after", tool: "bash", session: "s2", call: "c3", args: { command: "x" } },
			{ op: "after", tool: "read", session: "s1", call: "c4", args: { path: "a" } },
		],
	},
	{
		name: "scope and runIn",
		yaml: H("  - id: child-only\n    event: session.created\n    scope: child\n    actions:\n      - bash: child\n  - id: main-only\n    event: session.created\n    scope: main\n    actions:\n      - bash: main\n  - id: follow\n    event: tool.after.bash\n    runIn: main\n    actions:\n      - tool: {name: read}\n"),
		roots: { kid: "parent" },
		currentSession: "parent",
		steps: [
			{ op: "event", type: "session.created", properties: { info: { id: "parent" } } },
			{ op: "event", type: "session.created", properties: { info: { id: "kid" } } },
			{ op: "after", tool: "bash", session: "kid", call: "c1", args: { command: "ls" } },
			{ op: "event", type: "session.deleted", properties: { info: { id: "parent" }, reason: "quit" } },
			{ op: "after", tool: "bash", session: "kid", call: "c2", args: { command: "ls" } },
			{ op: "event", type: "session.created", properties: { info: {} } },
			{ op: "event", type: "unknown.event" },
		],
	},
	{
		name: "patch aliases dispatch once",
		yaml: H("  - id: shared\n    event: tool.before.patch\n    actions:\n      - bash: patch-hook\n  - id: canon\n    event: tool.before.apply_patch\n    actions:\n      - bash: apply-hook\n  - id: wild\n    event: tool.after.*\n    actions:\n      - bash: wild\n"),
		responses: { "apply-hook": { exitCode: 2, stderr: "patch denied" } },
		steps: [
			{ op: "before", tool: "patch", session: "s1", call: "c1", args: { patch: "x" } },
			{ op: "before", tool: "apply_patch", session: "s1", call: "c2", args: {} },
			{ op: "before", tool: "edit", session: "s1", call: "c3", args: { path: "a" } },
			{ op: "after", tool: "edit", session: "s1", call: "c3", args: { path: "a" } },
		],
	},
	{
		name: "async hooks",
		yaml: H("  - id: upload\n    event: tool.after.write\n    async: true\n    actions:\n      - bash: upload\n      - bash: upload-2\n  - id: grouped\n    event: file.changed\n    async: {group: g, concurrency: 2}\n    actions:\n      - bash: grouped\n  - id: failing\n    event: tool.after.*\n    async: true\n    actions:\n      - bash: async-throw\n      - bash: never\n  - id: sync\n    event: tool.after.write\n    actions:\n      - bash: sync\n"),
		responses: { "async-throw": { throw: "spawn failed" } },
		steps: [
			{ op: "after", tool: "write", session: "s1", call: "c1", args: { path: "src/new.ts", content: "x" } },
			{ op: "flush" },
		],
	},
	{
		name: "bash seam throws",
		yaml: H("  - id: boom\n    event: tool.before.bash\n    actions:\n      - bash: boom\n  - id: prompt-boom\n    event: user.prompt.submit\n    actions:\n      - bash: boom\n"),
		responses: { boom: { throw: "executor exploded" } },
		steps: [
			{ op: "before", tool: "bash", session: "s1", call: "c1", args: { command: "x" } },
			{ op: "prompt", session: "s1", prompt: "hi" },
		],
	},
	{
		name: "synchronous budget",
		yaml: H("  - id: slow\n    event: tool.before.bash\n    actions:\n      - bash: {command: slow, timeout: 500}\n      - bash: default\n      - confirm: {message: m}\n"),
		budgetMs: 1000,
		confirms: [true],
		steps: [
			{ op: "before", tool: "bash", session: "s1", call: "c1", args: {} },
			{ op: "advance", ms: 5000 },
		],
	},
	{
		name: "debug logging",
		yaml: H("  - id: logs\n    event: tool.after.bash\n    actions:\n      - bash: fails\n      - notify: hello\n      - setStatus: busy\n      - tool: {name: read, args: {path: a}}\n  - id: prompt-logs\n    event: user.prompt.submit\n    actions:\n      - bash: trunc\n"),
		responses: { fails: { exitCode: 3, stderr: "bad password=hunter2", stdout: "out" }, trunc: { stdout: "x", stdinTruncated: true } },
		currentSession: "other",
		env: { PI_YAML_HOOKS_DEBUG: "1" },
		steps: [
			{ op: "after", tool: "bash", session: "s1", call: "c1", args: { command: "x" } },
			{ op: "prompt", session: "s1", prompt: "p" },
		],
	},
];

const cleanAgent: FsOp[] = [{ op: "rm", path: "agent/hook" }, { op: "rm", path: "agent/hooks.yaml" }, { op: "rm", path: "agent/trusted-projects.json" }];
// Runtime and feature scenarios start from an empty agent directory.
applyFs(cleanAgent);
let fakeNow = 1_700_000_000_000;
const runtimeResults: unknown[] = [];
for (const [index, s] of runtimeScenarios.entries()) {
	resetCaches();
	const project = join(root, `rt${index}`);
	applyFs([{ op: "write", path: "agent/hook/hooks.yaml", content: s.yaml }, { op: "mkdir", path: `rt${index}` }]);
	const log: unknown[] = [];
	const asyncLog: unknown[] = [];
	const asyncCommands = new Set<string>(["upload", "upload-2", "grouped", "async-throw", "never"]);
	const confirms = [...(s.confirms ?? [])];
	const host = {
		abort: (id: string) => { log.push({ op: "abort", session: id }); },
		getRootSessionId: (id: string) => s.roots?.[id],
		runBash: () => { throw new Error("unused"); },
		sendPrompt: (id: string, text: string) => {
			log.push({ op: "sendPrompt", session: id, text });
			return id === (s.currentSession ?? "s1") ? { status: "accepted" } : { status: "degraded", reason: "current_session_only", details: { requestedSessionId: id } };
		},
		notify: (text: string, level?: string) => { log.push({ op: "notify", text, level: level ?? null }); return { status: "accepted" }; },
		confirm: async (request: any) => { log.push({ op: "confirm", ...request }); return confirms.shift() ?? false; },
		setStatus: (hookId: string, text: string) => { log.push({ op: "setStatus", hookId, text }); return { status: "accepted" }; },
	};
	await withEnvAsync(s.env, async () => {
		const saved = { warn: console.warn, info: console.info, error: console.error };
		console.warn = (t: unknown) => log.push({ op: "console", level: "warn", text: String(t) });
		console.info = (t: unknown) => log.push({ op: "console", level: "info", text: String(t) });
		console.error = (t: unknown) => log.push({ op: "console", level: "error", text: String(t) });
		try {
			const rt = runtimeMod.createHooksRuntime({
				projectDir: project,
				host: host as any,
				executeBash: bashMock(s.responses ?? {}, log, asyncLog, asyncCommands),
				now: () => fakeNow,
				...(s.budgetMs !== undefined ? { synchronousBashBudgetMs: s.budgetMs } : {}),
			});
			for (const step of s.steps) {
				try {
					switch (step.op) {
						case "before":
							await rt["tool.execute.before"]({ tool: step.tool, sessionID: step.session, callID: step.call }, { args: step.args as any });
							log.push({ op: "result", value: "ok" });
							break;
						case "after":
							await rt["tool.execute.after"]({ tool: step.tool, sessionID: step.session, callID: step.call, args: step.args as any });
							log.push({ op: "result", value: "ok" });
							break;
						case "prompt":
							log.push({ op: "result", value: await rt["user.prompt.submit"]({ sessionID: step.session, prompt: step.prompt }) });
							break;
						case "event":
							await rt.event({ event: { type: step.type, properties: step.properties as any } });
							log.push({ op: "result", value: "ok" });
							break;
						case "flush":
							await new Promise((r) => setTimeout(r, 30));
							log.push({ op: "async", calls: [...asyncLog].sort((a: any, b: any) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0)) });
							break;
						case "advance":
							fakeNow += step.ms;
							await rt["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "late" }, { args: {} });
							log.push({ op: "result", value: "ok" });
							break;
					}
				} catch (error) {
					log.push({ op: "error", message: error instanceof Error ? error.message : String(error) });
				}
			}
		} finally {
			Object.assign(console, saved);
		}
	});
	runtimeResults.push(norm({ ...s, project: `rt${index}`, log }));
}

// ---- registerYamlHooks scenarios ----
type FeatureStep =
	| { op: "fs"; ops: FsOp[] }
	| { op: "ctx"; cwd?: string; hasUI?: boolean; session?: string; header?: unknown; confirms?: boolean[]; confirmThrows?: boolean }
	| { op: "env"; set: Record<string, string | null> }
	| { op: "session_start"; reason: string }
	| { op: "before_switch"; reason: string }
	| { op: "shutdown"; reason: string }
	| { op: "tool_call"; tool: string; id: string; input?: unknown }
	| { op: "tool_result"; tool: string; id: string; input?: unknown }
	| { op: "before_agent_start"; messageType: string; prompt?: string; systemPrompt: string }
	| { op: "command"; name: string; args?: string }
	| { op: "reset" }
	| { op: "flush" };
interface FeatureScenario {
	name: string;
	responses?: Record<string, BashResponse>;
	steps: FeatureStep[];
}
const GH = "agent/hook/hooks.yaml";
const featureScenarios: FeatureScenario[] = [
	{
		name: "lifecycle and tools",
		responses: { guard: { exitCode: 2, stderr: "blocked by guard" } },
		steps: [
			{ op: "fs", ops: [{ op: "write", path: GH, content: H("  - id: ready\n    event: session.created\n    actions:\n      - bash: ready\n  - id: cleanup\n    event: session.deleted\n    actions:\n      - bash: cleanup\n  - id: guard\n    event: tool.before.bash\n    actions:\n      - bash: guard\n  - id: post\n    event: tool.after.*\n    actions:\n      - bash: post\n  - id: note\n    event: file.changed\n    actions:\n      - notify: {text: changed, level: success}\n      - setStatus: changed\n") }, { op: "mkdir", path: "f1" }] },
			{ op: "ctx", cwd: "f1", hasUI: true, session: "sess-a" },
			{ op: "session_start", reason: "startup" },
			{ op: "session_start", reason: "resume" },
			{ op: "tool_call", tool: "bash", id: "t1", input: { command: "rm -rf /" } },
			{ op: "tool_call", tool: "write", id: "t2", input: { path: "src/a.ts", content: "x" } },
			{ op: "tool_result", tool: "write", id: "t2", input: { path: "src/a.ts", content: "x" } },
			{ op: "tool_result", tool: "read", id: "t3" },
			{ op: "before_switch", reason: "new" },
			{ op: "shutdown", reason: "new" },
			{ op: "ctx", session: "sess-b" },
			{ op: "session_start", reason: "new" },
			{ op: "ctx", session: "" },
			{ op: "tool_call", tool: "bash", id: "t4", input: { command: "x" } },
			{ op: "session_start", reason: "startup" },
			{ op: "shutdown", reason: "quit" },
		],
	},
	{
		name: "headless ui actions",
		steps: [
			{ op: "fs", ops: [{ op: "write", path: GH, content: H("  - id: ui\n    event: tool.after.read\n    actions:\n      - notify: one\n      - notify: two\n      - setStatus: s\n  - id: ask\n    event: tool.before.bash\n    actions:\n      - confirm: {message: \"Run it?\"}\n") }, { op: "mkdir", path: "f2" }] },
			{ op: "ctx", cwd: "f2", hasUI: false, session: "s" },
			{ op: "tool_result", tool: "read", id: "r1", input: { path: "a" } },
			{ op: "tool_result", tool: "read", id: "r2", input: { path: "b" } },
			{ op: "tool_call", tool: "bash", id: "b1", input: { command: "x" } },
			{ op: "env", set: { PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE: "1" } },
			{ op: "tool_call", tool: "bash", id: "b2", input: { command: "x" } },
			{ op: "env", set: { PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE: null } },
		],
	},
	{
		name: "confirm with ui",
		steps: [
			{ op: "fs", ops: [{ op: "write", path: GH, content: H("  - id: ask\n    event: tool.before.bash\n    actions:\n      - confirm: {title: Careful, message: \"Run it?\"}\n  - id: follow\n    event: tool.after.bash\n    actions:\n      - tool: {name: read, args: {path: README.md}}\n") }, { op: "mkdir", path: "f3" }] },
			{ op: "ctx", cwd: "f3", hasUI: true, session: "s3", confirms: [true, false] },
			{ op: "tool_call", tool: "bash", id: "b1", input: { command: "x" } },
			{ op: "tool_call", tool: "bash", id: "b2", input: { command: "x" } },
			{ op: "ctx", confirmThrows: true },
			{ op: "tool_call", tool: "bash", id: "b3", input: { command: "x" } },
			{ op: "tool_result", tool: "bash", id: "b3", input: { command: "x" } },
		],
	},
	{
		name: "prompt injection",
		responses: { "ctx-hook": { stdout: "Branch: main\n" } },
		steps: [
			{ op: "fs", ops: [{ op: "write", path: GH, content: H("  - id: ctx\n    event: user.prompt.submit\n    actions:\n      - bash: ctx-hook\n") }, { op: "mkdir", path: "f4" }] },
			{ op: "ctx", cwd: "f4", hasUI: true, session: "s4" },
			{ op: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "SYSTEM\n\n" },
			{ op: "before_agent_start", messageType: "custom", systemPrompt: "SYSTEM" },
			{ op: "ctx", hasUI: false },
			{ op: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "SYSTEM" },
			{ op: "env", set: { PI_YAML_HOOKS_PROMPT_AWARENESS: " Off " } },
			{ op: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "SYSTEM" },
			{ op: "ctx", session: "" },
			{ op: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "SYSTEM" },
			{ op: "env", set: { PI_YAML_HOOKS_PROMPT_AWARENESS: null } },
			{ op: "fs", ops: [{ op: "rm", path: GH }] },
			{ op: "ctx", session: "s4" },
			{ op: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "SYSTEM" },
			{ op: "fs", ops: [{ op: "write", path: "agent/hooks.yaml", content: "this: [is not valid hooks\n" }] },
			{ op: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "SYSTEM" },
			{ op: "fs", ops: [{ op: "rm", path: "agent/hooks.yaml" }] },
		],
	},
	{
		name: "commands",
		steps: [
			{ op: "fs", ops: [{ op: "write", path: GH, content: idle("g1") }, { op: "write", path: "f5/.pi/hook/hooks.yaml", content: idle("p1") }, { op: "rm", path: "agent/trusted-projects.json" }] },
			{ op: "ctx", cwd: "f5", hasUI: true, session: "s5" },
			{ op: "command", name: "hooks-status" },
			{ op: "command", name: "hooks-validate" },
			{ op: "command", name: "hooks-trust" },
			{ op: "command", name: "hooks-status" },
			{ op: "reset" },
			{ op: "command", name: "hooks-status" },
			{ op: "command", name: "hooks-validate" },
			{ op: "command", name: "hooks-trust" },
			{ op: "command", name: "hooks-tail-log" },
			{ op: "command", name: "hooks-tail-log", args: " --path " },
			{ op: "command", name: "hooks-reload" },
			{ op: "ctx", hasUI: false },
			{ op: "command", name: "hooks-reload" },
			{ op: "command", name: "hooks-tail-log", args: "--path" },
			{ op: "ctx", cwd: "f6", hasUI: true },
			{ op: "fs", ops: [{ op: "mkdir", path: "f6" }] },
			{ op: "command", name: "hooks-trust" },
			{ op: "command", name: "hooks-validate" },
			{ op: "command", name: "hooks-status" },
			{ op: "fs", ops: [{ op: "write", path: "f7/.pi/hook/hooks.yaml", content: H("  - id: bad\n    event: nope\n    actions:\n      - bash: x\n") }, { op: "write", path: GH, content: H("  - event: nope\n") }] },
			{ op: "ctx", cwd: "f7" },
			{ op: "command", name: "hooks-validate" },
			{ op: "fs", ops: [{ op: "write", path: "agent/trusted-projects.json", content: "{broken" }] },
			{ op: "command", name: "hooks-trust" },
			{ op: "fs", ops: [{ op: "write", path: "agent/trusted-projects.json", content: `["@@ROOT@@/f7", 3]\n` }] },
			{ op: "reset" },
			{ op: "command", name: "hooks-trust" },
			{ op: "command", name: "hooks-validate" },
		],
	},
];

const renderers: Array<(message: any, options: any, theme: any) => any> = [];
const ROLE_CODES: Record<string, number> = { accent: 36, success: 32, warning: 33, error: 31, muted: 90, dim: 2, text: 39 };
const roleCode = (role: string) => ROLE_CODES[role] ?? 37;
const goldenTheme = {
	fg: (role: string, text: string) => `\x1b[${roleCode(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${roleCode(role) + 10}m${text}\x1b[49m`,
};
const featureResults: unknown[] = [];
const sentMessages: any[] = [];
applyFs(cleanAgent);
for (const s of featureScenarios) {
	resetCaches();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const log: unknown[] = [];
	const asyncLog: unknown[] = [];
	const state = { cwd: root, hasUI: true, session: "s", header: undefined as unknown, confirms: [] as boolean[], confirmThrows: false };
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: (_type: string, renderer: any) => renderers.push(renderer),
		sendMessage: (message: any, options?: unknown) => {
			log.push({ op: "sendMessage", message, options: options ?? null });
			sentMessages.push(message);
		},
		sendUserMessage: (text: string, options: unknown) => log.push({ op: "sendUserMessage", text, options }),
		events: { emit: (channel: string, data: unknown) => log.push({ op: "emit", channel, data }) },
	};
	const ctx = () => ({
		cwd: state.cwd,
		hasUI: state.hasUI,
		mode: state.hasUI ? "tui" : "print",
		sessionManager: { getSessionId: () => state.session, getHeader: () => state.header ?? { type: "session", id: state.session } },
		ui: {
			notify: (text: string, level: string) => log.push({ op: "notify", text, level }),
			confirm: async (title: string, message: string) => {
				log.push({ op: "confirm", title, message });
				if (state.confirmThrows) throw new Error("dialog closed");
				return state.confirms.shift() ?? false;
			},
			setStatus: (key: string, text: string | undefined) => log.push({ op: "setStatus", key, text: text ?? null }),
		},
		reload: async () => log.push({ op: "reload" }),
	});
	const asyncCommands = new Set<string>();
	registerYamlHooks(pi as any, { runtimeOptions: { executeBash: bashMock(s.responses ?? {}, log, asyncLog, asyncCommands) } });
	const emit = async (event: string, payload: unknown) => {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx());
		return last;
	};
	const saved = { warn: console.warn, info: console.info, error: console.error };
	console.warn = (t: unknown) => log.push({ op: "console", level: "warn", text: String(t) });
	console.info = (t: unknown) => log.push({ op: "console", level: "info", text: String(t) });
	console.error = (t: unknown) => log.push({ op: "console", level: "error", text: String(t) });
	try {
		for (const step of s.steps) {
			log.push({ op: "step", step: step.op });
			switch (step.op) {
				case "fs":
					applyFsWithRoot(step.ops);
					break;
				case "ctx":
					if (step.cwd !== undefined) state.cwd = join(root, step.cwd);
					if (step.hasUI !== undefined) state.hasUI = step.hasUI;
					if (step.session !== undefined) state.session = step.session;
					if (step.header !== undefined) state.header = step.header;
					if (step.confirms !== undefined) state.confirms = [...step.confirms];
					if (step.confirmThrows !== undefined) state.confirmThrows = step.confirmThrows;
					break;
				case "env":
					for (const [k, v] of Object.entries(step.set)) {
						if (v === null) delete process.env[k];
						else process.env[k] = v;
					}
					break;
				case "reset":
					resetCaches();
					break;
				case "session_start":
					await emit("session_start", { type: "session_start", reason: step.reason });
					break;
				case "before_switch":
					await emit("session_before_switch", { type: "session_before_switch", reason: step.reason });
					break;
				case "shutdown":
					await emit("session_shutdown", { type: "session_shutdown", reason: step.reason });
					break;
				case "tool_call":
					log.push({ op: "result", value: (await emit("tool_call", { type: "tool_call", toolName: step.tool, toolCallId: step.id, input: step.input })) ?? null });
					break;
				case "tool_result":
					log.push({ op: "result", value: (await emit("tool_result", { type: "tool_result", toolName: step.tool, toolCallId: step.id, input: step.input, content: [], isError: false })) ?? null });
					break;
				case "before_agent_start":
					log.push({ op: "result", value: (await emit("before_agent_start", { type: "before_agent_start", messageType: step.messageType, prompt: step.prompt, systemPrompt: step.systemPrompt })) ?? null });
					break;
				case "command":
					try {
						await commands.get(step.name).handler(step.args ?? "", ctx());
					} catch (error) {
						log.push({ op: "error", message: error instanceof Error ? error.message : String(error) });
					}
					break;
				case "flush":
					await new Promise((r) => setTimeout(r, 30));
					break;
			}
		}
	} finally {
		Object.assign(console, saved);
	}
	const trust = (() => {
		try {
			return readFileSync(join(agentDir, "trusted-projects.json"), "utf8");
		} catch {
			return null;
		}
	})();
	featureResults.push(norm({ ...s, log, trustFile: trust }));
}

// ---- diagnostics renders ----
const renderMessages = [
	...sentMessages.slice(0, 3),
	{ customType: "aio-yaml-hooks-diagnostics", content: [{ type: "text", text: "block " }, { type: "image" }, { type: "text", text: "content" }], details: { title: "T", level: "error", sections: [{ label: "S", lines: ["a\tb", "wide 漢字 text that wraps around the narrow width"] }] } },
	{ customType: "aio-yaml-hooks-diagnostics", content: "no details" },
];
const renders: unknown[] = [];
for (const message of renderMessages) {
	for (const expanded of [false, true]) {
		for (const width of [24, 80]) {
			const normalized = norm(message);
			const component = renderers[0]!(normalized, { expanded }, goldenTheme);
			renders.push(norm({ message: normalized, expanded, width, lines: component.render(width) }));
		}
	}
}

rmSync(root, { recursive: true, force: true });

const output = `${JSON.stringify(
	{
		constants: { maxHooksYamlBytes: envelope.MAX_HOOKS_YAML_BYTES, nocase },
		yamlValues,
		schema,
		readFailure,
		overrides: overrideCases,
		discoveries,
		extnames,
		normalize: normalizeCases,
		globs,
		conditions: conditionCases,
		redactions,
		sanitize,
		stdin: stdinCases,
		trims: { bytes: [...utf8Bytes], cases: trims, corrupt: trimCorrupt },
		env: envCases,
		mapResults: mapCases,
		bash: bashRuns,
		session: sessionScripts,
		lineage: { fs: lineageFs, cases: lineageCases },
		runtime: runtimeResults,
		scenarios: featureResults,
		renders,
	},
	null,
	1,
)}\n`;
const goldenPath = join(here, "golden.json");
const counts = `${yamlValues.length} YAML values, ${schema.length} schema files, ${overrideCases.length} override sets, ${discoveries.length} discoveries, ${globs.length} globs, ${conditionCases.length} condition sets, ${redactions.length} redactions, ${bashRuns.length} bash runs, ${lineageCases.length} lineage reads, ${runtimeResults.length} runtime scenarios, ${featureResults.length} feature scenarios, ${renders.length} renders`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("yamlhooks golden.json is stale: run npx tsx go/internal/yamlhooks/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`yamlhooks golden.json is current (${counts})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`yamlhooks golden.json: ${counts}`);
}
