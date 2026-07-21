import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerPermissionModes } from "./index.ts";

test("auto mode approves tools without queuing continuation prompts", async () => {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>
	>();
	const sentUserMessages: string[] = [];

	const pi = {
		appendEntry: () => {},
		getActiveTools: () => ["read", "edit", "write", "bash"],
		on: (
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
		) => {
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

	registerPermissionModes(pi);
	assert.equal(commands.has("auto-depth"), false);
	assert.equal(commands.has("done"), false);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			theme: {
				fg: (_color: string, text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;

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
