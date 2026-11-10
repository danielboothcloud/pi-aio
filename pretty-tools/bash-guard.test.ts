import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findGnuGrepInvocation, findRgReplaceMisuse } from "./grep-guard.ts";
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

test("findGnuGrepInvocation ignores grep inside quotes and heredoc bodies", () => {
	assert.equal(findGnuGrepInvocation(`rg -n 'a|grep -r' .`), undefined);
	assert.equal(findGnuGrepInvocation(`rg -n "x|grep" src`), undefined);
	assert.equal(findGnuGrepInvocation(`echo "a; grep b"`), undefined);
	assert.equal(
		findGnuGrepInvocation(
			"cat > /tmp/x.mts <<'EOF'\nconsole.log(f(`rg 'a|grep -r' .`));\nEOF\nnpx tsx /tmp/x.mts",
		),
		undefined,
	);
	assert.equal(findGnuGrepInvocation("git log --grep foo"), undefined);
});

test("findGnuGrepInvocation detects grep behind wrappers and nested scripts", () => {
	assert.equal(findGnuGrepInvocation("find . -name x | xargs grep foo"), "grep");
	assert.equal(findGnuGrepInvocation("env -u X grep foo"), "grep");
	assert.equal(findGnuGrepInvocation(`bash -c "grep foo file"`), "grep");
	assert.equal(findGnuGrepInvocation("echo $(grep foo file)"), "grep");
	assert.equal(
		findGnuGrepInvocation("cat <<'EOF' | grep foo\nbody\nEOF"),
		"grep",
	);
});

test("findRgReplaceMisuse flags -r clusters that swallow flag letters", () => {
	assert.deepEqual(findRgReplaceMisuse(`rg -rn "sveltos" x.tf`), {
		flag: "-rn",
		replacement: "n",
	});
	assert.deepEqual(findRgReplaceMisuse("rg -irn foo ."), {
		flag: "-irn",
		replacement: "n",
	});
	assert.deepEqual(findRgReplaceMisuse("rtk rg -rl foo"), {
		flag: "-rl",
		replacement: "l",
	});
	assert.deepEqual(
		findRgReplaceMisuse("cd x && /opt/bin/rg -rni foo | head"),
		{ flag: "-rni", replacement: "ni" },
	);
	assert.deepEqual(findRgReplaceMisuse("rg foo src -rn"), {
		flag: "-rn",
		replacement: "n",
	});
});

test("findRgReplaceMisuse allows deliberate replacements and other flags", () => {
	for (const command of [
		"rg -n foo",
		"rg -nr '$1' 'x(\\d)'",
		"rg 'x(\\d)' -r '$1'",
		"rg -r foo bar",
		"rg --replace=n foo",
		"rg --replace n foo",
		"rg -r'$1' 'x(\\d)'",
		"rg -A3 foo",
		"rg -e -rn src",
		"rg -g -rn foo",
		"rg --glob -rn foo",
		"rg -n foo -- -rn",
		`rg -n "a -rn b" .`,
		"echo rg -rn foo",
		"git grep -rn foo",
		"ls -rn",
	]) {
		assert.equal(findRgReplaceMisuse(command), undefined, command);
	}
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

test("bash tool blocks rg -rn with a --replace explanation", async () => {
	const calls = { count: 0 };
	const tool = captureTool((pi) =>
		registerBashTool(pi, "/repo", undefined, sdkBash(calls)),
	);

	const result = await tool.execute(
		"bash-5",
		{ command: `rg -rn "sveltos" components` },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.isError, true);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /Blocked `rg -rn`/);
	assert.match(text, /--replace/);
	assert.match(text, /rg -n/);
	assert.equal(calls.count, 0);
});

test("bash tool runs rg with grep in a quoted regex", async () => {
	const calls = { count: 0 };
	const tool = captureTool((pi) =>
		registerBashTool(pi, "/repo", undefined, sdkBash(calls)),
	);

	const result = await tool.execute(
		"bash-6",
		{ command: `rg -n 'GNU grep|grep -rn' src` },
		undefined,
		undefined,
		ctx,
	);

	assert.notEqual(result.isError, true);
	assert.equal(calls.count, 1);
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
	assert.ok(
		(tool.promptGuidelines ?? []).some((g) =>
			/`-r` means `--replace`/.test(g),
		),
	);
});
