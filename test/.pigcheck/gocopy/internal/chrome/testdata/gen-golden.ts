// Regenerate golden.json from the TypeScript ui/chrome.ts (the reference):
//   npx tsx go/internal/chrome/testdata/gen-golden.ts [--check]
// Every primitive renders with an ANSI test theme (each role is one SGR
// color) and with a plain theme without bold/bg, at several widths, so the
// Go port must match pi-tui's ANSI-aware width fitting byte for byte.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const chrome = await import(join(repo, "ui", "chrome.ts"));

/** SGR foreground per role; unknown roles get 37. Shared with the Go test. */
export const ROLE_CODES: Record<string, number> = {
	accent: 36, success: 32, warning: 33, error: 31, muted: 90, dim: 2, text: 39,
	borderMuted: 94, toolTitle: 35, thinkingText: 95, toolOutput: 96, selectedBg: 44,
};
const code = (role: string) => ROLE_CODES[role] ?? 37;
const ansiTheme = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${code(role) + 10}m${text}\x1b[49m`,
};
const plainTheme = { fg: (_role: string, text: string) => text };
const themes = { ansi: ansiTheme, plain: plainTheme } as const;

const widths = [0, 1, 3, 4, 5, 8, 12, 20, 40];
const texts = ["", "short", "a longer line of text that will not fit", "wide 漢字 and emoji 🙂 text", "\x1b[31mred\x1b[0m tail"];

type Case = { fn: string; theme: string; args: unknown; width: number; out: string };
const cases: Case[] = [];
for (const [themeName, theme] of Object.entries(themes)) {
	for (const width of widths) {
		for (const text of texts) {
			cases.push({ fn: "fitLine", theme: themeName, args: { text }, width, out: chrome.fitLine(text, width) });
			cases.push({ fn: "fitLineEmpty", theme: themeName, args: { text }, width, out: chrome.fitLine(text, width, "") });
			cases.push({ fn: "padToWidth", theme: themeName, args: { text }, width, out: chrome.padToWidth(text, width) });
			cases.push({ fn: "hint", theme: themeName, args: { text, indent: 2 }, width, out: chrome.chromeHint(theme, text, width) });
			cases.push({ fn: "hint", theme: themeName, args: { text, indent: 0 }, width, out: chrome.chromeHint(theme, text, width, 0) });
			cases.push({ fn: "frameRow", theme: themeName, args: { text }, width, out: chrome.chromeFrameRow(theme, text, width) });
		}
		for (const label of ["", "label", "a much longer label than fits"]) {
			cases.push({ fn: "divider", theme: themeName, args: { label }, width, out: chrome.chromeDivider(theme, width, label || undefined) });
			for (const edge of ["top", "divider", "bottom"]) {
				cases.push({ fn: "frameRule", theme: themeName, args: { edge, label }, width, out: chrome.chromeFrameRule(theme, width, edge, label || undefined) });
			}
		}
		const headers = [
			{ title: "subagents" },
			{ title: "subagent", meta: "worker · run 1234abcd · 1/3" },
			{ title: "model", meta: "anthropic/claude", tone: "warning", icon: "◆", indent: 2 },
		];
		for (const options of headers) cases.push({ fn: "header", theme: themeName, args: options, width, out: chrome.chromeHeader(theme, options, width) });
		const items = [
			{ label: "worker" },
			{ label: "worker", meta: "running 5s · bash: npm test", marker: "↳", tone: "muted", indent: 3 },
			{ label: "reviewer", meta: "completed", active: true, indent: 2 },
			{ label: "x", active: true, tone: "warning" },
			{ label: "planner", indent: 0 },
		];
		for (const options of items) cases.push({ fn: "item", theme: themeName, args: options, width, out: chrome.chromeItem(theme, options, width) });
	}
}
const plurals = [0, 1, 2, 12].flatMap((count) => [
	{ count, singular: "run", out: chrome.plural(count, "run") },
	{ count, singular: "child", plural: "children", out: chrome.plural(count, "child", "children") },
]);

const output = `${JSON.stringify({ roleCodes: ROLE_CODES, cases, plurals }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("chrome golden.json is stale: run npx tsx go/internal/chrome/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`chrome golden.json is current (${cases.length} renders)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`chrome golden.json: ${cases.length} renders`);
}
