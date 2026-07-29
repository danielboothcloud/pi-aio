import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAstGrepArgs, shellQuote } from "./cli.ts";
import {
	formatMatchSummary,
	parseAstGrepJson,
	shouldTreatExitCodeAsSuccess,
} from "./output.ts";
import { normalizeAstGrepInput } from "./schema.ts";

// ---------------------------------------------------------------------------
// schema.ts — normalizeAstGrepInput
// ---------------------------------------------------------------------------

test("normalizeAstGrepInput: run defaults and requires pattern or kind", () => {
	const input = normalizeAstGrepInput({ pattern: "x" });
	assert.equal(input.command, "run");
	assert.equal(input.maxResults, 200);
	assert.equal(input.timeoutMs, 30_000);
	assert.equal(input.json, "compact");

	assert.throws(
		() => normalizeAstGrepInput({ command: "run" }),
		/requires either pattern or kind/,
	);
	assert.throws(
		() =>
			normalizeAstGrepInput({
				pattern: "console.log($A)",
				kind: "call_expression",
			}),
		/pattern or kind, not both/,
	);
});

test("normalizeAstGrepInput: pattern and kind are mutually exclusive", () => {
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", kind: "y" }),
		/pattern or kind, not both/,
	);
});

test("normalizeAstGrepInput: scan mode rejects run-only fields", () => {
	assert.throws(
		() => normalizeAstGrepInput({ command: "scan", pattern: "x" }),
		/only valid with command=run/,
	);
	assert.throws(
		() => normalizeAstGrepInput({ command: "scan", kind: "x" }),
		/only valid with command=run/,
	);
});

test("normalizeAstGrepInput: run mode rejects scan-only fields", () => {
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", rule: "rules/x.yml" }),
		/only valid with command=scan/,
	);
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", inlineRules: "id: x" }),
		/only valid with command=scan/,
	);
});

test("normalizeAstGrepInput: context is mutually exclusive with before/after", () => {
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", context: 2, before: 1 }),
		/mutually exclusive/,
	);
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", context: 2, after: 1 }),
		/mutually exclusive/,
	);
});

test("normalizeAstGrepInput: strips leading @ from path-like fields", () => {
	// config and paths are valid in both modes; test under run.
	const runInput = normalizeAstGrepInput({
		pattern: "x",
		paths: ["@./src", "@/abs/path"],
		config: "@/sgconfig.yml",
	});
	assert.deepEqual(runInput.paths, ["./src", "/abs/path"]);
	assert.equal(runInput.config, "/sgconfig.yml");

	// rule is scan-only; test under scan.
	const scanInput = normalizeAstGrepInput({
		command: "scan",
		rule: "@/rules/x.yml",
	});
	assert.equal(scanInput.rule, "/rules/x.yml");
});

test("normalizeAstGrepInput: empty paths defaults to ['.']", () => {
	assert.deepEqual(normalizeAstGrepInput({ pattern: "x" }).paths, ["."]);
	assert.deepEqual(normalizeAstGrepInput({ pattern: "x", paths: [] }).paths, [
		".",
	]);
});

test("normalizeAstGrepInput: rejects empty strings for required-ish fields", () => {
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "   " }),
		/must not be empty/,
	);
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", rule: "  " }),
		/must not be empty/,
	);
});

test("normalizeAstGrepInput: globs pass through cleaned", () => {
	const input = normalizeAstGrepInput({
		pattern: "x",
		globs: ["*.ts", "!*.test.ts"],
	});
	assert.deepEqual(input.globs, ["*.ts", "!*.test.ts"]);
	assert.throws(
		() => normalizeAstGrepInput({ pattern: "x", globs: ["  "] }),
		/must not be empty/,
	);
});

// ---------------------------------------------------------------------------
// cli.ts — buildAstGrepArgs
// ---------------------------------------------------------------------------

test("buildAstGrepArgs: run with pattern", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({ pattern: "console.log($A)", language: "ts" }),
	);
	assert.deepEqual(args, [
		"run",
		"--json=compact",
		"--pattern",
		"console.log($A)",
		"--lang",
		"ts",
		".",
	]);
});

test("buildAstGrepArgs: run with kind and globs", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({
			kind: "call_expression",
			language: "ts",
			globs: ["*.ts"],
			paths: ["src"],
		}),
	);
	assert.deepEqual(args, [
		"run",
		"--json=compact",
		"--globs",
		"*.ts",
		"--kind",
		"call_expression",
		"--lang",
		"ts",
		"src",
	]);
});

test("buildAstGrepArgs: run with strictness and context", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({ pattern: "x", strictness: "smart", context: 3 }),
	);
	assert.deepEqual(args, [
		"run",
		"--json=compact",
		"--pattern",
		"x",
		"--strictness",
		"smart",
		"--context",
		"3",
		".",
	]);
});

test("buildAstGrepArgs: scan with rule file", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({
			command: "scan",
			rule: "rules/no-console.yml",
			paths: ["src"],
		}),
	);
	assert.deepEqual(args, [
		"scan",
		"--json=compact",
		"--rule",
		"rules/no-console.yml",
		"src",
	]);
});

test("buildAstGrepArgs: scan with inline rules and config", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({
			command: "scan",
			config: "sgconfig.yml",
			inlineRules: "id: x\nrule: {kind: any}\n",
		}),
	);
	// cleanOptionalString trims, so the trailing newline is dropped.
	assert.deepEqual(args, [
		"--config",
		"sgconfig.yml",
		"scan",
		"--json=compact",
		"--inline-rules",
		"id: x\nrule: {kind: any}",
		".",
	]);
});

