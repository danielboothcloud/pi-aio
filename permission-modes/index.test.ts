import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	const tools = new Map<string, any>();

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
		registerTool: (tool: { name: string }) => {
			tools.set(tool.name, tool);
		},
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
				strikethrough: (text: string) => text,
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
		tools,
	};
}

async function executeTodo(
	tool: any,
	params: Record<string, unknown>,
	ctx: ExtensionCommandContext,
) {
	return tool.execute("todo-call", params, undefined, undefined, ctx);
}

test("todo tool creates, renames, reorders, and deletes steps", async () => {
	const { ctx, pi, tools } = makeHarness();
	registerPermissionModes(pi);
	const todo = tools.get("todo");
	assert.ok(todo);

	await executeTodo(todo, { action: "create", text: "First" }, ctx);
	await executeTodo(todo, { action: "create", text: "Third" }, ctx);
	let response = await executeTodo(
		todo,
		{ action: "create", text: "Second", position: 2 },
		ctx,
	);
	assert.deepEqual(
		response.details.todos.map((item: any) => [item.step, item.text]),
		[
			[1, "First"],
			[2, "Second"],
			[3, "Third"],
		],
	);

	response = await executeTodo(
		todo,
		{ action: "rename", step: 1, text: "Updated first" },
		ctx,
	);
	assert.equal(response.details.todos[0].text, "Updated first");

	response = await executeTodo(
		todo,
		{ action: "reorder", step: 3, position: 1 },
		ctx,
	);
	assert.deepEqual(
		response.details.todos.map((item: any) => [item.step, item.text]),
		[
			[1, "Third"],
			[2, "Updated first"],
			[3, "Second"],
		],
	);

	await executeTodo(todo, { action: "toggle", step: 2 }, ctx);
	response = await executeTodo(todo, { action: "delete", step: 1 }, ctx);
	assert.deepEqual(response.details.todos, [
		{ step: 1, text: "Updated first", completed: true },
		{ step: 2, text: "Second", completed: false },
	]);
});

test("todo mutations validate action-specific parameters", async () => {
	const { ctx, pi, tools } = makeHarness();
	registerPermissionModes(pi);
	const todo = tools.get("todo");
	assert.ok(todo);

	const missingText = await executeTodo(todo, { action: "create" }, ctx);
	assert.equal(missingText.details.error, "text required");

	await executeTodo(todo, { action: "create", text: "Only step" }, ctx);
	const badPosition = await executeTodo(
		todo,
		{ action: "reorder", step: 1, position: 2 },
		ctx,
	);
	assert.equal(badPosition.details.error, "position must be between 1 and 1");

	const missingStep = await executeTodo(todo, { action: "delete" }, ctx);
	assert.equal(missingStep.details.error, "step required");
	const unknownStep = await executeTodo(
		todo,
		{ action: "rename", step: 9, text: "Missing" },
		ctx,
	);
	assert.equal(unknownStep.details.error, "step 9 not found");
});

test("ask mode is passive without forcing a plan workflow", async () => {
	const previous = process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	try {
		const { commands, ctx, handlers, pi, selectPrompts } = makeHarness();
		registerPermissionModes(pi);

		assert.equal(commands.has("ask"), true);
		await commands.get("ask")?.handler("", ctx);

		const [toolCall] = handlers.get("tool_call") ?? [];
		const editResult = await toolCall?.(
			{
				toolCallId: "ask-edit",
				toolName: "edit",
				input: { path: "src/example.ts" },
			},
			ctx,
		);
		const bashResult = await toolCall?.(
			{
				toolCallId: "ask-bash",
				toolName: "bash",
				input: { command: "npm install" },
			},
			ctx,
		);
		const readResult = await toolCall?.(
			{
				toolCallId: "ask-read",
				toolName: "read",
				input: { path: "README.md" },
			},
			ctx,
		);

		assert.match(editResult.reason, /Ask mode: edit disabled/);
		assert.match(bashResult.reason, /Ask mode: read-only commands only/);
		assert.equal(readResult, undefined);
		assert.deepEqual(selectPrompts, []);

		const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
		const context = await beforeAgentStart?.({}, ctx);
		assert.match(context.message.content, /\[ASK MODE ACTIVE\]/);
		assert.match(context.message.content, /Answer the user's request directly/);
		assert.match(
			context.message.content,
			/Do not create an implementation plan/,
		);
		assert.doesNotMatch(
			context.message.content,
			/Create a detailed numbered plan/,
		);
		assert.equal(process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS, undefined);
	} finally {
		if (previous === undefined)
			delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		else process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = previous;
	}
});

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
	const previous = process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	const tempDir = mkdtempSync(join(tmpdir(), "permission-edit-preview-"));
	const filePath = join(tempDir, "example.ts");
	writeFileSync(filePath, "const value = 1;\n");
	try {
		const { ctx, handlers, pi, selectPrompts } = makeHarness({
			selections: ["Allow"],
		});
		registerPermissionModes(pi);

		const [handler] = handlers.get("tool_call") ?? [];
		const result = await handler?.(
			{
				toolCallId: "cursor-pi-bridge-run-1-tool-1",
				toolName: "edit",
				input: {
					path: filePath,
					oldText: "const value = 1;",
					newText: "const value = 2;",
				},
			},
			ctx,
		);

		assert.equal(result, undefined);
		assert.equal(selectPrompts.length, 1);
		assert.match(selectPrompts[0], /Allow edit on .*example\.ts\?/);
		assert.match(selectPrompts[0], /- const value = 1;/);
		assert.match(selectPrompts[0], /\+ const value = 2;/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
		if (previous === undefined)
			delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		else process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = previous;
	}
});

test("default mode prompts once for all apply_patch target files", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "permission-patch-preview-"));
	const onePath = join(tempDir, "one.ts");
	const twoPath = join(tempDir, "two.ts");
	writeFileSync(onePath, "const one = 1;\n");
	try {
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
						{
							path: onePath,
							action: "update",
							oldText: "const one = 1;",
							newText: "const one = 10;",
						},
						{ path: twoPath, action: "add", content: "export const two = 2;\n" },
					],
				},
			},
			ctx,
		);

		assert.equal(result, undefined);
		assert.equal(selectPrompts.length, 1);
		assert.match(selectPrompts[0], /Allow apply_patch on .*one\.ts.*two\.ts\?/);
		assert.match(selectPrompts[0], /--- one.ts ---/);
		assert.match(selectPrompts[0], /--- two.ts \(new file\) ---/);
		assert.match(selectPrompts[0], /\+ export const two = 2;/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
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
		assert.match(notification.message, /pi__edit, pi__write, pi__apply_patch/);
		assert.equal(notification.level, "warning");
	}
});
