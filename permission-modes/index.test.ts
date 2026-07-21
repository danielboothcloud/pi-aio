import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerPermissionModes } from "./index.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any>;

function makeHarness(options: { selections?: string[] } = {}) {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const handlers = new Map<string, EventHandler[]>();
	const sentUserMessages: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const selectPrompts: string[] = [];
	const selections = [...(options.selections ?? [])];

	const pi = {
		appendEntry: () => {},
		getActiveTools: () => ["read", "edit", "write", "bash"],
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (
			name: string,
			options: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => {
			commands.set(name, options);
		},
		registerFlag: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		sendUserMessage: (content: string) => {
			sentUserMessages.push(content);
		},
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		model: { provider: "cursor", id: "composer-2-5" },
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
			select: async (prompt: string) => {
				selectPrompts.push(prompt);
				return selections.shift();
			},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			theme: {
				fg: (_color: string, text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		commands,
		ctx,
		handlers,
		notifications,
		pi,
		selectPrompts,
		sentUserMessages,
	};
}

test("auto mode approves tools without queuing continuation prompts", async () => {
	const { commands, ctx, handlers, pi, sentUserMessages } = makeHarness();

	registerPermissionModes(pi);
	assert.equal(commands.has("auto-depth"), false);
	assert.equal(commands.has("done"), false);

	await commands.get("auto")?.handler("", ctx);

	const message = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
	} as AssistantMessage;
	for (const handler of handlers.get("turn_end") ?? []) {
		await handler({ message }, ctx);
	}

	assert.deepEqual(sentUserMessages, []);
});

test("Cursor default mode exposes bridge built-ins and routes mutations through Pi tools", async () => {
	const previous = process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	try {
		const { ctx, handlers, pi } = makeHarness();
		registerPermissionModes(pi);

		const [handler] = handlers.get("before_agent_start") ?? [];
		const result = await handler?.({}, ctx);
		assert.equal(process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS, "1");
		assert.match(
			result.message.content,
			/pi__edit, pi__write, pi__apply_patch, or pi__bash/,
		);
		assert.match(result.message.content, /instead of Cursor host tools/);
	} finally {
		if (previous === undefined)
			delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		else process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = previous;
	}
});

test("default mode prompts for bridged Cursor edits", async () => {
	const { ctx, handlers, pi, selectPrompts } = makeHarness({
		selections: ["Allow"],
	});
	registerPermissionModes(pi);

	const [handler] = handlers.get("tool_call") ?? [];
	const result = await handler?.(
		{
			toolCallId: "cursor-pi-bridge-run-1-tool-1",
			toolName: "edit",
			input: { path: "src/example.ts" },
		},
		ctx,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectPrompts, ["Allow edit on src/example.ts?"]);
});

test("default mode prompts once for all apply_patch target files", async () => {
	const { ctx, handlers, pi, selectPrompts } = makeHarness({
		selections: ["Allow"],
	});
	registerPermissionModes(pi);

	const [handler] = handlers.get("tool_call") ?? [];
	const result = await handler?.(
		{
			toolCallId: "call-apply-patch",
			toolName: "apply_patch",
			input: {
				changes: [
					{ path: "src/one.ts", action: "update" },
					{ path: "src/two.ts", action: "add" },
				],
			},
		},
		ctx,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectPrompts, [
		"Allow apply_patch on src/one.ts, src/two.ts?",
	]);
});

test("Cursor replay mutations warn instead of showing a misleading approval prompt", async () => {
	const { ctx, handlers, notifications, pi, selectPrompts } = makeHarness();
	registerPermissionModes(pi);

	const [handler] = handlers.get("tool_call") ?? [];
	const cursorActivityResult = await handler?.(
		{
			toolCallId: "cursor-replay-1-tool-1",
			toolName: "cursor",
			input: { activityTitle: "Cursor edit" },
		},
		ctx,
	);
	const patchReplayResult = await handler?.(
		{
			toolCallId: "cursor-replay-1-tool-2",
			toolName: "apply_patch",
			input: { changes: [{ path: "src/example.ts", action: "update" }] },
		},
		ctx,
	);

	assert.equal(cursorActivityResult, undefined);
	assert.equal(patchReplayResult, undefined);
	assert.deepEqual(selectPrompts, []);
	assert.equal(notifications.length, 2);
	for (const notification of notifications) {
		assert.match(
			notification.message,
			/action already ran outside Pi's permission gate/,
		);
		assert.equal(notification.level, "warning");
	}
});
