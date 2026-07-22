import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findGnuGrepInvocation } from "./grep-guard.ts";
import { registerBashTool } from "./tools/bash.ts";
import type { SdkToolDef } from "./types.ts";

type RegisteredTool = {
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	}>;
};

function captureTool(register: (pi: ExtensionAPI) => void): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	register(pi);
	assert.ok(tool);
	return tool;
}

function sdkBash(calls: { count: number }): SdkToolDef {
	return {
		description: "SDK bash",
		parameters: {},
		async execute(_tid: string, params: Record<string, unknown>) {
			calls.count++;
			return {
				content: [
					{
						type: "text" as const,
						text: `ran: ${String(params.command ?? "")}`,
					},
				],
				details: {
					_type: "bashResult",
					text: "ok",
					exitCode: 0,
					command: String(params.command ?? ""),
				},
			};
		},
	} as unknown as SdkToolDef;
}

const ctx = { cwd: "/repo" } as ExtensionContext;

test("findGnuGrepInvocation detects GNU grep at command and pipe positions", () => {
	assert.equal(findGnuGrepInvocation("grep -r foo ."), "grep");
	assert.equal(findGnuGrepInvocation("cat log.txt | grep error"), "grep");
	assert.equal(findGnuGrepInvocation("sudo grep foo /etc/hosts"), "grep");
	assert.equal(findGnuGrepInvocation("sudo -n grep foo file"), "grep");
	assert.equal(findGnuGrepInvocation("egrep -n foo file"), "egrep");
	assert.equal(findGnuGrepInvocation("fgrep foo file"), "fgrep");
	assert.equal(findGnuGrepInvocation("ggrep foo file"), "ggrep");
	assert.equal(
		findGnuGrepInvocation("/usr/bin/grep foo file"),
		"/usr/bin/grep",
	);
	assert.equal(findGnuGrepInvocation("FOO=bar grep foo file"), "grep");
	assert.equal(findGnuGrepInvocation("ls && grep foo"), "grep");
	assert.equal(findGnuGrepInvocation("ls; grep foo"), "grep");
	assert.equal(findGnuGrepInvocation("ls || grep foo"), "grep");
});

test("findGnuGrepInvocation ignores ripgrep and non-grep commands", () => {
	assert.equal(findGnuGrepInvocation("rg -n foo"), undefined);
	assert.equal(findGnuGrepInvocation("git grep foo"), undefined);
	assert.equal(findGnuGrepInvocation("pgrep -fl node"), undefined);
	assert.equal(findGnuGrepInvocation('echo "grep is a tool"'), undefined);
	assert.equal(findGnuGrepInvocation("cat greplog.txt"), undefined);
	assert.equal(findGnuGrepInvocation("ls -la"), undefined);
	assert.equal(findGnuGrepInvocation(""), undefined);
});

test("bash tool blocks GNU grep with a ripgrep nudge", async () => {
	const calls = { count: 0 };
	const tool = captureTool((pi) =>
		registerBashTool(pi, "/repo", undefined, sdkBash(calls)),
	);

	const result = await tool.execute(
		"bash-1",
		{ command: "grep -r hello ." },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /Blocked GNU grep invocation/);
	assert.match(result.content[0]?.text ?? "", /rg -n/);
	assert.equal(calls.count, 0);
});

test("bash tool allows ripgrep and other commands through the guard", async () => {
	const calls = { count: 0 };
	const tool = captureTool((pi) =>
		registerBashTool(pi, "/repo", undefined, sdkBash(calls)),
	);

	const rg = await tool.execute(
		"bash-2",
		{ command: "rg -n hello" },
		undefined,
		undefined,
		ctx,
	);
	assert.notEqual(rg.isError, true);

	const gitGrep = await tool.execute(
		"bash-3",
		{ command: "git grep hello" },
		undefined,
		undefined,
		ctx,
	);
	assert.notEqual(gitGrep.isError, true);

	assert.equal(calls.count, 2);
});

test("PRETTY_BASH_GREP_GUARD=0 disables the guard", async () => {
	process.env.PRETTY_BASH_GREP_GUARD = "0";
	try {
		const calls = { count: 0 };
		const tool = captureTool((pi) =>
			registerBashTool(pi, "/repo", undefined, sdkBash(calls)),
		);

		const result = await tool.execute(
			"bash-4",
			{ command: "grep hello file.txt" },
			undefined,
			undefined,
			ctx,
		);
		assert.notEqual(result.isError, true);
		assert.equal(calls.count, 1);
	} finally {
		delete process.env.PRETTY_BASH_GREP_GUARD;
	}
});

test("bash guidelines mention that GNU grep is blocked", () => {
	const tool = captureTool((pi) =>
		registerBashTool(pi, "/repo", undefined, sdkBash({ count: 0 })),
	);
	assert.ok(
		(tool.promptGuidelines ?? []).some((g) => /GNU grep.*blocked/.test(g)),
	);
});
