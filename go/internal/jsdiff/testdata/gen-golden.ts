// Regenerate golden.json from the npm "diff" package (jsdiff), the library
// diff-tools calls (diffWords, structuredPatch, createPatch):
//   npx tsx go/internal/jsdiff/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Diff from "diff";

const here = dirname(fileURLToPath(import.meta.url));

const texts: string[] = [
	"",
	"a",
	"a\n",
	"a\nb\nc\n",
	"a\nb\nc",
	"a\nB\nc\n",
	"a\r\nb\r\nc\r\n",
	"a\r\nb\nc",
	"\n\n\n",
	"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
	"one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\ntwelve\nthirteen\n",
	"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve",
	"function foo() {\n\treturn 1;\n}\n",
	"function foo() {\n\treturn 2;\n}\n\nfunction bar() {}\n",
	"漢字\n🙂 emoji\nlast\n",
	"x\ny\nz\nw\nv\nu\nt\ns\nr\nq\np\no\n",
	"x\nY\nz\nw\nv\nu\nt\ns\nr\nq\nP\no\nn\n",
];
const lineCases: unknown[] = [];
const patchCases: unknown[] = [];
for (const a of texts) {
	for (const b of texts) {
		lineCases.push({ a, b, out: Diff.diffLines(a, b) });
		for (const context of [0, 1, 3, -1]) {
			const opts = context < 0 ? undefined : { context };
			patchCases.push({
				a, b, context,
				structured: Diff.structuredPatch("old", "new", a, b, "h1", undefined, opts),
				created: Diff.createPatch("file.ts", a, b, "before", "after", opts),
			});
		}
	}
}

const words: string[] = [
	"",
	"foo",
	"foo bar baz",
	"foo baz",
	"foo qux baz",
	"foo\nbar baz",
	"foo   bar baz",
	"foo  baz",
	"foo\tbar\nbaz",
	"  leading space",
	"trailing space  ",
	"const value = computeThing(a, b);",
	"const value = computeOther(a, c);",
	"let total = items.reduce((s, x) => s + x, 0);",
	"café naïve résumé",
	"cafe naive resume",
	"漢字 テキスト here",
	"emoji 🙂 here and 👩‍💻 there",
	"return x;",
	"return y;",
	"if (a === b) {",
	"if (a !== b) {",
	"   ",
	"a.b.c",
	"a.b.d",
];
const wordCases: unknown[] = [];
for (const a of words) for (const b of words) wordCases.push({ a, b, out: Diff.diffWords(a, b) });

const output = `${JSON.stringify({ lineCases, patchCases, wordCases }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("jsdiff golden.json is stale: run npx tsx go/internal/jsdiff/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	console.log(`wrote ${lineCases.length} line, ${patchCases.length} patch, ${wordCases.length} word cases`);
}
