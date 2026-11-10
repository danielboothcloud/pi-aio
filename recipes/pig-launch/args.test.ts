import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs as piParseArgs } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "./args.ts";

/** Comparable view: Maps become entries; diagnostics are not used by the launcher. */
function view(result: object): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(result)) {
		if (key === "diagnostics" || value === undefined) continue;
		out[key] = value instanceof Map ? [...value.entries()] : value;
	}
	return out;
}

const CORPUS: string[][] = [
	[],
	["hello", "world"],
	["--recipe", "work"],
	["--recipe=work", "-p", "hi"],
	["--recipe", "--continue"],
	["-c"],
	["--continue", "--recipe", "x", "prompt"],
	["-r"],
	["--session", "/tmp/s.jsonl", "--session-id", "abc"],
	["--session-dir", "~/s", "-c"],
	["--fork", "f.jsonl", "--name", "n"],
	["-n"],
	["--no-session", "-p"],
	["-p", "---literal"],
	["-p", "-x"],
	["-p", "@file.md", "msg"],
	["--print", "msg", "--mode", "json"],
	["--mode", "bogus"],
	["--mode"],
	["--models", "a/*, b ,,c"],
	["-ne", "-e", "./x.ts", "--extension", "npm:y"],
	["--no-extensions", "--no-mcp", "--no-skills", "-np", "--no-themes", "-nc"],
	["--thinking", "high", "--thinking", "bogus"],
	["--model", "anthropic/x", "--provider", "p", "--api-key", "k"],
	["--system-prompt", "s", "--append-system-prompt", "a", "--append-system-prompt", "b"],
	["--exclude-tools", "bash,read", "-xt", "write"],
	["--no-tools", "-nbt"],
	["--skill", "s", "--prompt-template", "t", "--theme", "th", "--use-theme", "dark"],
	["--use-theme", "-x"],
	["--list-models"],
	["--list-models", "sonnet"],
	["--list-models", "-p"],
	["--list-models", "@f"],
	["--tui-mode", "fullscreen"],
	["--tui-mode", "bad"],
	["--tui-mode"],
	["--verbose", "--offline", "-a", "--no-approve", "-na"],
	["--help", "-v"],
	["--export", "out.html"],
	["--permission-mode", "auto", "--unknown", "--other=val", "--flag", "@file"],
	["--piglet", "work", "--no-stdin", "msg"],
	["-x", "-yz", "@a", "@b", "plain"],
	["--", "--recipe", "x", "@f", "-c"],
	["msg", "--", "@x"],
	["--session"],
	["--models"],
	["-e"],
];

test("vendored parseArgs matches the pinned Pi parser on the corpus", () => {
	for (const args of CORPUS) {
		assert.deepEqual(view(parseArgs(args)), view(piParseArgs(args)), JSON.stringify(args));
	}
});

test("vendored parseArgs keeps valid tool lists like Pi", () => {
	for (const args of [["--tools", "read,bash"], ["-t", "read, write"]]) {
		const pi = piParseArgs(args);
		assert.deepEqual(pi.diagnostics, []);
		assert.deepEqual(parseArgs(args).tools, pi.tools);
	}
});
