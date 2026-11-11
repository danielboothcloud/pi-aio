// Regenerate golden.json from the TypeScript diff-tools feature (the reference):
//   npx tsx go/internal/difftools/testdata/gen-golden.ts [--check]
// It drives the real modules: the diff parsers and separator labels, text
// encoding, merge conflicts, the cascading replace engine, Cursor argument
// normalization, apply_patch preview/execute on fixture files (rollback
// included), hashline anchors and file edits, mutation previews, the
// pi-diff.json config, the git review helpers on a fixture repository, the
// edit guard, and registerDiffTools' write/edit/apply_patch execute and
// renderers, the hunk-preview renderers, and the approval overlay
// (showMutationApproval and ApprovalDialog key sequences). Shiki is
// replaced by testdata/shiki-stub.mjs. Fixture paths are written as @@ROOT@@.
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "agent"), { recursive: true });
mkdirSync(join(root, "home"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.HOME = join(root, "home");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of Object.keys(process.env)) if (key.startsWith("DIFF_") || key.startsWith("PI_DIFF_")) delete process.env[key];
Object.defineProperty(process.stdout, "columns", { value: 104, configurable: true });
Object.defineProperty(process.stderr, "columns", { value: 104, configurable: true });
const work = join(root, "work");
mkdirSync(work, { recursive: true });
process.chdir(work);

register(pathToFileURL(join(here, "shiki-hooks.mjs")).href);

const diffCore = await import(join(repo, "diff-tools", "core", "diff.ts"));
const encoding = await import(join(repo, "diff-tools", "core", "text-encoding.ts"));
const conflicts = await import(join(repo, "diff-tools", "core", "conflicts.ts"));
const replaceMod = await import(join(repo, "diff-tools", "core", "replace.ts"));
const cursor = await import(join(repo, "diff-tools", "core", "cursor-compat.ts"));
const applyPatch = await import(join(repo, "diff-tools", "core", "apply-patch.ts"));
const config = await import(join(repo, "diff-tools", "core", "config.ts"));
const preview = await import(join(repo, "diff-tools", "core", "mutation-preview.ts"));
const hashline = await import(join(repo, "diff-tools", "hashline.ts"));
const hashlineEdit = await import(join(repo, "diff-tools", "core", "hashline-edit.ts"));
const hashlineExec = await import(join(repo, "diff-tools", "core", "hashline-execute.ts"));
const git = await import(join(repo, "diff-tools", "review", "git.ts"));
const hunk = await import(join(repo, "diff-tools", "review", "hunk-preview.ts"));
const collapsed = await import(join(repo, "diff-tools", "collapsed-hint.ts"));
const guard = await import(join(repo, "diff-tools", "edit-guard.ts"));
const index = await import(join(repo, "diff-tools", "index.ts"));
const approval = await import(join(repo, "permission-modes", "approval-dialog.ts"));
await hashline.initHashline();

/** JSON.parse with the failing input named in the error. */
function parseJSON<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`cannot parse ${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const clone = <T>(value: T): T => parseJSON<T>(JSON.stringify(value), "a cloned value");
function readRoleCodes(): Record<string, number> {
	const path = join(repo, "go", "internal", "chrome", "testdata", "golden.json");
	return parseJSON<{ roleCodes: Record<string, number> }>(readFileSync(path, "utf8"), path).roleCodes;
}
const ROLE_CODES = readRoleCodes();
/** 24-bit colors the test theme's getFgAnsi/getBgAnsi return. Shared with the Go test. */
const FG_RGB: Record<string, string> = { toolDiffAdded: "80;200;120", toolDiffRemoved: "220;90;90", toolDiffContext: "150;150;150", accent: "0;180;200" };
const BG_RGB: Record<string, string> = { toolSuccessBg: "20;30;25", toolErrorBg: "40;20;20" };
const code = (role: string) => ROLE_CODES[role] ?? 37;
const theme = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${code(role) + 10}m${text}\x1b[49m`,
	getFgAnsi: (role: string) => {
		if (!FG_RGB[role]) throw new Error(`Unknown theme color: ${role}`);
		return `\x1b[38;2;${FG_RGB[role]}m`;
	},
	getBgAnsi: (role: string) => {
		if (!BG_RGB[role]) throw new Error(`Unknown theme color: ${role}`);
		return `\x1b[48;2;${BG_RGB[role]}m`;
	},
};

function ph<T>(value: T): T {
	if (value === undefined) return value;
	return parseJSON<T>(JSON.stringify(value).split(root).join("@@ROOT@@"), "a placeholder substitution");
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type Setup = { files?: Record<string, string>; modes?: Record<string, number>; symlinks?: Record<string, string>; dirs?: string[] };

function applySetup(dir: string, setup: Setup): void {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const d of setup.dirs ?? []) mkdirSync(join(dir, d), { recursive: true });
	for (const [rel, content] of Object.entries(setup.files ?? {})) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), content);
		chmodSync(join(dir, rel), setup.modes?.[rel] ?? 0o644);
	}
	for (const [rel, target] of Object.entries(setup.symlinks ?? {})) symlinkSync(target, join(dir, rel));
}

function tree(dir: string): Record<string, { content?: string; mode?: number; link?: boolean; dir?: boolean }> {
	const out: Record<string, { content?: string; mode?: number; link?: boolean; dir?: boolean }> = {};
	const walk = (rel: string) => {
		for (const name of readdirSync(join(dir, rel)).sort()) {
			const r = rel ? `${rel}/${name}` : name;
			const st = lstatSync(join(dir, r));
			if (st.isSymbolicLink()) out[r] = { link: true };
			else if (st.isDirectory()) {
				out[r] = { dir: true };
				walk(r);
			} else out[r] = { content: readFileSync(join(dir, r), "utf8"), mode: st.mode & 0o777 };
		}
	};
	walk("");
	return out;
}

const subst = <T>(value: T, dir: string): T => parseJSON<T>(JSON.stringify(value).split("@@DIR@@").join(dir), "a fixture substitution");

// ---------------------------------------------------------------------------
// core/diff.ts
// ---------------------------------------------------------------------------

