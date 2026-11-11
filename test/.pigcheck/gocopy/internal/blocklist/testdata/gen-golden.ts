// Regenerate golden.json from the TypeScript blocklist (the reference):
//   npx tsx go/internal/blocklist/testdata/gen-golden.ts
// With --check it writes nothing and exits 1 when golden.json is stale
// (npm run test:go runs the check, so a TS change cannot drift silently).
// The Go tests must reproduce every result. Commands are harvested from the
// TypeScript blocklist tests plus EXTRA, so new TS cases flow into Go parity.
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "aio-golden-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.AIO_SUBAGENT_CHILD;

const { segmentCommand, commandArgvs } = await import(join(repo, "blocklist", "segments.ts"));
const { checkBlocklist } = await import(join(repo, "blocklist", "config.ts"));

const EXTRA = [
	"", "   ", "ls -la", "a | b || c && d; e & f", "echo 'it''s'", "echo \"a $(b \"c\") d\"",
	"cat <<-EOF\n\tbody\n\tEOF", "bash <<< 'vault x'", "sh -c \"git push\"", "env -S 'git push'",
	"command -v git", "timeout 5 git push", "nice -n5 git push", "sudo -u root -- git push origin",
	"xargs -I{} git push", "npx -y vitest run", "perl -we 'exec @ARGV' git push", "eval 'git push'",
	"source ./x.sh", ". ./x.sh", "(cd a && git push)", "{ git push; }", "if true; then git push; fi",
	"echo ${X:-$(git push)}", "echo $'a\\'b'", "x=1 y=2 git push", "\"FOO=1\" git push", "git push 2>&1 >/dev/null",
	"diff <(git show a) <(git show b)", "echo `git push`", "echo \\\ngit push", "# comment only", "git push # trailing",
	"echo 'unbalanced", "echo \"unbalanced", "echo $(unterminated", "cat <<EOF\nnever ends", "echo > ",
	"bash", "cat x | bash", "bash -s < script.sh", "bash script.sh", "bash -o pipefail -c 'git push'",
	"GIT_DIR=x git -C repo push --force", "git commit-tree", "git commit -m x", "git pushx", "git push-mirror",
	"rg -n 'git push' .", "echo 日本語 && git push", "RM -RF /", "kubectl DELETE ns x",
];

function harvest(file: string): string[] {
	const text = readFileSync(join(repo, "blocklist", file), "utf8");
	const out: string[] = [];
	for (const match of text.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
		let value: unknown;
		try {
			value = JSON.parse(match[0]);
		} catch {
			// A source literal that is not valid JSON (JS-only escapes) is not a command case.
			continue;
		}
		if (typeof value === "string") out.push(value);
	}
	return out;
}
const commands = [...new Set([...EXTRA, ...harvest("segments.test.ts"), ...harvest("command-mode.test.ts")])];

// Rule sets: the user's real global shape (with JS lookahead) in command
// mode, plus text-mode entries, so the regex engine is part of parity.
const RULE_SETS = {
	command: {
		match: "command",
		entries: [
			{ pattern: "^brew\\b", regex: true },
			{ pattern: "^git\\s+((-C|-c)\\s+\\S+\\s+)*(commit|push)(?![\\w-])", regex: true, reason: "no git commit/push" },
			{ pattern: "^vault\\b", regex: true },
			{ pattern: "^(npm|pnpm|yarn)\\b.*\\b(test:stack|test:e2e)\\b", regex: true },
			{ pattern: "^(npx\\s+)?vitest\\b.*vitest\\.stack\\.config", regex: true },
			{ pattern: "^(export\\s+)?RR_TEST_RUNNER\\s*=", regex: true },
			{ pattern: "^jj\\s+(bookmark|b)\\s+(create|set|move|delete|forget)\\b", regex: true },
			{ pattern: "^(npx\\s+)?playwright\\b", regex: true },
		],
	},
	text: {
		entries: [
			"rm -rf /",
			{ pattern: "\\bvault\\b", regex: true },
			{ pattern: "^(?![\\s\\S]*check:remote)[\\s\\S]*--repeat-each\\b", regex: true },
			{ pattern: "kubectl delete", reason: "no deletes" },
			{ pattern: "(a)\\1x", regex: true },
		],
	},
	mixed: {
		entries: [
			{ pattern: "^git\\s+push(?![\\w-])", regex: true, match: "command" },
			{ pattern: "日本", reason: "unicode text rule" },
			{ pattern: "([", regex: true },
		],
	},
};

const segments = commands.map((command) => {
	const result = segmentCommand(command);
	return result.ok
		? { command, ok: true, segments: result.segments, argvs: commandArgvs(command) }
		: { command, ok: false, reason: result.reason };
});
const evaluations: Record<string, unknown[]> = {};
for (const [name, config] of Object.entries(RULE_SETS)) {
	writeFileSync(join(agentDir, "aio-blocklist.json"), JSON.stringify(config));
	evaluations[name] = commands.map((command) => {
		const hit = checkBlocklist(command, projectDir);
		return hit ? { command, hit } : { command };
	});
}
const output = `${JSON.stringify({ ruleSets: RULE_SETS, segments, evaluations }, null, 1)}\n`;
rmSync(tmp, { recursive: true, force: true });
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("golden.json is stale: run npx tsx go/internal/blocklist/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`golden.json is current (${commands.length} commands)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`golden.json: ${commands.length} commands, ${Object.keys(RULE_SETS).length} rule sets`);
}
