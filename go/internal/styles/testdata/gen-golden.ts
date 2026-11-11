// Regenerate golden.json from the TypeScript styles (the reference):
//   npx tsx go/internal/styles/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const styles = await import(join(repo, "styles", "index.ts"));
const access = await import(join(repo, "styles", "style-access.ts"));

const contexts: unknown[] = [];
for (const style of ["collaborate", "tutor", "concise", "ste"]) {
	for (const mode of ["default", "ask", "plan", "auto"]) {
		contexts.push({ style, mode, content: styles.buildStyleContext(style, mode), meta: styles.styleMetadata(style) });
	}
}
const parses = ["none", " OFF ", "Mentor", "humanised", "ste", "tutor", "x", "", "Collaborate"].map((value) => ({
	value,
	result: access.parseStyle(value) ?? "",
}));
const msg = (customType?: string, id = "") => ({ role: "custom", customType, id });
const filterCases = [
	{ messages: [msg("a")], style: "ste" },
	{ messages: [msg("styles-context", "1")], style: "ste" },
	{ messages: [msg("styles-context", "1")], style: "none" },
	{ messages: [msg("styles-context", "1"), msg("x"), msg("styles-context", "2")], style: "tutor" },
	{ messages: [msg("styles-context", "1"), msg("x"), msg("styles-context", "2")], style: "none" },
].map((c) => ({ ...c, result: styles.filterStyleContext(c.messages, c.style) ?? null }));

// The /style command, driven through a harness for its notices.
const notices: string[] = [];
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
const pi = {
	on: () => {},
	appendEntry: () => {},
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
};
const savedChild = process.env.AIO_SUBAGENT_CHILD;
delete process.env.AIO_SUBAGENT_CHILD;
styles.registerStyles(pi as never);
if (savedChild !== undefined) process.env.AIO_SUBAGENT_CHILD = savedChild;
const ctx = { hasUI: false, ui: { notify: (m: string) => notices.push(m), setStatus: () => {}, theme: { fg: (_: string, t: string) => t } } };
for (const arg of ["ste", "concise", "collaborate", "tutor", "off", "bogus", ""]) await commands.get("style")!.handler(arg, ctx);

const output = `${JSON.stringify({ contexts, parses, filterCases, notices, summaries: styles.STYLES }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("styles golden.json is stale: run npx tsx go/internal/styles/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`styles golden.json is current (${contexts.length} contexts)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`styles golden.json: ${contexts.length} contexts`);
}