const diffPairs: Array<[string, string]> = [
	["", ""],
	["a\n", "b\n"],
	["one\ntwo\nthree\n", "one\nTWO\nthree\n"],
	["x\n", ""],
	["", "fresh\nfile\n"],
	["no newline", "no newline\n"],
	[Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"), Array.from({ length: 30 }, (_, i) => (i === 3 || i === 24 ? `LINE ${i + 1}` : `line ${i + 1}`)).join("\n")],
	["function foo() {\n\treturn 1;\n}\n", "function foo() {\n\treturn 2;\n}\n\nfunction bar() {}\n"],
	["漢字\n🙂 emoji\n", "漢字\n🙂 emoji!\n"],
	["a\r\nb\r\n", "a\r\nB\r\n"],
];
const parseDiffCases = diffPairs.flatMap(([a, b]) => [0, 1, 3].map((ctx) => ({ a, b, ctx, out: diffCore.parseDiff(a, b, ctx) })));
const patches: string[] = [
	"",
	"diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ function foo() {\n one\n-two\n+TWO\n three\n@@ -10 +10,2 @@\n ten\n+eleven\n",
	"--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n--- a/y\n+++ b/y\n@@ -5,0 +6 @@  ctx here  \n+new\n",
	"@@ -1 +1 @@\r\n-a\n+b\n",
	"@@ -2,2 +2,2 @@ foo\r\n x\n-y\n+z\n",
	"not a patch at all\n",
	"diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n",
	"@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n",
];
const parsePatchCases = patches.map((patch) => ({ patch, out: diffCore.parsePatchFiles(patch) }));
const sepCases: unknown[] = [];
const metas = [undefined, { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, context: "function foo()" }];
for (const style of ["auto", "simple", "gap", "context", "metadata", "bogus"]) {
	for (const meta of metas) {
		for (const gap of [null, 0, 5]) {
			for (const content of ["", "───── Edit 2 ─────"]) {
				sepCases.push({ style, meta: meta ?? null, gap, content, unified: diffCore.sepLabelUnified(style, meta, gap, content), split: diffCore.sepLabelSplit(style, meta, gap, content) });
			}
		}
	}
}
const sepStyleCases = ["", "auto", "gap", "context", "metadata", "simple", "nope"].map((env) => {
	if (env) process.env.PI_DIFF_SEP_STYLE = env;
	else delete process.env.PI_DIFF_SEP_STYLE;
	return { env, out: diffCore.resolveSepStyle() };
});
delete process.env.PI_DIFF_SEP_STYLE;
diffCore.resolveSepStyle();
const hunkBlockCases = diffPairs.map(([a, b]) => {
	const diff = diffCore.parseDiff(a, b);
	return { diff, out: diffCore.computeHunkBlocks(diff) };
});

// ---------------------------------------------------------------------------
// text-encoding, conflicts, collapsed hint
// ---------------------------------------------------------------------------

const encodingTexts = ["", "plain\n", "\uFEFFbom\r\nline\r\n", "mixed\r\nends\nhere\r", "lf first\nthen\r\ncrlf", "cr\ronly", "\uFEFF", "a\r\n"];
const encodingCases = encodingTexts.map((text) => {
	const prepared = encoding.prepareTextForHashlineEdit(text);
	return {
		text,
		strip: encoding.stripBom(text),
		ending: encoding.detectLineEnding(text),
		lf: encoding.normalizeToLF(text),
		crlf: encoding.restoreLineEndings(text, "\r\n"),
		prepared,
		final: encoding.finalizeHashlineWriteContent(prepared.bom, prepared.ending, prepared.normalized),
	};
});
const conflictTexts = [
	"no conflicts here\n",
	"a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nb\n",
	"<<<<<<<\nx\n||||||| base\nbase line\n=======\ny\nz\n>>>>>>>   other  \n",
	"<<<<<<< open\nnever closed\n=======\nstill\n",
	"text\n<<<<<<<\tTAB\n1\n=======\n2\n>>>>>>> t\n<<<<<<< second\n3\n=======\n>>>>>>>\n",
	"prefix <<<<<<< not at start\n",
	"line\r<<<<<<< after cr\n",
	"<<<<<<<x\n",
];
const conflictCases = conflictTexts.map((text) => {
	const parsed = conflicts.parseConflicts(text);
	return { text, parsed, has: conflicts.hasConflictMarkers(text), summaries: parsed.regions.map((r: unknown) => conflicts.formatConflictSummary(r)) };
});
const collapsedCases = ["3 lines", "", "12 edits"].map((label) => ({ label, out: collapsed.collapsedSummaryLine(label) }));

// ---------------------------------------------------------------------------
// core/replace.ts
// ---------------------------------------------------------------------------

type ReplaceInput = { content: string; old: string; new: string; all?: boolean };
const replaceInputs: ReplaceInput[] = [
	{ content: "hello world", old: "world", new: "there" },
	{ content: "hello world", old: "nope", new: "there" },
	{ content: "hello", old: "", new: "world" },
	{ content: "hello", old: "hello", new: "hello" },
	{ content: "foo bar foo", old: "foo", new: "baz" },
	{ content: "foo bar foo baz foo", old: "foo", new: "qux", all: true },
	{ content: "price: 5", old: "5", new: "$$ $& $` $' $1 $<n> $", all: true },
	{ content: "price: 5 and 5", old: "5", new: "[$&]", all: true },
	{ content: "a\nb", old: "a", new: "$&$&" },
	{ content: "function foo() {\n    const x = 1;\n    return x;\n}", old: "  const x = 1;\n  return x;", new: "  const y = 2;\n  return y;" },
	{ content: "one\n  two  \nthree", old: "two", new: "TWO" },
	{ content: "hello\nworld\n", old: "nope\nnever", new: "gone" },
	{ content: "const a = \"x\";\nconst b = 'y';\n", old: "const a = \\\"x\\\";\\nconst b = 'y';", new: "const a = 1;\nconst b = 2;" },
	{ content: "line1\nline2\n", old: "line1\\nline2", new: "L1\nL2" },
	{ content: "tab\there\n", old: "tab\\there", new: "tabs" },
	{ content: "x\\ny", old: "x\\\\ny", new: "z" },
	{ content: "money $5\n", old: "money \\$5", new: "cash" },
	{ content: "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n", old: "function f() {\n  const a = 10;\n  const b = 20;\n  return a + b;\n}", new: "function f() {}" },
	{ content: "start\n  alpha();\n  beta();\nend\nstart\n  gamma();\n  delta();\nend\n", old: "start\n  alpha();\n  betaX();\nend", new: "REPLACED" },
	{ content: "start\n  alpha();\n  beta();\nend\nstart\n  alpha();\n  beta();\nend\n", old: "start\n  alpha();\n  bxta();\nend", new: "REPLACED" },
	{ content: "start\n  completely();\n  different();\nend\n", old: "start\n  zzz();\n  yyy();\nend", new: "R" },
	{ content: "if (a  &&   b) {\n  run();\n}", old: "if (a && b) {", new: "if (c) {" },
	{ content: "x =   1\ny = 2\nx = 1\n", old: "x = 1", new: "x = 9" },
	{ content: "one\n  a   b\n  c d\ntwo\n", old: "a b\nc   d\n", new: "AB\nCD" },
	{ content: "keep  this  \n", old: "   keep  this  ", new: "kept" },
	{ content: "  indented block\n  second\n", old: "\n  indented block\n  second\n\n", new: "x" },
	{ content: "dup\ndup\n", old: "dup", new: "one", all: true },
	{ content: "  dup\n    dup\n", old: "dup\n", new: "X\n" },
	{ content: "  dup\n    dup\n", old: " dup ", new: "Y", all: true },
	{ content: "a\n\nb\n", old: "\n", new: "-" },
	{ content: "alpha\nbeta\ngamma", old: "beta\ngamma\n", new: "B\nG" },
	{ content: "漢字 テキスト\n🙂 face\n", old: "🙂 face", new: "😀 face" },
	{ content: "café\n", old: "cafe", new: "x" },
	{ content: "x\r\ny\r\n", old: "x\ny", new: "z" },
	{ content: "x\r\ny\r\n", old: "x\r\ny", new: "z" },
	{ content: "  foo();\n  bar();\n", old: "foo();\nbar();", new: "baz();\nqux();" },
	{ content: "class A {\n  method() {\n    return 1;\n  }\n}\n", old: "method() {\n  return 1;\n}", new: "method() {\n  return 2;\n}" },
];
const replaceCases = replaceInputs.map((c) => ({ ...c, out: replaceMod.replace(c.content, c.old, c.new, c.all ? { replaceAll: true } : undefined) }));
const patchReplaceInputs: ReplaceInput[] = [
	{ content: "a\nb\nc\n", old: "b", new: "B" },
	{ content: "a b a\n", old: "a", new: "x" },
	{ content: "x\n  y = 1;\n  z = 2;\n", old: "y = 1;\nz = 2;", new: "y = 3;\nz = 4;" },
	{ content: "x\n  y = 1;\n  z = 2;\n", old: "  y = 1;\n  z = 2;", new: "  y = 3;\n  z = 4;" },
	{ content: "if (x) {\n\treturn 1;\n}\n", old: "    return 1;", new: "    return 2;" },
	{ content: "if (x) {\n    return 1;\n    log();\n}\n", old: "return 1;\nlog();\n", new: "return 2;\nlog();\n" },
	{ content: "  a\n    b\n", old: "    a\n      b", new: "    A\n      B" },
	{ content: "  a\n    b\n", old: "    a\n      b", new: "  A\nB" },
	{ content: "  a\n   b\n", old: "a\nb", new: "x\ny" },
	{ content: "  val = 1\n", old: "  val = 1", new: "    val = 2" },
	{ content: "    val = 1\n", old: "  val = 1", new: "    val = 2" },
	{ content: "x = 1;\n", old: "x = 1;", new: "x = 1;" },
	{ content: "x = 1;\n", old: "", new: "y" },
	{ content: "a\r\n  b\r\n  c\r\n", old: "b\nc", new: "B\nC" },
	{ content: "a\r\n  b\r\n  c\r\nd", old: "b\nc\n", new: "B\nC\n" },
	{ content: "\nstart\n", old: "\nstart", new: "\nbegin" },
	{ content: "dup\n  dup\n", old: "dup", new: "x" },
	{ content: "  one\n  one\n", old: "one\n", new: "two\n" },
	{ content: "f(a, b)\n", old: "f(a,b)", new: "g()" },
];
const patchReplaceCases = patchReplaceInputs.map((c) => ({ ...c, out: replaceMod.replaceForPatch(c.content, c.old, c.new) }));

// ---------------------------------------------------------------------------
// core/cursor-compat.ts
// ---------------------------------------------------------------------------

const editInputs: Array<Record<string, unknown>> = [
	{ path: "a.ts", oldText: "x", newText: "y" },
	{ path: "a.ts", old_string: "x", new_string: "y" },
	{ path: "a.ts", old_text: "x", new_text: "x" },
	{ path: "a.ts", oldText: "", newText: "y" },
	{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }, { old_string: "c", new_string: "d" }, null, "str", { oldText: "e", newText: "e" }, { oldText: 5, old_text: "f", newText: "g" }] },
	{ path: "a.ts", edits: [] },
	{ path: "a.ts", oldText: 1, old_string: "s", newText: "n" },
	{ file_path: "b.ts", old_string: "q", new_string: "" },
	{ path: "a.ts" },
];
const cursorEditCases = editInputs.map((input) => ({ input, ops: cursor.getEditOperations(input), normalized: cursor.normalizeEditParams(input) }));
const patchInputs: Array<Record<string, unknown>> = [
	{ changes: [{ path: "a", action: "update", oldText: "x", newText: "y" }, { path: "b", action: "add", content: "c" }, { path: "c", action: "move", move_path: "d" }, { path: "e", action: "move", movePath: "f", move_path: "g" }, { path: 1, action: "add" }, null, { path: "h", action: "delete", old_string: "" }, { path: "i", action: "update", old_string: "o", new_string: "" }] },
	{ changes: [] , patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n" },
	{ patch: "diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,2 @@\n same\n same\n" },
	{ patch: "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n" },
	{ patch: "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n" },
	{ patch: "--- /dev/null\n+++ b/fresh.md\n@@ -0,0 +1 @@\n+# Title\n" },
	{ patch: "+++ b/only-new.txt\n@@ -1 +1 @@\n-a\n+b\n" },
	{ patch: "diff --git weird header\n@@ -1 +1 @@\n-a\n+b\n" },
	{ patch: "   \n" },
	{ patch: "-line before header\n@@ -1 +1 @@\n" },
	{},
];
const cursorPatchCases = patchInputs.map((input) => ({ input, out: cursor.resolveApplyPatchChanges(input) }));

// ---------------------------------------------------------------------------
// core/apply-patch.ts on fixture files
// ---------------------------------------------------------------------------

type PatchScenario = { name: string; setup: Setup; changes: Array<Record<string, unknown>> };
const patchScenarios: PatchScenario[] = [
	{
		name: "add-update-delete-move",
		setup: { files: { "a.ts": "const a = 1;\nconst b = 2;\n", "del.txt": "bye\n", "mv.txt": "move me\n", "exec.sh": "#!/bin/sh\necho hi\n" }, modes: { "exec.sh": 0o755 } },
		changes: [
			{ path: "@@DIR@@/new/dir/n.txt", action: "add", content: "fresh" },
			{ path: "@@DIR@@/a.ts", action: "update", oldText: "const b = 2;", newText: "const b = 3;" },
			{ path: "@@DIR@@/del.txt", action: "delete" },
			{ path: "@@DIR@@/mv.txt", action: "move", movePath: "@@DIR@@/moved/mv.txt" },
			{ path: "@@DIR@@/exec.sh", action: "update", oldText: "echo hi", newText: "echo bye" },
		],
	},
	{
		name: "validation-errors",
		setup: { files: { "a.ts": "x\n", "b.ts": "same\nsame\n", "exists.txt": "here\n", "target.txt": "t\n" }, dirs: ["adir"], symlinks: { "link.txt": "a.ts" } },
		changes: [
			{ path: "@@DIR@@/exists.txt", action: "add", content: "x" },
			{ path: "@@DIR@@/a.ts", action: "update" },
			{ path: "@@DIR@@/a.ts", action: "update", oldText: "x", newText: "y" },
			{ path: "@@DIR@@/b.ts", action: "update", oldText: "same", newText: "diff" },
			{ path: "@@DIR@@/missing.ts", action: "update", oldText: "a", newText: "b" },
			{ path: "@@DIR@@/link.txt", action: "delete" },
			{ path: "@@DIR@@/adir", action: "delete" },
			{ path: "@@DIR@@/target.txt", action: "move" },
			{ path: "@@DIR@@/c.ts", action: "update", oldText: "q", newText: "q" },
			{ path: "@@DIR@@/z", action: "explode" },
		],
	},
	{
		name: "move-conflicts",
		setup: { files: { "s1.txt": "1\n", "s2.txt": "2\n", "taken.txt": "x\n" } },
		changes: [
			{ path: "@@DIR@@/s1.txt", action: "move", movePath: "@@DIR@@/taken.txt" },
			{ path: "@@DIR@@/s2.txt", action: "move", movePath: "@@DIR@@/s1.txt" },
		],
	},
	{
		name: "rollback",
		setup: { files: { "keep.ts": "let v = 1;\n", "blocker": "file\n" } },
		changes: [
			{ path: "@@DIR@@/keep.ts", action: "update", oldText: "let v = 1;", newText: "let v = 2;" },
			{ path: "@@DIR@@/blocker/inner.txt", action: "add", content: "x\n" },
		],
	},
	{
		name: "unified-patch",
		setup: { files: { "u.ts": "one\ntwo\nthree\n", "gone.txt": "bye\n" } },
		changes: [],
	},
	{
		name: "indent-adjusted",
		setup: { files: { "i.py": "def f():\n    if x:\n        return 1\n    return 2\n" } },
		changes: [{ path: "@@DIR@@/i.py", action: "update", oldText: "if x:\n    return 1", newText: "if x:\n    return 10\nelse:\n    pass" }],
	},
];
const patchScenarioCases = patchScenarios.map((s) => {
	const dir = join(root, "patch", s.name);
	applySetup(dir, s.setup);
	let input: Record<string, unknown> = { changes: subst(s.changes, dir) };
	if (s.name === "unified-patch") {
		input = { patch: subst(`--- a/@@DIR@@/u.ts\n+++ b/@@DIR@@/u.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\ndiff --git a/@@DIR@@/gone.txt b/@@DIR@@/gone.txt\ndeleted file mode 100644\n--- a/@@DIR@@/gone.txt\n+++ /dev/null\n`, dir) };
	}
	const changes = cursor.resolveApplyPatchChanges(input);
	return { name: s.name, setup: s.setup, input: ph(input), changes: ph(changes), dir: ph(dir) };
});
for (const c of patchScenarioCases) {
	const dir = join(root, "patch", c.name);
	const changes = cursor.resolveApplyPatchChanges(parseJSON(JSON.stringify(c.input).split("@@ROOT@@").join(root), "patch input"));
	const previewed = await applyPatch.previewApplyPatch(changes);
	const executed = await applyPatch.executeApplyPatch(changes);
	Object.assign(c, { preview: ph(previewed), result: ph(executed), formatted: ph(applyPatch.formatApplyPatchResult(executed)), tree: tree(dir) });
}

// ---------------------------------------------------------------------------
// hashline
// ---------------------------------------------------------------------------

const hashTexts = ["", "one line", "a\nb\nc", "dup\ndup\ndup\n", "trailing   \nspaces\t\t\n", "crlf\r\nlines\r\n", "}\n}\n}\n}\n", "漢字\n🙂\n", Array.from({ length: 40 }, (_, i) => `row ${i % 7}`).join("\n")];
const hashCases = hashTexts.map((text) => ({ text, hashes: hashline.hashLines(text), read: hashline.formatHashlineReadLines(text, 1, Infinity), slice: hashline.formatHashlineReadLines(text, 2, 3) }));
const anchorCases = ["", "abc", "abc│content", "  abc  │x", "ab:R1│y", undefined, null].map((ref) => ({ ref: ref ?? null, out: hashline.parseAnchor(ref) }));
const editBase = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
const baseHashes: string[] = hashline.hashLines(editBase);
const h = (i: number, suffix = "") => `${baseHashes[i]}${suffix}`;
const resolveCases = [h(1), "zzz", "", h(0).slice(0, 2), `${h(0).slice(0, 3)}X`].map((ref) => ({ ref, hashes: baseHashes, out: hashline.resolveAnchor(ref, baseHashes) }));
const hashEditCases = [
	{ name: "replace-one", changes: [{ hash_range_inclusive: [h(1, "│  return 1;"), h(1)], content_lines: ["  return 10;"] }] },
	{ name: "two-ranges", changes: [{ hash_range_inclusive: [h(1), h(1)], content_lines: ["  return 11;"] }, { hash_range_inclusive: [h(5), h(5)], content_lines: ["  return 22;", "  // two"] }] },
	{ name: "delete-range", changes: [{ hash_range_inclusive: [h(3), h(3)], content_lines: [] }] },
	{ name: "stale", changes: [{ hash_range_inclusive: ["QQQ", h(1)], content_lines: ["x"] }] },
	{ name: "stale-end", changes: [{ hash_range_inclusive: [h(1), `${h(2).slice(0, 3)}Z`], content_lines: ["x"] }] },
	{ name: "empty", changes: [{ hash_range_inclusive: ["", h(1)], content_lines: ["x"] }] },
	{ name: "bad-range", changes: [{ hash_range_inclusive: [h(2), h(1)], content_lines: ["x"] }] },
	{ name: "overlap", changes: [{ hash_range_inclusive: [h(0), h(2)], content_lines: ["x"] }, { hash_range_inclusive: [h(1), h(1)], content_lines: ["y"] }] },
	{ name: "dup-before", changes: [{ hash_range_inclusive: [h(1), h(1)], content_lines: ["function a() {", "  return 3;"] }] },
	{ name: "dup-after", changes: [{ hash_range_inclusive: [h(1), h(1)], content_lines: ["  return 3;", "}"] }] },
	{ name: "none", changes: [] },
].map((c) => ({ ...c, out: hashline.applyHashlineEdits(editBase, c.changes, "@@ROOT@@/f.ts") }));
const hashFileScenarios = [
	{ name: "lf", content: editBase, dryRun: false },
	{ name: "crlf-bom", content: `\uFEFF${editBase.replace(/\n/g, "\r\n")}`, dryRun: false },
	{ name: "dry-run", content: editBase, dryRun: true },
	{ name: "stale", content: "changed\n", dryRun: false },
	{ name: "missing", content: null, dryRun: false },
];
const hashFileCases: unknown[] = [];
for (const s of hashFileScenarios) {
	const dir = join(root, "hash");
	mkdirSync(dir, { recursive: true });
	const fp = join(dir, `${s.name}.ts`);
	if (s.content !== null) writeFileSync(fp, s.content);
	const changes = [{ hash_range_inclusive: [h(1), h(1)], content_lines: ["  return 100;"] }];
	const run = await hashlineExec.runHashlineEdit({ resolvedPath: fp, changes, dryRun: s.dryRun });
	const direct = s.content === null ? null : await hashlineEdit.applyHashlineEditsToFile(fp, changes, { dryRun: true });
	hashFileCases.push(ph({ name: s.name, content: s.content, dryRun: s.dryRun, changes, run, direct, after: s.content === null ? null : readFileSync(fp, "utf8") }));
}
const hashReadCases = [[1, 3], [2, 100], [0, 2], [5, 4]].map(([start, end]) => ph({ start, end, out: hashlineExec.executeHashlineRead(join(root, "r.ts"), editBase, start, end) }));

// ---------------------------------------------------------------------------
// mutation preview, edit guard, config
// ---------------------------------------------------------------------------

const previewDir = join(root, "preview");
applySetup(previewDir, { files: { "p.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n", "big.txt": `${Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n")}\n`, "dup.ts": "x\nx\n" } });
const previewInputs: Array<{ tool: string; input: Record<string, unknown> }> = [
	{ tool: "edit", input: { path: "p.ts", oldText: "const b = 2;", newText: "const b = 20;" } },
	{ tool: "edit", input: { path: join(previewDir, "p.ts"), edits: [{ oldText: "const a = 1;", newText: "let a = 1;" }, { oldText: "const c = 3;", newText: "" }] } },
	{ tool: "edit", input: { path: "missing.ts", oldText: "a", newText: "b" } },
	{ tool: "edit", input: { path: "p.ts", oldText: "nope", newText: "b" } },
	{ tool: "edit", input: { path: "dup.ts", oldText: "x", newText: "y" } },
	{ tool: "edit", input: { file_path: "big.txt", old_string: "l5\nl6", new_string: Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n") } },
	{ tool: "edit", input: { path: "p.ts" } },
	{ tool: "write", input: { path: "p.ts", content: "x" } },
	{ tool: "apply_patch", input: { changes: [{ path: join(previewDir, "p.ts"), action: "update", oldText: "const b = 2;", newText: "const b = 4;" }, { path: join(previewDir, "n.md"), action: "add", content: "# new\nbody" }, { path: join(previewDir, "big.txt"), action: "delete" }, { path: join(previewDir, "dup.ts"), action: "move", movePath: join(previewDir, "moved.ts") }] } },
	{ tool: "apply_patch", input: { changes: [{ path: join(previewDir, "nope.ts"), action: "update", oldText: "a", newText: "b" }] } },
	{ tool: "apply_patch", input: { changes: [] } },
	{ tool: "apply_patch", input: { changes: [{ path: join(previewDir, "long.txt"), action: "add", content: Array.from({ length: 45 }, (_, i) => `a${i}`).join("\n") }] } },
];
const previewCases: unknown[] = [];
// Relative preview paths resolve against process.cwd(): the preview fixture.
process.chdir(previewDir);
for (const p of previewInputs) {
	for (const opts of [undefined, { maxLines: 3, maxChars: 60 }, { maxLines: 10000, maxChars: 200000 }]) {
		const out = await preview.formatMutationPreview(p.tool, p.input, opts);
		previewCases.push(ph({ tool: p.tool, input: p.input, opts: opts ?? null, out: out ?? null, prompt: preview.buildMutationApprovalPrompt(p.tool, "target", out) }));
	}
}
process.chdir(work);
const plainCases = [["a\nb\nc\n", "a\nB\nc\nd\n"], ["", "x\n"]].flatMap(([a, b]) => [1, 2, 40].map((max) => ({ a, b, max, out: preview.formatParsedDiffPlain(diffCore.parseDiff(a, b), max) })));

const guardHandlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>> = [];
guard.registerEditGuard({ on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => guardHandlers.push(handler) });
const guardInputs: Array<Record<string, unknown>> = [
	{ path: join(previewDir, "p.ts"), edits: [{ oldText: "const a = 1;", newText: "x" }] },
	{ path: join(previewDir, "p.ts"), edits: [{ oldText: "missing text", newText: "x" }] },
	{ path: join(previewDir, "p.ts"), old_string: "const c = 3;", new_string: "y" },
	{ path: join(previewDir, "p.ts"), edits: [{ oldText: "const a = 1;", newText: "x" }, { oldText: "zzz", newText: "q" }] },
	{ path: join(previewDir, "absent.ts"), oldText: "a", newText: "b" },
	{ path: "", oldText: "a", newText: "b" },
	{ path: join(previewDir, "p.ts") },
];
const guardCases: unknown[] = [];
for (const input of guardInputs) guardCases.push(ph({ input, out: (await guardHandlers[0]({ toolName: "edit", input }, {})) ?? null }));

const configDirs: Array<{ name: string; files: Record<string, string> }> = [
	{ name: "none", files: {} },
	{ name: "root-only", files: { "pi-diff.json": JSON.stringify({ disabledTools: ["apply_patch", "bogus", 3], indicatorStyle: "none" }) } },
	{ name: "both", files: { ".pi/pi-diff.json": JSON.stringify({ sepStyle: "gap", colors: { bgAdd: "#111111", fgDel: "#222222" }, disabledTools: ["write"] }), "pi-diff.json": JSON.stringify({ colors: { bgAdd: "#333333" }, lineNumbers: false }) } },
	{ name: "invalid", files: { ".pi/pi-diff.json": "{not json", "pi-diff.json": JSON.stringify({ disabledTools: "edit", theme: "neon" }) } },
	{ name: "null", files: { "pi-diff.json": "null" } },
];
const configCases = configDirs.map((c) => {
	const dir = join(root, "config", c.name);
	applySetup(dir, { files: c.files });
	config.invalidatePiDiffConfig();
	const out = config.loadPiDiffConfig(dir);
	config.invalidatePiDiffConfig();
	return { name: c.name, files: c.files, out };
});
config.invalidatePiDiffConfig();

// ---------------------------------------------------------------------------
// review/git.ts on a fixture repository
// ---------------------------------------------------------------------------

const repoDir = join(root, "repo");
mkdirSync(repoDir, { recursive: true });
const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd: repoDir, encoding: "utf8" });
g("init", "-q");
writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
writeFileSync(join(repoDir, "old.txt"), "rename me\nplease\n");
writeFileSync(join(repoDir, "gone.txt"), "delete me\n");
g("add", "-A");
g("commit", "-qm", "base");
g("checkout", "-qb", "feature");
writeFileSync(join(repoDir, "a.ts"), "export const a = 10;\nexport const b = 2;\nexport const c = 30;\n");
g("mv", "old.txt", "renamed.txt");
g("rm", "-q", "gone.txt");
g("commit", "-qam", "feature");
writeFileSync(join(repoDir, "a.ts"), "export const a = 10;\nexport const b = 20;\nexport const c = 30;\n// tail\n");
writeFileSync(join(repoDir, "untracked.md"), "# new\n\nbody\n");
writeFileSync(join(repoDir, "empty.txt"), "");
mkdirSync(join(repoDir, "sub"));
writeFileSync(join(repoDir, "sub", "n.ts"), "x\ny");
const gitOutputs: Record<string, string> = {};
for (const args of [["diff", "--no-ext-diff"], ["diff", "--no-ext-diff", "main...HEAD"], ["diff", "--name-only"], ["diff", "--name-only", "main...HEAD"], ["ls-files", "--others", "--exclude-standard"]]) {
	gitOutputs[args.join(" ")] = execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}
const untracked: Record<string, string> = {};
for (const p of gitOutputs["ls-files --others --exclude-standard"].split("\n").filter(Boolean)) untracked[p] = readFileSync(join(repoDir, p), "utf8");
const working = git.readGitDiff(repoDir);
const branch = git.readGitDiff(repoDir, { type: "branch", base: "main" });
const gitCase = {
	outputs: gitOutputs,
	untracked,
	working,
	branch,
	changedWorking: git.readChangedFiles(repoDir),
	changedBranch: git.readChangedFiles(repoDir, { type: "branch", base: "main" }),
	countsWorking: git.countReviewDiffLines(working),
	countsBranch: git.countReviewDiffLines(branch),
	fileCounts: working.files.map((f: unknown) => git.countReviewFileLines(f)),
};
const gitParseInputs = [
	"",
	"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@ ctx\n-a\n+b\n\\ No newline at end of file\n",
	"diff --git a/p q/r b/p q/r\nrename from p q/r\nrename to s t/u\n@@ -3,0 +4,2 @@\n+n1\n+n2\n",
	"stray line\ndiff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
	"diff --git broken\n@@ -1 +1 @@\n x\n",
];
const gitParseCases = gitParseInputs.map((raw) => ({ raw, out: git.parseUnifiedGitDiff(raw) }));

// ---------------------------------------------------------------------------
// registerDiffTools: execute and renderers
// ---------------------------------------------------------------------------

const tools = new Map<string, any>();
await index.default({ registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} } as never);
const toolDir = work;
const toolSetup: Setup = {
	files: {
		"w.ts": "const keep = 1;\n// note\nconst value = 2;\n",
		"same.txt": "unchanged\n",
		"e.ts": "function f() {\n  const a = 1;\n  return a;\n}\n",
		"multi.ts": "let x = 1;\nlet y = 2;\nlet z = 3;\n",
		"quote.ts": "const s = \"plain\";\n",
		"wide.ts": `${Array.from({ length: 70 }, (_, i) => `const v${i} = ${i}; // value ${i}`).join("\n")}\n`,
		"long.ts": "const short = 1;\nconst aVeryLongIdentifierName = someFunctionCall(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour, argumentNumberFive);\nconst tail = 3;\n",
		"tabs.go": "func f() {\n\treturn 1\n}\n",
		"cjk.md": "# 見出し\n本文です\n",
		"py.py": "def f():\n    return 1\n",
	},
};
applySetup(toolDir, toolSetup);
process.chdir(toolDir);
const ctxBase = { cwd: toolDir };
type ExecCase = { tool: string; id: string; params: Record<string, unknown>; result?: unknown; error?: string; tree?: unknown };
const execInputs: ExecCase[] = [
	{ tool: "write", id: "w1", params: { path: "w.ts", content: "const keep = 1;\n// note changed\nconst value = 3;\n" } },
	{ tool: "write", id: "w2", params: { path: "same.txt", content: "unchanged\n" } },
	{ tool: "write", id: "w3", params: { path: "fresh/new.ts", content: "export const fresh = true;\n// comment\n" } },
	{ tool: "write", id: "w4", params: { path: "empty.txt", content: "" } },
	{ tool: "edit", id: "e1", params: { path: "e.ts", oldText: "  const a = 1;", newText: "  const a = 2;" } },
	{ tool: "edit", id: "e2", params: { path: "multi.ts", edits: [{ oldText: "let x = 1;", newText: "let x = 10;" }, { old_string: "let z = 3;", new_string: "let z = 30;\nlet w = 4;" }] } },
	{ tool: "edit", id: "e3", params: { path: "e.ts", old_string: "    return a;", new_string: "  return a * 2;" } },
	{ tool: "edit", id: "e4", params: { path: "quote.ts", oldText: "const s = \u201cplain\u201d;", newText: "const s = \"fancy\";" } },
	{ tool: "edit", id: "e5", params: { path: "e.ts", oldText: "not there", newText: "x" } },
	{ tool: "edit", id: "e6", params: { path: "wide.ts", oldText: "const v5 = 5; // value 5", newText: "const v5 = 500; // value five" } },
	// Relative apply_patch paths resolve against process.cwd() (the fixture
	// work directory), so the rendered texts do not depend on the fixture path.
	{ tool: "apply_patch", id: "p1", params: { changes: [{ path: "pa.ts", action: "add", content: "export const pa = 1;" }] } },
	{ tool: "apply_patch", id: "p2", params: { changes: [{ path: "long.ts", action: "update", oldText: "const tail = 3;", newText: "const tail = 4;" }, { path: "tabs.go", action: "update", oldText: "\treturn 1", newText: "\treturn 2" }] } },
	{ tool: "apply_patch", id: "p3", params: { changes: [{ path: "nope.ts", action: "update", oldText: "a", newText: "b" }] } },
	{ tool: "apply_patch", id: "p4", params: { patch: "--- a/cjk.md\n+++ b/cjk.md\n@@ -1,2 +1,2 @@\n # 見出し\n-本文です\n+新しい本文\n" } },
	{ tool: "apply_patch", id: "p5", params: { changes: [{ path: "py.py", action: "move", movePath: "moved.py" }] } },
	{ tool: "apply_patch", id: "p6", params: { changes: [{ path: "multi.ts", action: "delete" }] } },
];
for (const c of execInputs) {
	const tool = tools.get(c.tool);
	try {
		const result = await tool.execute(c.id, clone(c.params), undefined, undefined, ctxBase);
		c.result = { content: result.content, isError: result.isError ?? false, details: result.details ?? null };
	} catch (error) {
		c.error = error instanceof Error ? error.message : String(error);
	}
	c.tree = tree(toolDir);
}
const execCases = ph(execInputs);

