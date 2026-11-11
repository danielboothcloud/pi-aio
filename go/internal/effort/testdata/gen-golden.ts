// Regenerate golden.json from the TypeScript effort feature (the reference):
//   npx tsx go/internal/effort/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const parse = await import(join(repo, "effort", "parse.ts"));
const capability = await import(join(repo, "effort", "capability.ts"));
const menu = await import(join(repo, "effort", "command-menu.ts"));

const inputs = ["", "  STATUS ", "show", "ultracode", "Ultra-Code", "off", "0", "false", "none", "min", "lo", "med", "normal",
	"default", "hi", "x-high", "extra", "xhigh", "max", "thinking high", "effort=low", "level: max", "think, minimal", "high low",
	"bogus", " Weird Value ", "effort", "thinking=", "turbo", "\u00a0high\u00a0"];
const targets = inputs.map((raw) => ({ raw, target: parse.parseEffortTarget(raw) }));

const models = [
	{ name: "none", model: undefined },
	{ name: "plain", model: { reasoning: false } },
	{ name: "reasoning", model: { reasoning: true } },
	{ name: "mapped", model: { reasoning: true, thinkingLevelMap: { xhigh: "high", max: null, off: "none", low: "minimal" } } },
];
const levels = parse.THINKING_LEVELS;
const resolved: unknown[] = [];
const overrides: unknown[] = [];
const effective: unknown[] = [];
for (const { name, model } of models) {
	for (const level of levels) {
		resolved.push({ model: name, level, value: capability.resolveEffortValue(model, level) ?? null });
		for (const clamped of levels) {
			effective.push({ model: name, requested: level, clamped, result: capability.effectiveEffortLevel(model, level, clamped) });
		}
		for (const payload of [{ reasoning_effort: "high", x: 1 }, { reasoning_effort: level }, { reasoning: { effort: "high" } }, null, "text"]) {
			const out = capability.applyEffortOverride(model, level, payload);
			overrides.push({ model: name, desired: level, payload, changed: out !== payload, result: out });
		}
	}
	overrides.push({ model: name, desired: null, payload: { reasoning_effort: "high" }, changed: false, result: { reasoning_effort: "high" } });
}
const completions = ["", "x", "U", " st ", "n", "zz"].map((prefix) => ({ prefix, items: menu.getEffortArgumentCompletions(prefix) ?? [] }));

const output = `${JSON.stringify({ targets, models, resolved, overrides, effective, completions }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("effort golden.json is stale: run npx tsx go/internal/effort/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`effort golden.json is current (${effective.length} reconcile cases)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`effort golden.json: ${targets.length} targets, ${overrides.length} overrides, ${effective.length} reconcile cases`);
}
