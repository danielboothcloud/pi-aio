// Regenerate golden.json from the TypeScript ast-grep tool (the reference):
//   npx tsx go/internal/astgrep/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const schema = await import(join(repo, "ast-grep", "schema.ts"));
const cli = await import(join(repo, "ast-grep", "cli.ts"));
const output = await import(join(repo, "ast-grep", "output.ts"));

const inputs: Array<Record<string, unknown>> = [
	{ pattern: "console.log($A)" },
	{ kind: "call_expression", language: "ts", paths: ["@src", " lib "], globs: ["!**/*.test.ts", "*.ts"], context: 2, strictness: "ast", selector: "x" },
	{ command: "scan", rule: "@rules/a.yml", config: " sgconfig.yml " },
	{ command: "scan", inlineRules: "id: x\nrule:\n  pattern: $A" , json: "stream", maxResults: 3, timeoutMs: 5000, includeRaw: true },
	{ pattern: "a", before: 1, after: 2 },
	{},
	{ pattern: "a", kind: "b" },
	{ pattern: "a", rule: "r" },
	{ command: "scan", pattern: "a" },
	{ command: "scan", context: 1 },
	{ pattern: "a", context: 1, before: 1 },
	{ pattern: "   " },
	{ pattern: "a", config: "@" },
	{ pattern: "a", paths: ["ok", "  "] },
	{ pattern: "a", paths: ["@ "] },
	{ pattern: "a", globs: ["x", " "] },
	{ pattern: "a b", paths: [] },
	{ pattern: "it's $X" },
];
const normalized = inputs.map((params) => {
	try {
		const input = schema.normalizeAstGrepInput(params);
		const args = cli.buildAstGrepArgs(input);
		return { params, input, args, command: cli.formatCommand("/bin/ast-grep", args) };
	} catch (error) {
		return { params, error: (error as Error).message };
	}
});

const m = (extra: Record<string, unknown>) => ({ file: "src/a.ts", range: { start: { line: 4, column: 2 } }, text: "console.log(x)", ...extra });
const matchSets: Array<Record<string, unknown>[]> = [
	[],
	[m({})],
	[m({ language: "TypeScript", lines: "  console.log(\n   x)  ", metaVariables: { single: { A: { text: "x\n y" }, B: { text: "b" }, C: {}, D: { text: "d" }, E: { text: "e" }, F: { text: "f" } } } })],
	[m({ ruleId: "no-log", severity: "warning", message: "  avoid\nconsole  " }), m({ ruleId: "r2", file: undefined, range: undefined }), { text: "x".repeat(400) }, m({ lines: "日本".repeat(200) })],
];
const summaries = matchSets.flatMap((matches) => [0, 1, 200].map((maxResults) => {
	const input = schema.normalizeAstGrepInput({ pattern: "x", maxResults });
	return { maxResults, matches, ...output.formatMatchSummary(input, matches) };
}));

const parses = [["", "compact"], ["[]", "compact"], ['{"a":1}', "compact"], ["[1,2]", "compact"], ["5", "compact"], ["{bad", "compact"],
	['{"a":1}\n\n{"b":2}\r\n[{"c":3}]', "stream"], ['{"a":1}\nnope', "stream"], ["", "stream"]].map(([stdout, mode]) => {
	try {
		return { stdout, mode, matches: output.parseAstGrepJson(stdout, mode) };
	} catch (error) {
		return { stdout, mode, error: (error as Error).message.split(":")[0] };
	}
});

const proc = (extra: Record<string, unknown>) => ({ command: "ast-grep", args: [], cwd: "/w", code: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, ...extra });
const processes = [proc({}), proc({ code: 1, stdout: "[]" }), proc({ code: 1, stdout: "" }), proc({ code: 1, stdout: "[]", stderr: "boom" }), proc({ code: 2, stderr: "bad pattern" }),
	proc({ code: null, signal: "SIGTERM", stdout: "x" }), proc({ timedOut: true }), proc({ aborted: true }), proc({ code: 3, stderr: "e\n".repeat(300) }), proc({ code: 1, stdout: "[{}]" })];
const outcomes = processes.flatMap((p) => [[], [{}]].map((matches) => ({ process: p, matches: matches.length, success: output.shouldTreatExitCodeAsSuccess(p as never, matches), failure: output.buildCliFailureMessage(p as never) })));

const big = Array.from({ length: 2500 }, (_, i) => ({ file: `f${i}.ts`, range: { start: { line: i, column: 0 } }, text: `call(${i})` }));
const results: unknown[] = [];
for (const [name, params, matches, stdout] of [["small", { pattern: "x" }, [m({})], "[{}]"], ["raw", { pattern: "x", includeRaw: true }, [], "  "], ["big", { pattern: "x", maxResults: 1000 }, big, "[]"]] as const) {
	const input = schema.normalizeAstGrepInput(params);
	const result = await output.buildAstGrepToolResult(input, ["run"], proc({ stdout }) as never, matches as never);
	const text = result.content[0].text.replace(/Full output saved to: \S+\]$/, "Full output saved to: @@PATH@@]");
	results.push({ name, params, matches: matches.length, text, shownCount: result.details.shownCount, truncated: !!result.details.truncation });
}

const doc = `${JSON.stringify({ normalized, summaries, parses, outcomes, results }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== doc) {
		console.error("ast-grep golden.json is stale: run npx tsx go/internal/astgrep/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`ast-grep golden.json is current (${normalized.length} inputs)`);
} else {
	writeFileSync(goldenPath, doc);
	console.log(`ast-grep golden.json: ${normalized.length} inputs, ${summaries.length} summaries, ${outcomes.length} outcomes`);
}