async function renderText(component: any, width: number): Promise<string[]> {
	component.render(width);
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	return component.render(width);
}

const WIDTHS = [50, 100, 160, 200];
type RenderCase = { tool: string; phase: "call" | "result"; label: string; args?: unknown; result?: unknown; ctx: Record<string, unknown>; width: number; out?: string[]; text?: string; bg?: boolean };
const renderCases: RenderCase[] = [];
const argSets: Array<{ tool: string; label: string; args: Record<string, unknown>; ctx: Record<string, unknown> }> = [
	{ tool: "write", label: "partial", args: { path: "w.ts", content: "a\nb\nc" }, ctx: { argsComplete: false, toolCallId: "w1" } },
	{ tool: "write", label: "partial-new", args: { path: "brand.ts", content: "a" }, ctx: { argsComplete: false, toolCallId: "zz" } },
	{ tool: "write", label: "create", args: { path: "brand.ts", content: "export const x = 1;\n// hi\n\tindented();\n" }, ctx: { argsComplete: true } },
	{ tool: "write", label: "create-py", args: { path: "brand.py", content: "def f():\n    pass\n" }, ctx: { argsComplete: true } },
	{ tool: "write", label: "overwrite", args: { path: "w.ts", content: "const keep = 1;\n// note\nconst value = 99;\nconst extra = true;\n" }, ctx: { argsComplete: true } },
	{ tool: "write", label: "nochange", args: { path: "same.txt", content: "unchanged\n" }, ctx: { argsComplete: true } },
	{ tool: "write", label: "header", args: { path: "w.ts" }, ctx: { argsComplete: true, toolCallId: "w1" } },
	{ tool: "write", label: "outside-home", args: { path: join(root, "home", "x.txt") }, ctx: { argsComplete: false } },
	{ tool: "edit", label: "complete", args: { path: "e.ts", oldText: "  return a;", newText: "  return b;" }, ctx: { argsComplete: true } },
	{ tool: "edit", label: "complete-miss", args: { path: "e.ts", oldText: "zzz", newText: "b" }, ctx: { argsComplete: true } },
	{ tool: "edit", label: "partial", args: { path: "e.ts" }, ctx: { argsComplete: false } },
	{ tool: "apply_patch", label: "complete", args: { changes: [{ path: "a", action: "add", content: "x" }] }, ctx: { argsComplete: true } },
	{ tool: "apply_patch", label: "one", args: { changes: [{ path: join(toolDir, "a.ts"), action: "add", content: "x" }] }, ctx: { argsComplete: false } },
	{ tool: "apply_patch", label: "three", args: { changes: [{ path: join(toolDir, "a.ts"), action: "add", content: "x" }, { path: "b.ts", action: "delete" }, { path: "c.ts", action: "delete" }] }, ctx: { argsComplete: false } },
	{ tool: "apply_patch", label: "waiting", args: {}, ctx: { argsComplete: false } },
];
// Reset the fixture so the call renders see the pre-execute files.
applySetup(toolDir, toolSetup);
process.chdir(toolDir);
for (const a of argSets) {
	for (const width of WIDTHS) {
		const component = tools.get(a.tool).renderCall(clone(a.args), theme, { ...a.ctx, invalidate: () => {}, lastComponent: undefined });
		const out = await renderText(component, width);
		renderCases.push({ tool: a.tool, phase: "call", label: a.label, args: a.args, ctx: a.ctx, width, out, text: component.text, bg: typeof component.customBgFn === "function" });
	}
}
const resultSets: Array<{ tool: string; label: string; result: Record<string, unknown>; ctx: Record<string, unknown> }> = [];
for (const c of execInputs) {
	if (!c.result) continue;
	const r = c.result as { isError: boolean };
	resultSets.push({ tool: c.tool, label: c.id, result: c.result as Record<string, unknown>, ctx: { isError: r.isError } });
}
resultSets.push(
	{ tool: "write", label: "error", result: { content: [{ type: "text", text: "EACCES: denied" }], isError: true, details: null }, ctx: { isError: false } },
	{ tool: "write", label: "error-ctx", result: { content: [{ type: "text", text: "boom" }, { type: "text", text: "line two" }], isError: false, details: null }, ctx: { isError: true } },
	{ tool: "write", label: "plain", result: { content: [{ type: "text", text: "Wrote it" }], details: null }, ctx: { isError: false } },
	{ tool: "write", label: "new-empty", result: { content: [], details: { _type: "new", lines: 0, content: "", filePath: "x.ts" } }, ctx: { isError: false } },
	{ tool: "edit", label: "error", result: { content: [{ type: "text", text: "Could not find the text" }], details: null }, ctx: { isError: true } },
	{ tool: "edit", label: "multi-nodiff", result: { content: [], details: { _type: "multiEditInfo", editCount: 3, diffLineCount: 12 } }, ctx: { isError: false } },
	{ tool: "edit", label: "plain", result: { content: [{ type: "text", text: "x".repeat(150) }], details: null }, ctx: { isError: false } },
	{ tool: "apply_patch", label: "error", result: { content: [{ type: "text", text: "Failed" }], details: null }, ctx: { isError: true } },
	{ tool: "apply_patch", label: "mixed", result: { content: [{ type: "text", text: "Applied" }], details: { _type: "applyPatchInfo", result: { ok: true, errors: [], applied: [
		{ path: join(toolDir, "one.ts"), action: "update", oldContent: "a\nb\n", newContent: "a\nB\n" },
		{ path: join(toolDir, "two.ts"), action: "add", newContent: "fresh\n" },
		{ path: join(toolDir, "three.md"), action: "delete", oldContent: "gone\n" },
	] } } }, ctx: { isError: false } },
);
for (const r of resultSets) {
	for (const width of WIDTHS) {
		const component = tools.get(r.tool).renderResult(clone(r.result), { expanded: false, isPartial: false }, theme, { ...r.ctx, invalidate: () => {}, lastComponent: undefined, args: {} });
		const out = await renderText(component, width);
		renderCases.push({ tool: r.tool, phase: "result", label: r.label, result: r.result, ctx: r.ctx, width, out, text: component.text, bg: typeof component.customBgFn === "function" });
	}
}

