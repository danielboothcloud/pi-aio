// Regenerate golden.json from the vendored Pi parser (the reference):
//   npx tsx go/internal/piargs/testdata/gen-golden.ts [--check]
// recipes/pig-launch/args.test.ts checks that parser against the pinned Pi
// parser; this corpus adds diagnostics and the extension flags that Go
// features read from pig's argv.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const { parseArgs } = await import(join(repo, "recipes", "pig-launch", "args.ts"));

const LIST_FIELDS = new Set(["appendSystemPrompt", "models", "tools", "excludeTools", "extensions", "skills", "promptTemplates", "themes"]);

/** JSON view: Maps become {name, value} lists; undefined and empty optional lists drop. */
function view(result: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(result)) {
		if (value === undefined) continue;
		if (LIST_FIELDS.has(key) && Array.isArray(value) && value.length === 0) continue;
		out[key] = value instanceof Map ? [...value.entries()].map(([name, v]) => ({ name, value: v })) : value;
	}
	return out;
}

const CORPUS: string[][] = [
	[], ["hello", "world"], ["--recipe", "work"], ["--recipe=work", "-p", "hi"], ["--recipe", "--continue"],
	["-c"], ["--continue", "--recipe", "x", "prompt"], ["-r"], ["--session", "/tmp/s.jsonl", "--session-id", "abc"],
	["--session-dir", "~/s", "-c"], ["--fork", "f.jsonl", "--name", "n"], ["-n"], ["--no-session", "-p"],
	["-p", "---literal"], ["-p", "-x"], ["-p", "@file.md", "msg"], ["--print", "msg", "--mode", "json"],
	["--mode", "bogus"], ["--mode"], ["--mode", "-p"], ["--models", "a/*, b ,,c"], ["--models", ",,"],
	["-ne", "-e", "./x.ts", "--extension", "npm:y"], ["-e", "builtin:mcp", "-e", "git:github.com/a/b", "-e", "../rel/ext"],
	["--no-extensions", "--no-mcp", "--no-skills", "-np", "--no-themes", "-nc"],
	["--thinking", "high", "--thinking", "bogus"], ["--model", "anthropic/x", "--provider", "p", "--api-key", "k"],
	["--system-prompt", "s", "--append-system-prompt", "a", "--append-system-prompt", "b"],
	["--exclude-tools", "bash,read", "-xt", "write"], ["--tools", "read,bash"], ["-t", "read, write"], ["--no-tools", "-nbt"],
	["--skill", "s", "--prompt-template", "t", "--theme", "th", "--use-theme", "dark"], ["--use-theme", "-x"], ["--use-theme"],
	["--list-models"], ["--list-models", "sonnet"], ["--list-models", "-p"], ["--list-models", "@f"],
	["--tui-mode", "fullscreen"], ["--tui-mode", "bad"], ["--tui-mode"], ["--tui-mode", "-x"],
	["--verbose", "--offline", "-a", "--no-approve", "-na"], ["--approve"], ["--help", "-v"], ["--export", "out.html"],
	["--permission-mode", "auto", "--unknown", "--other=val", "--flag", "@file"], ["--dup", "a", "--x", "--dup=b"],
	["--piglet", "work", "--no-stdin", "msg"], ["-x", "-yz", "@a", "@b", "plain"], ["--", "--recipe", "x", "@f", "-c"],
	["msg", "--", "@x"], ["--session"], ["--models"], ["-e"], ["--mode", "rpc", "--no-session", "-ne", "-e", "go/aio", "--models", "foo", "--no-approve"],
];

const cases = CORPUS.map((args) => ({ args, result: view(parseArgs(args)) }));
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
		console.error("piargs golden.json is stale: run npx tsx go/internal/piargs/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`piargs golden.json is current (${cases.length} argv cases)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`piargs golden.json: ${cases.length} argv cases`);
}
