import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "node:test";
import { handleRtkSubcommand, registerRtkCommand } from "./command.ts";
import { registerRtk } from "./index.ts";
import {
	isRtkEnabled,
	resetRtkState,
	setRtkEnabled,
	setRtkRewriteFn,
} from "./rewrite.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any> | any;

interface Harness {
	commands: Map<string, Record<string, unknown>>;
	handlers: Map<string, EventHandler[]>;
	notifies: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	ctx: ExtensionContext;
	commandCtx: ExtensionCommandContext;
	pi: ExtensionAPI;
}

function makeHarness(selections: string[] = []): Harness {
	const commands = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, EventHandler[]>();
	const notifies: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const queue = [...selections];

	const pi = {
		registerCommand(name: string, opts: Record<string, unknown>) {
			commands.set(name, opts);
		},
		on(name: string, handler: EventHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const ui = {
		select: async () => queue.shift(),
		notify: (message: string, type?: string) =>
			notifies.push({ message, type }),
		setStatus: (key: string, text: string | undefined) =>
			statuses.push({ key, text }),
		theme: { fg: (_key: string, text: string) => text },
	};

	const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
	const commandCtx = { hasUI: true, ui } as unknown as ExtensionCommandContext;

	return { commands, handlers, notifies, statuses, ctx, commandCtx, pi };
}

beforeEach(() => resetRtkState());
afterEach(() => resetRtkState());

test("registerRtk registers the /rtk command and lifecycle handlers", () => {
	const h = makeHarness();
	registerRtk(h.pi);

	assert.ok(h.commands.has("rtk"), "/rtk command registered");
	assert.ok(
		h.handlers.has("session_start"),
		"session_start handler registered",
	);
	assert.ok(
		h.handlers.has("session_shutdown"),
		"session_shutdown handler registered",
	);
	assert.ok(h.handlers.has("tool_call"), "tool_call handler registered");
	assert.ok(h.handlers.has("user_bash"), "user_bash handler registered");
});

test("session_start sets the rtk footer status", () => {
	const h = makeHarness();
	registerRtk(h.pi);
	const [handler] = h.handlers.get("session_start")!;
	handler({ type: "session_start", reason: "startup" }, h.ctx);

	const rtkStatus = h.statuses.find((s) => s.key === "rtk");
	assert.ok(rtkStatus, "rtk footer status was set");
	assert.match(String(rtkStatus?.text), /rtk ✓/);
});

test("/rtk getArgumentCompletions returns matching subcommands", () => {
	const h = makeHarness();
	registerRtk(h.pi);
	const cmd = h.commands.get("rtk")!;
	const completions = (cmd.getArgumentCompletions as (p: string) => unknown[])(
		"en",
	);
	assert.deepEqual(completions, [{ label: "enable", value: "enable" }]);
});

test("handleRtkSubcommand enable turns the toggle on and notifies", () => {
	const h = makeHarness();
	setRtkEnabled(false);
	handleRtkSubcommand("enable", h.ctx);
	assert.equal(isRtkEnabled(), true);
	assert.equal(h.notifies.at(-1)?.type, "info");
	assert.match(String(h.notifies.at(-1)?.message), /enabled/);
});

test("handleRtkSubcommand disable turns the toggle off and notifies", () => {
	const h = makeHarness();
	handleRtkSubcommand("disable", h.ctx);
	assert.equal(isRtkEnabled(), false);
	assert.match(String(h.notifies.at(-1)?.message), /disabled/);
});

test("handleRtkSubcommand status reports state, binary, and tip", () => {
	const h = makeHarness();
	handleRtkSubcommand("status", h.ctx);
	const msg = String(h.notifies.at(-1)?.message);
	assert.match(msg, /Session toggle:/);
	assert.match(msg, /Binary:/);
	assert.match(msg, /Tip:/);
});

test("/rtk with no argument opens the overlay and applies the selection", async () => {
	const h = makeHarness(["disable"]);
	registerRtk(h.pi);
	const cmd = h.commands.get("rtk")!;
	await (
		cmd.handler as (a: string, c: ExtensionCommandContext) => Promise<void>
	)("", h.commandCtx);

	assert.equal(isRtkEnabled(), false);
	assert.match(String(h.notifies.at(-1)?.message), /disabled/);
});

test("/rtk with an invalid subcommand notifies an error", async () => {
	const h = makeHarness();
	registerRtk(h.pi);
	const cmd = h.commands.get("rtk")!;
	await (
		cmd.handler as (a: string, c: ExtensionCommandContext) => Promise<void>
	)("bogus", h.commandCtx);

	assert.equal(h.notifies.at(-1)?.type, "error");
	assert.match(String(h.notifies.at(-1)?.message), /Unknown \/rtk subcommand/);
});

test("tool_call handler rewrites agent bash commands", async () => {
	const h = makeHarness();
	setRtkRewriteFn((command) => `rtk-test:${command}`);
	registerRtk(h.pi);
	const [handler] = h.handlers.get("tool_call")!;
	const event = {
		type: "tool_call",
		toolCallId: "bash-1",
		toolName: "bash",
		input: { command: "git status" },
	};

	await handler(event, h.ctx);
	assert.equal(event.input.command, "rtk-test:git status");
});

test("tool_call handler leaves non-bash tools and disabled RTK untouched", async () => {
	const h = makeHarness();
	setRtkRewriteFn((command) => `rtk-test:${command}`);
	registerRtk(h.pi);
	const [handler] = h.handlers.get("tool_call")!;
	const readEvent = {
		type: "tool_call",
		toolCallId: "read-1",
		toolName: "read",
		input: { path: "README.md" },
	};
	await handler(readEvent, h.ctx);
	assert.deepEqual(readEvent.input, { path: "README.md" });

	setRtkEnabled(false);
	const bashEvent = {
		type: "tool_call",
		toolCallId: "bash-2",
		toolName: "bash",
		input: { command: "git status" },
	};
	await handler(bashEvent, h.ctx);
	assert.equal(bashEvent.input.command, "git status");
});

test("user_bash handler skips !! commands (excluded from context)", async () => {
	const h = makeHarness();
	setRtkRewriteFn(() => "rewritten");
	registerRtk(h.pi);
	const [handler] = h.handlers.get("user_bash")!;
	const result = await handler(
		{ type: "user_bash", command: "ls", excludeFromContext: true, cwd: "/tmp" },
		h.ctx,
	);
	assert.equal(result, undefined);
});

test("user_bash handler skips rewriting when the toggle is disabled", async () => {
	const h = makeHarness();
	setRtkEnabled(false);
	setRtkRewriteFn(() => "rewritten");
	registerRtk(h.pi);
	const [handler] = h.handlers.get("user_bash")!;
	const result = await handler(
		{
			type: "user_bash",
			command: "ls",
			excludeFromContext: false,
			cwd: "/tmp",
		},
		h.ctx,
	);
	assert.equal(result, undefined);
});

test("user_bash handler returns operations when enabled and rewrite succeeds", async () => {
	const h = makeHarness();
	setRtkRewriteFn(() => "rtk-rewritten");
	registerRtk(h.pi);
	const [handler] = h.handlers.get("user_bash")!;
	const result = await handler(
		{
			type: "user_bash",
			command: "ls",
			excludeFromContext: false,
			cwd: "/tmp",
		},
		h.ctx,
	);
	assert.ok(
		result?.operations?.exec,
		"expected operations.exec to be returned",
	);
});

test("user_bash handler falls through when rewrite has no equivalent", async () => {
	const h = makeHarness();
	setRtkRewriteFn(() => undefined);
	registerRtk(h.pi);
	const [handler] = h.handlers.get("user_bash")!;
	const result = await handler(
		{
			type: "user_bash",
			command: "ls",
			excludeFromContext: false,
			cwd: "/tmp",
		},
		h.ctx,
	);
	assert.equal(result, undefined);
});

test("registerRtkCommand can be used standalone", () => {
	const h = makeHarness();
	const pi = {
		registerCommand(name: string, opts: Record<string, unknown>) {
			h.commands.set(name, opts);
		},
	} as unknown as ExtensionAPI;
	registerRtkCommand(pi);
	assert.ok(h.commands.has("rtk"));
});