// Direct hunk-preview renders.
const directDiffs = [
	diffCore.parseDiff("a\nb\nc\n", "a\nB\nc\n"),
	diffCore.parseDiff("x = 1\ny = 2\n", "x = 10\ny = 20\nz = 30\n"),
	diffCore.parseDiff(`${Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n")}\n`, `${Array.from({ length: 20 }, (_, i) => (i % 6 === 0 ? `ROW ${i} changed with a fairly long tail of text to wrap around` : `row ${i}`)).join("\n")}\n`),
	diffCore.parsePatchFiles("@@ -1,2 +1,2 @@ function foo() {\n-a\n+b\n c\n@@ -20,2 +20,2 @@\n-x\n+y\n z\n")[0],
	diffCore.parseDiff("\tindented\n", "\t\tindented more\n"),
];
const directCases: unknown[] = [];
const colors = hunk.resolveDiffColors(theme);
for (const diff of directDiffs) {
	for (const language of [undefined, "typescript"]) {
		for (const width of [30, 60, 100, 200]) {
			for (const compactGutter of [false, true]) {
				for (const maxLines of [3, 60]) {
					directCases.push({
						diff, language: language ?? null, width, compactGutter, maxLines,
						split: await hunk.renderSplit(diff, language, maxLines, colors, width, { compactGutter }),
						unified: await hunk.renderUnified(diff, language, maxLines, colors, width, { compactGutter }),
					});
				}
			}
		}
	}
}
const reviewCases: unknown[] = [];
for (const file of working.files) {
	for (const h of file.hunks) {
		for (const width of [0, 50, 120]) reviewCases.push({ hunk: h, path: file.path, width, out: await hunk.renderReviewHunkPreview({ hunk: h, filePath: file.path, theme, width }) });
	}
}