test("buildAstGrepArgs: stream json mode", () => {
	const args = buildAstGrepArgs(
		normalizeAstGrepInput({ pattern: "x", json: "stream" }),
	);
	assert.deepEqual(args, ["run", "--json=stream", "--pattern", "x", "."]);
});

test("shellQuote: leaves safe strings unquoted, quotes the rest", () => {
	assert.equal(shellQuote("ast-grep"), "ast-grep");
	assert.equal(shellQuote("./src/file.ts"), "./src/file.ts");
	assert.equal(shellQuote("console.log($A)"), "'console.log($A)'");
	assert.equal(shellQuote("it's"), "'it'\"'\"'s'");
});

// ---------------------------------------------------------------------------
// output.ts — parseAstGrepJson
// ---------------------------------------------------------------------------

test("parseAstGrepJson: empty stdout yields no matches", () => {
	assert.deepEqual(parseAstGrepJson("", "compact"), []);
	assert.deepEqual(parseAstGrepJson("   \n  ", "stream"), []);
});

test("parseAstGrepJson: compact array", () => {
	const out = JSON.stringify([
		{
			file: "a.ts",
			lines: "console.log(1)",
			range: { start: { line: 0, column: 0 } },
		},
	]);
	const matches = parseAstGrepJson(out, "compact");
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.file, "a.ts");
});

test("parseAstGrepJson: compact single object", () => {
	const out = JSON.stringify({ file: "a.ts", lines: "x" });
	const matches = parseAstGrepJson(out, "compact");
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.file, "a.ts");
});

test("parseAstGrepJson: stream NDJSON", () => {
	const out = [
		JSON.stringify({ file: "a.ts", lines: "x" }),
		JSON.stringify({ file: "b.ts", lines: "y" }),
	].join("\n");
	const matches = parseAstGrepJson(out, "stream");
	assert.equal(matches.length, 2);
	assert.equal(matches[0]?.file, "a.ts");
	assert.equal(matches[1]?.file, "b.ts");
});

test("parseAstGrepJson: stream skips blank lines", () => {
	const out = [
		JSON.stringify({ file: "a.ts" }),
		"",
		"  ",
		JSON.stringify({ file: "b.ts" }),
	].join("\n");
	const matches = parseAstGrepJson(out, "stream");
	assert.equal(matches.length, 2);
});

test("parseAstGrepJson: throws descriptive error on invalid compact JSON", () => {
	assert.throws(
		() => parseAstGrepJson("not json", "compact"),
		/could not be parsed/,
	);
});

test("parseAstGrepJson: throws descriptive error on invalid stream line", () => {
	assert.throws(
		() => parseAstGrepJson("not json", "stream"),
		/could not be parsed/,
	);
});

// ---------------------------------------------------------------------------
// output.ts — formatMatchSummary
// ---------------------------------------------------------------------------

test("formatMatchSummary: reports count and location", () => {
	const { text, shownCount } = formatMatchSummary(
		normalizeAstGrepInput({ pattern: "x" }),
		[
			{
				file: "a.ts",
				lines: "console.log(1)",
				range: { start: { line: 0, column: 0 } },
			},
		],
	);
	assert.equal(shownCount, 1);
	assert.match(text, /found 1 match\./);
	assert.match(text, /a\.ts:1:1/);
	assert.match(text, /code: console\.log\(1\)/);
});

test("formatMatchSummary: respects maxResults", () => {
	const matches = Array.from({ length: 5 }, (_, i) => ({ file: `${i}.ts` }));
	const { shownCount, text } = formatMatchSummary(
		normalizeAstGrepInput({ pattern: "x", maxResults: 2 }),
		matches as never,
	);
	assert.equal(shownCount, 2);
	assert.match(text, /found 5 matches\./);
	assert.match(text, /3 omitted by maxResults=2/);
});

test("formatMatchSummary: includes rule id and severity for scan matches", () => {
	const { text } = formatMatchSummary(
		normalizeAstGrepInput({ command: "scan", rule: "r.yml" }),
		[
			{
				file: "a.ts",
				ruleId: "no-console",
				severity: "warning",
				message: "remove console",
			},
		],
	);
	assert.match(text, /\[no-console\/warning\]/);
	assert.match(text, /message: remove console/);
});

// ---------------------------------------------------------------------------
// output.ts — shouldTreatExitCodeAsSuccess
// ---------------------------------------------------------------------------

const ok = { code: 0, timedOut: false, aborted: false } as never;
const oneNoMatchesEmpty = {
	code: 1,
	timedOut: false,
	aborted: false,
	stderr: "",
	stdout: "[]",
} as never;

test("shouldTreatExitCodeAsSuccess: exit 0 is success", () => {
	assert.equal(shouldTreatExitCodeAsSuccess(ok, []), true);
});

test("shouldTreatExitCodeAsSuccess: exit 1 with [] and no stderr is success (no-match search)", () => {
	assert.equal(shouldTreatExitCodeAsSuccess(oneNoMatchesEmpty, []), true);
});

test("shouldTreatExitCodeAsSuccess: exit 1 with stderr is failure", () => {
	assert.equal(
		shouldTreatExitCodeAsSuccess(
			{ ...oneNoMatchesEmpty, stderr: "error: bad pattern" } as never,
			[],
		),
		false,
	);
});

test("shouldTreatExitCodeAsSuccess: timeout/abort are failures", () => {
	assert.equal(
		shouldTreatExitCodeAsSuccess({ ...ok, timedOut: true } as never, []),
		false,
	);
	assert.equal(
		shouldTreatExitCodeAsSuccess({ ...ok, aborted: true } as never, []),
		false,
	);
});
