// Regenerate golden.json from ui/editor-intercepts.ts and the pure helpers
// of ui/overlay-images.ts (the reference):
//   npx tsx go/internal/ui/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const images = await import(join(repo, "ui", "overlay-images.ts"));
const intercepts = await import(join(repo, "ui", "editor-intercepts.ts"));

const lines = [
	"plain text",
	"\x1b_Ga=T,f=100,r=3;AAAA\x1b\\",
	"\x1b_Ga=T,r=1;x",
	"\x1b_Ga=T,r=abc,c=4;x",
	"\x1b_Gr=2.5;x",
	"\x1b[2A\x1b]1337;File=inline=1:AAAA\x07",
	"\x1b[5Aprefix\x1b_Ga=T,r=4;x and \x1b]1337;File=x",
	"\x1b]1337;File=x then \x1b_Gr=9;y",
	"\x1b_Gno-semicolon",
	"",
];
const spans = lines.map((line) => ({ line, out: images.imageRowSpan(line) ?? null }));
const screens = [
	{ lines: ["a", lines[1], "b", "c", lines[5], "d"], heights: [1, 2, 3, 4, 6, 10] },
	{ lines: [lines[1], "x", "y", "z", "w"], heights: [1, 2, 3, 4, 5] },
	{ lines: ["no", "images"], heights: [1, 5] },
].flatMap((s) => s.heights.map((height) => ({ lines: s.lines, height, out: images.hideViewportImages(s.lines, height) })));
const output = `${JSON.stringify({ interceptedActions: intercepts.INTERCEPTED_ACTIONS, spans, screens }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
const summary = `${spans.length} image spans, ${screens.length} viewport screens`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("ui golden.json is stale: run npx tsx go/internal/ui/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`ui golden.json is current (${summary})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`ui golden.json: ${summary}`);
}