// ---------------------------------------------------------------------------
// Approval overlay (permission-modes/approval-dialog.ts)
// ---------------------------------------------------------------------------

const approvalDir = join(root, "approval");
applySetup(approvalDir, { files: { "edit.ts": `${Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`).join("\n")}\n` } });
const longEdit = { path: join(approvalDir, "edit.ts"), oldText: Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`).join("\n"), newText: Array.from({ length: 30 }, (_, i) => `const n${i} = ${i * 2}; // doubled value with a long comment that wraps`).join("\n") };
const keySets: Record<string, string[]> = {
	scroll: ["\x1b[B", "\x1b[B", "\x1b[6~", "G", "\x1b[A", "g", "\x1b[5~", "\x1b[F", "\x1b[H", "\x1bOF", "\x1bOH", "\r"],
	cycle: ["j", "j", "j", "k", "\t", "\x1b[Z", "\x1b[Z", "\n"],
	pick2: ["2"],
	pick3: ["3"],
	pick1: ["1"],
	cancel: ["x", "\x1b"],
	ctrlc: ["\x03"],
	enterAuto: ["j", "\r"],
};
const approvalCases: unknown[] = [];
const approvalScenarios = [
	{ name: "edit", tool: "edit", input: longEdit, path: "edit.ts", outside: undefined },
	{ name: "outside", tool: "edit", input: longEdit, path: "/elsewhere/edit.ts", outside: { cwd: "/work", scopes: ["/elsewhere", "/other"] } },
	{ name: "write", tool: "write", input: { path: "w.ts", content: "x" }, path: "w.ts", outside: undefined },
	{ name: "write-outside", tool: "write", input: { path: "w.ts", content: "x" }, path: "/x/w.ts", outside: { cwd: "/work", scopes: ["/x"] } },
];
for (const s of approvalScenarios) {
	for (const [keysName, keys] of Object.entries(keySets)) {
		for (const size of [{ rows: 24, columns: 80, width: 80 }, { rows: 12, columns: 40, width: 40 }, { rows: 6, columns: 30, width: 4 }]) {
			if (s.name.startsWith("write") && size.rows !== 24) continue;
			const frames: string[][] = [];
			let header = "";
			let overlayOptions: unknown = null;
			const ctx = {
				mode: "tui",
				sessionManager: { getSessionId: () => "s" },
				ui: {
					custom: (factory: any, options: unknown) =>
						new Promise((resolve) => {
							overlayOptions = options;
							const tui = { terminal: { rows: size.rows, columns: size.columns } };
							const component = factory(tui, theme, {}, (value: unknown) => resolve(value));
							header = (component as { header: string }).header;
							frames.push(component.render(size.width));
							for (const key of keys) {
								component.handleInput(key);
								frames.push(component.render(size.width));
							}
							resolve(undefined);
						}),
				},
			};
			const decision = await approval.showMutationApproval(ctx as never, { tool: s.tool, input: s.input, path: s.path, outside: s.outside });
			approvalCases.push(ph({ scenario: s.name, tool: s.tool, input: s.input, path: s.path, outside: s.outside ?? null, keysName, keys, size, header, overlayOptions, frames, decision }));
		}
	}
	for (const answer of [0, 1, 2, -1]) {
		let title = "";
		let options: string[] = [];
		const ctx = {
			mode: "rpc",
			sessionManager: { getSessionId: () => "s" },
			ui: {
				select: async (t: string, o: string[]) => {
					title = t;
					options = o;
					return answer >= 0 ? o[answer] : undefined;
				},
			},
		};
		const decision = await approval.showMutationApproval(ctx as never, { tool: s.tool, input: s.input, path: s.path, outside: s.outside });
		approvalCases.push(ph({ scenario: s.name, tool: s.tool, input: s.input, path: s.path, outside: s.outside ?? null, select: { answer, title, options }, decision }));
	}
}
// Empty-diff dialog straight from the class.
const emptyFrames: string[][] = [];
{
	const dialog = new approval.ApprovalDialog({ tui: { terminal: { rows: 20, columns: 60 } } as never, theme, header: "Allow write on x?", diff: undefined, done: () => {} });
	emptyFrames.push(dialog.render(60));
	dialog.handleInput("\x1b[B");
	emptyFrames.push(dialog.render(60));
}

