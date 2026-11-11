// Regenerate golden.json from the TypeScript init prompt (the reference):
//   npx tsx go/internal/initcmd/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const { buildInitPrompt } = await import(join(repo, "init", "prompt.ts"));

const argsList = ["", "  ", "force", "--force", "REFRESH", "dry-run", "--dry-run", "preview force", "forced", "xforce", "please dry-run now", "\u00a0preview\u00a0"];
const cases = argsList.flatMap((args) => ["/repo", "/a b/c"].map((cwd) => ({ cwd, args, prompt: buildInitPrompt({ cwd, args }) })));

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
		console.error("init golden.json is stale: run npx tsx go/internal/initcmd/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`init golden.json is current (${cases.length} prompts)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`init golden.json: ${cases.length} prompts`);
}
