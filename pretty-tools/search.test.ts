import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerFindTool } from "./tools/find.ts";
import { registerGrepTool } from "./tools/grep.ts";
import { registerLsTool } from "./tools/ls.ts";
import { registerReadTool } from "./tools/read.ts";
import type { SdkToolDef } from "./types.ts";

type RegisteredTool = {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	}>;
};

interface RtkCall {
	command: string;
	args: string[];
	cwd?: string;
}

function captureTool(
	register: (pi: ExtensionAPI) => void,
	result: Partial<ExecResult> | Error = {},
): { tool: RegisteredTool; calls: RtkCall[] } {
	let tool: RegisteredTool | undefined;
	const calls: RtkCall[] = [];
	const pi = {
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
		async exec(command: string, args: string[], options?: { cwd?: string }) {
			calls.push({ command, args, cwd: options?.cwd });
			if (result instanceof Error) throw result;
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.code ?? 0,
				killed: result.killed ?? false,
			};
		},
	} as unknown as ExtensionAPI;
	register(pi);
	assert.ok(tool);
	return { tool, calls };
}

function sdkResult(text: string, calls: { count: number }): SdkToolDef {
	return {
		description: "SDK fallback",
		parameters: {},
		async execute() {
			calls.count++;
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

const ctx = { cwd: "/repo" } as ExtensionContext;

test("find routes through rtk find before the SDK fallback", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool(
		(pi) =>
			registerFindTool(pi, "/repo", undefined, sdkResult("sdk.ts", sdkCalls)),
		{ stdout: "2F 1D:\n\n./ index.ts lib.ts\n" },
	);

	const result = await tool.execute(
		"find-1",
		{ pattern: "**/*.ts", path: "src", limit: 1 },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.content[0]?.text, "index.ts");
	assert.equal(sdkCalls.count, 0);
	assert.deepEqual(calls, [
		{ command: "rtk", args: ["find", "*.ts", "src"], cwd: "/repo" },
	]);
});

test("find uses the SDK only when RTK cannot execute", async () => {
	const sdkCalls = { count: 0 };
	const { tool } = captureTool(
		(pi) =>
			registerFindTool(pi, "/repo", undefined, sdkResult("sdk.ts", sdkCalls)),
		new Error("rtk unavailable"),
	);

	const result = await tool.execute(
		"find-2",
		{ pattern: "*.ts" },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.content[0]?.text, "sdk.ts");
	assert.equal(sdkCalls.count, 1);
});

test("wildcard directory segments use the SDK because RTK cannot represent them", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool((pi) =>
		registerFindTool(pi, "/repo", undefined, sdkResult("sdk.ts", sdkCalls)),
	);

	const result = await tool.execute(
		"find-wildcard-dir",
		{ pattern: "packages/*/src/*.ts" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.content[0]?.text, "sdk.ts");
	assert.equal(sdkCalls.count, 1);
	assert.equal(calls.length, 0);
});

test("an RTK find error is reported without rerunning the SDK", async () => {
	const sdkCalls = { count: 0 };
	const { tool } = captureTool(
		(pi) =>
			registerFindTool(pi, "/repo", undefined, sdkResult("sdk.ts", sdkCalls)),
		{ code: 2, stderr: "rtk find failed" },
	);

	await assert.rejects(
		tool.execute("find-error", { pattern: "*.ts" }, undefined, undefined, ctx),
		/rtk find failed/,
	);
	assert.equal(sdkCalls.count, 0);
});

test("grep routes all options through rtk grep", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool(
		(pi) =>
			registerGrepTool(pi, "/repo", undefined, sdkResult("sdk", sdkCalls)),
		{ stdout: "src/index.ts:4:hello world\n" },
	);

	const result = await tool.execute(
		"grep-1",
		{
			pattern: "hello|world",
			path: "src",
			glob: "*.ts",
			ignoreCase: true,
			context: 2,
			limit: 10,
		},
		undefined,
		undefined,
		ctx,
	);

	assert.match(result.content[0]?.text ?? "", /src\/index\.ts:4/);
	assert.equal(sdkCalls.count, 0);
	assert.deepEqual(calls[0], {
		command: "rtk",
		args: [
			"grep",
			"-m",
			"10",
			"-l",
			"500",
			"-R",
			"-E",
			"-i",
			"-C",
			"2",
			"--include=*.ts",
			"--",
			"hello|world",
			"src",
		],
		cwd: "/repo",
	});
});

test("grep treats RTK exit code 1 as no matches without SDK bypass", async () => {
	const sdkCalls = { count: 0 };
	const { tool } = captureTool(
		(pi) =>
			registerGrepTool(pi, "/repo", undefined, sdkResult("sdk", sdkCalls)),
		{ code: 1 },
	);

	const result = await tool.execute(
		"grep-2",
		{ pattern: "missing" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.content[0]?.text, "");
	assert.equal(sdkCalls.count, 0);
});

test("grep registration tells agents that RTK routing is enforced", () => {
	const { tool } = captureTool((pi) =>
		registerGrepTool(pi, "/repo", undefined, sdkResult("sdk", { count: 0 })),
	);
	assert.match(tool.description ?? "", /rtk grep/i);
	assert.match(tool.promptSnippet ?? "", /RTK-enforced/);
	assert.ok(
		(tool.promptGuidelines ?? []).some((guideline) =>
			/enforces RTK/.test(guideline),
		),
	);
});

test("read routes text through RTK and preserves offset/limit", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool(
		(pi) =>
			registerReadTool(pi, "/repo", undefined, sdkResult("sdk", sdkCalls)),
		{ stdout: "  1 │ one\n  2 │ two\n  3 │ three\n" },
	);

	const result = await tool.execute(
		"read-1",
		{ path: "file.ts", offset: 2, limit: 1 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.content[0]?.text, "two");
	assert.equal(sdkCalls.count, 0);
	assert.deepEqual(calls[0], {
		command: "rtk",
		args: ["read", "file.ts", "--line-numbers"],
		cwd: "/repo",
	});
});

test("image reads use the SDK because RTK cannot return image content", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool((pi) =>
		registerReadTool(pi, "/repo", undefined, sdkResult("image", sdkCalls)),
	);

	await tool.execute(
		"read-image",
		{ path: "image.png" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(sdkCalls.count, 1);
	assert.equal(calls.length, 0);
});

test("ls routes through rtk ls before the SDK fallback", async () => {
	const sdkCalls = { count: 0 };
	const { tool, calls } = captureTool(
		(pi) => registerLsTool(pi, "/repo", undefined, sdkResult("sdk", sdkCalls)),
		{ stdout: "src/\nindex.ts\n" },
	);

	const result = await tool.execute(
		"ls-1",
		{ path: ".", limit: 1 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.content[0]?.text, "src/");
	assert.equal(sdkCalls.count, 0);
	assert.deepEqual(calls[0], {
		command: "rtk",
		args: ["ls", "-A", "."],
		cwd: "/repo",
	});
});
