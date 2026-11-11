// Regenerate golden.json from the TypeScript rtk and user-bash helpers:
//   npx tsx go/internal/rtk/testdata/gen-golden.ts [--check]
// It drives rtkRewriteCommand through its test seam, so the skip and
// prefix rules are compared without a real rtk binary.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const rewrite = await import(join(repo, "rtk", "rewrite.ts"));
const parse = await import(join(repo, "user-bash", "parse-bash-input.ts"));

const commands = ["ls -la", "rtk git status", "  rtk", "rtkx foo", "RTK_DISABLED=1 git status", "env RTK_DISABLED=1 git log",
	"FOO=1 RTK_DISABLED=1 BAR=2 make", "a && RTK_DISABLED=1 b", "x | env RTK_DISABLED=1 y; RTK_DISABLED=1 z", "echo RTK_DISABLED=1 x",
	"RTK_DISABLED=1 rtk ls", "MYRTK_DISABLED=1 ls", "RTK_DISABLED=10 ls", "env FOO=1 ls", "RTK_DISABLED=1\tls", ""];
const seen: string[] = [];
rewrite.setRtkRewriteFn((command: string) => { seen.push(command); return command.startsWith("git") ? `rtk ${command}` : command; });
const rewrites = commands.map((command) => {
	seen.length = 0;
	const result = rewrite.rtkRewriteCommand(command) ?? null;
	return { command, sentToRtk: seen[0] ?? null, result };
});
rewrite.resetRtkState();

const texts = ["", "ls", "!ls", "!!ls", "  ! ls", "!", "!!", "! ", "!!  x", "\t!git status", "x!y", "!!!a"];
const bash = texts.map((text) => ({ text, state: parse.parseBashInput(text), spaced: parse.ensureBashSpacing(text) }));

const output = `${JSON.stringify({ rewrites, bash }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("rtk golden.json is stale: run npx tsx go/internal/rtk/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`rtk golden.json is current (${rewrites.length} commands, ${bash.length} editor texts)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`rtk golden.json: ${rewrites.length} commands, ${bash.length} editor texts`);
}
