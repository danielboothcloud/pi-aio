// Regenerate golden.json from xxhash-wasm's h32 (the hash that
// diff-tools/hashline.ts uses):
//   npx tsx go/internal/xxhash32/testdata/gen-golden.ts [--check]
// Inputs cover every length class (0-3 tail bytes, 4-byte tail, 16-byte
// stripes), multi-byte UTF-8, a lone surrogate, and the seeds hashline
// uses for collision retries.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import xxhashWasm from "xxhash-wasm";

const here = dirname(fileURLToPath(import.meta.url));
const { h32 } = await xxhashWasm();

const inputs: string[] = ["", "a", "ab", "abc", "abcd", "abcde"];
for (const n of [7, 15, 16, 17, 31, 32, 33, 63, 64, 100, 257]) inputs.push("x".repeat(n));
for (let n = 0; n < 40; n++) inputs.push(Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join(""));
inputs.push(
	"const value = 1;",
	"\tfunction foo() {",
	"}",
	"import { x } from \"y\";",
	"漢字のテキスト",
	"emoji 🙂 and 👩‍💻",
	"café naïve",
	"\u0000nul",
	"lone \ud800 surrogate",
	"\ufeffbom",
);
const seeds = [0, 1, 2, 3, 7, 999, 0xffffffff];
const cases: Array<{ input: string; seed: number; hash: number }> = [];
for (const input of inputs) for (const seed of seeds) cases.push({ input, seed, hash: h32(input, seed) >>> 0 });

const output = `${JSON.stringify({ cases }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("xxhash32 golden.json is stale: run npx tsx go/internal/xxhash32/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	console.log(`wrote ${cases.length} cases`);
}