// ---------------------------------------------------------------------------
// Palette presets (applyDiffPalette with Pi settings), last: they change state.
// ---------------------------------------------------------------------------

mkdirSync(join(work, ".pi"), { recursive: true });
writeFileSync(join(work, ".pi", "settings.json"), JSON.stringify({ diffTheme: "neon", diffColors: { bgAdd: "#112233", fgSafeMuted: "#aabbcc", nonsense: "zz" } }));
hunk.applyDiffPalette();
const presetColors = hunk.resolveDiffColors(theme);
const presetCases = directDiffs.slice(0, 3).map((diff) => ({ diff, split: "", unified: "" }));
for (const c of presetCases) {
	c.split = await hunk.renderSplit(c.diff, "typescript", 60, presetColors, 100, { compactGutter: true });
	c.unified = await hunk.renderUnified(c.diff, "typescript", 60, presetColors, 100, {});
}

const golden = {
	roleCodes: ROLE_CODES,
	fgRgb: FG_RGB,
	bgRgb: BG_RGB,
	parseDiffCases,
	parsePatchCases,
	sepCases,
	sepStyleCases,
	hunkBlockCases,
	encodingCases,
	conflictCases,
	collapsedCases,
	replaceCases,
	patchReplaceCases,
	cursorEditCases,
	cursorPatchCases,
	patchScenarioCases,
	hashCases,
	anchorCases,
	resolveCases,
	hashEditCases,
	hashFileCases,
	hashReadCases,
	previewCases,
	plainCases,
	guardCases,
	configCases,
	gitCase,
	gitParseCases,
	toolSetup,
	execCases,
	renderCases: ph(renderCases),
	directCases,
	reviewCases,
	approvalCases,
	emptyFrames,
	presetSettings: { diffTheme: "neon", diffColors: { bgAdd: "#112233", fgSafeMuted: "#aabbcc", nonsense: "zz" } },
	presetCases,
	headerNames: ["write", "create", "edit", "apply_patch", "read"].map((name) => ({ name, out: index.__testing.formatToolHeaderName(name) })),
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
		console.error("difftools golden.json is stale: run npx tsx go/internal/difftools/testdata/gen-golden.ts");
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
void statSync;
