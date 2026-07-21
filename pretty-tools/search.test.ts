import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFindTool } from "./tools/find.ts";
import { registerGrepTool } from "./tools/grep.ts";
import type { FffServiceWithCursor, SdkToolDef } from "./types.ts";

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
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

test("find uses FFF glob results before the SDK fallback", async () => {
	const sdkCalls = { count: 0 };
	const service = {
		isAvailable: true,
		partialIndex: false,
		getCursorStore: () => ({ store: () => "cursor", get: () => undefined }),
		getFinder: () => ({
			getBasePath: () => ({ ok: true, value: "/repo" }),
			glob: (pattern: string) => {
				assert.equal(pattern, "src/**/*.ts");
				return {
					ok: true,
					value: { items: [{ relativePath: "src/index.ts" }], totalMatched: 1 },
				};
			},
		}),
	} as unknown as FffServiceWithCursor;
	const tool = captureTool((pi) => registerFindTool(pi, "/repo", service, sdkResult("sdk.ts", sdkCalls)));

	const result = await tool.execute("find-1", { pattern: "*.ts", path: "src" }, undefined, undefined, ctx);

	assert.equal(result.content[0]?.text, "src/index.ts");
	assert.equal(result.details?.matchCount, 1);
	assert.equal(sdkCalls.count, 0);
});

test("find falls back to the SDK when an FFF glob unexpectedly returns no matches", async () => {
	const sdkCalls = { count: 0 };
	const service = {
		isAvailable: true,
		partialIndex: false,
		getCursorStore: () => ({ store: () => "cursor", get: () => undefined }),
		getFinder: () => ({
			getBasePath: () => ({ ok: true, value: "/repo" }),
			glob: () => ({ ok: true, value: { items: [], totalMatched: 0 } }),
		}),
	} as unknown as FffServiceWithCursor;
	const tool = captureTool((pi) => registerFindTool(pi, "/repo", service, sdkResult("sdk.ts", sdkCalls)));

	const result = await tool.execute("find-2", { pattern: "*.ts" }, undefined, undefined, ctx);

	assert.equal(result.content[0]?.text, "sdk.ts");
	assert.equal(sdkCalls.count, 1);
});

test("grep uses FFF only for unscoped searches and preserves SDK scoped search", async () => {
	const sdkCalls = { count: 0 };
	const service = {
		isAvailable: true,
		partialIndex: false,
		getCursorStore: () => ({ store: () => "fff_c1", get: () => undefined }),
		getFinder: () => ({
			grep: () => ({
				ok: true,
				value: {
					items: [{ relativePath: "src/index.ts", lineNumber: 4, lineContent: "hello world" }],
				},
			}),
		}),
	} as unknown as FffServiceWithCursor;
	const tool = captureTool((pi) => registerGrepTool(pi, "/repo", service, sdkResult("sdk:1:hello", sdkCalls)));

	const unscoped = await tool.execute("grep-1", { pattern: "hello" }, undefined, undefined, ctx);
	assert.match(unscoped.content[0]?.text ?? "", /src\/index\.ts:4:hello world/);
	assert.equal(sdkCalls.count, 0);

	const scoped = await tool.execute("grep-2", { pattern: "hello", path: "src" }, undefined, undefined, ctx);
	assert.equal(scoped.content[0]?.text, "sdk:1:hello");
	assert.equal(sdkCalls.count, 1);
});
