import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerBlocklist } from "./index.ts";
import { registerPermissionModes } from "../permission-modes/index.ts";
import { registerUserBash } from "../user-bash/index.ts";
import { BLOCKLIST_FILE_NAME } from "./config.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any>;

// Isolated agent dir + project cwd per test file.
const tmp = mkdtempSync(join(tmpdir(), "aio-blocklist-index-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, BLOCKLIST_FILE_NAME), JSON.stringify(config));
}

function writeProject(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", BLOCKLIST_FILE_NAME), JSON.stringify(config));
}

function makeHarness(options: { selections?: string[] } = {}) {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const handlers = new Map<string, EventHandler[]>();
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
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		cwd: projectDir,
		model: { provider: "cursor", id: "composer-2-5" },
		ui: {
			notify: () => {},
			select: async (prompt: string) => {
				selectPrompts.push(prompt);
				return selections.shift();
			},
			setEditorComponent: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;

	// Same registration order as index.ts: blocklist gates first. Record the
	// blocklist's own handler indices so tests target them, not the ones
	// permission-modes/user-bash register for the same events.
	const blocklistBeforeAgentStart =
		handlers.get("before_agent_start")?.length ?? 0;
	const blocklistContext = handlers.get("context")?.length ?? 0;
	registerBlocklist(pi);
	registerPermissionModes(pi);
	registerUserBash(pi);

	return {
		commands,
		ctx,
		handlers,
		selectPrompts,
		async setMode(mode: "default" | "ask" | "plan" | "auto") {
			const cmd = commands.get(mode);
			assert.ok(cmd, `mode command ${mode} missing`);
			await cmd.handler("", ctx as unknown as ExtensionCommandContext);
		},
		async runToolCall(
			toolName: string,
			input: Record<string, unknown>,
			toolCallId = "call_1",
		) {
			// Mirrors the runner: first { block: true } wins; undefined passes
			// through to later handlers.
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = await handler(
					{ type: "tool_call", toolName, toolCallId, input },
					ctx,
				);
				if (result && result.block) return result;
			}
			return undefined;
		},
		async runUserBash(command: string, cwd = "/tmp") {
			// Mirrors the runner: first non-undefined result wins.
			for (const handler of handlers.get("user_bash") ?? []) {
				const result = await handler(
					{ type: "user_bash", command, cwd, excludeFromContext: false },
					ctx,
				);
				if (result) return result;
			}
			return undefined;
		},
		async runBeforeAgentStart() {
			const handler =
				handlers.get("before_agent_start")?.[blocklistBeforeAgentStart];
			assert.ok(handler, "blocklist before_agent_start handler missing");
			return handler({ type: "before_agent_start" }, ctx);
		},
		blocklistContextHandler() {
			const handler = handlers.get("context")?.[blocklistContext];
			assert.ok(handler, "blocklist context handler missing");
			return handler;
		},
	};
}

test("tool_call: blocks a blocklisted bash command in auto mode", async () => {
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runToolCall("bash", {
		command: "rm -rf /tmp/data",
	});
	assert.ok(result);
	assert.equal(result.block, true);
	assert.match(String(result.reason), /Blocked by aio blocklist/);
	assert.match(String(result.reason), /rm -rf \/tmp\/data/);
});

test("tool_call: blocklist wins over the permission gate even in ask mode", async () => {
	// "ls -la" is on the permission gate's read-only allowlist, so in ask mode
	// only the blocklist can stop it — proves the blocklist runs first.
	writeGlobal({ enabled: true, entries: ["ls -la"] });
	const harness = makeHarness();
	await harness.setMode("ask");

	const result = await harness.runToolCall("bash", { command: "ls -la" });
	assert.ok(result);
	assert.equal(result.block, true);
	assert.match(String(result.reason), /Blocked by aio blocklist/);
});

test("tool_call: blocklist reason wins over permission reason in ask mode", async () => {
	writeGlobal({ enabled: true, entries: ["kubectl delete"] });
	const harness = makeHarness();
	await harness.setMode("ask");

	const result = await harness.runToolCall("bash", {
		command: "kubectl delete ns staging",
	});
	assert.ok(result);
	// Both gates would block; the blocklist (registered first) must win.
	assert.match(String(result.reason), /Blocked by aio blocklist/);
	assert.doesNotMatch(String(result.reason), /Ask mode/);
});

test("tool_call: non-blocklisted bash passes through in auto mode", async () => {
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runToolCall("bash", { command: "git status" });
	assert.equal(result, undefined);
});

test("tool_call: skips cursor-replay tool calls (display-only)", async () => {
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runToolCall(
		"bash",
		{ command: "rm -rf /tmp/data" },
		"cursor-replay-abc123",
	);
	assert.equal(result, undefined);
});

test("tool_call: non-bash tools are never blocklisted", async () => {
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runToolCall("write", {
		path: "/tmp/notes.txt",
		content: "run: rm -rf /",
	});
	assert.equal(result, undefined);
});

test("tool_call: blocklist applies even in default mode (no prompt shown)", async () => {
	writeGlobal({ enabled: true, entries: ["kubectl delete"] });
	const harness = makeHarness();

	const result = await harness.runToolCall("bash", {
		command: "kubectl delete ns staging",
	});
	assert.ok(result);
	assert.equal(result.block, true);
	assert.deepEqual(
		harness.selectPrompts,
		[],
		"must not prompt for a blocked command",
	);
});

test("user_bash: blocks blocklisted commands before the mode gate (no prompt)", async () => {
	writeGlobal({ enabled: true, entries: ["npm run drop-db"] });
	const harness = makeHarness();

	const result = await harness.runUserBash("npm run drop-db");
	assert.ok(result);
	assert.equal(result.result.exitCode, 1);
	assert.match(String(result.result.output), /Blocked by aio blocklist/);
	assert.deepEqual(harness.selectPrompts, [], "user-bash gate must not prompt");
});

test("user_bash: blocks in auto mode too", async () => {
	writeGlobal({ enabled: true, entries: ["npm run drop-db"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runUserBash("npm run drop-db");
	assert.ok(result);
	assert.equal(result.result.exitCode, 1);
});

test("user_bash: non-blocklisted commands pass through to the mode gate", async () => {
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runUserBash("npm install");
	assert.equal(
		result,
		undefined,
		"auto mode should approve a non-blocked command",
	);
});

test("user_bash: project config is resolved from the event cwd", async () => {
	writeProject(projectDir, {
		enabled: true,
		entries: [{ pattern: "kubectl delete", reason: "no cluster deletions" }],
	});
	const harness = makeHarness();

	const blockedHere = await harness.runUserBash(
		"kubectl delete ns",
		projectDir,
	);
	assert.ok(blockedHere);
	assert.match(String(blockedHere.result.output), /no cluster deletions/);

	// Same command from a different cwd (no project config) hits only the
	// (empty) global blocklist, so it falls through to the mode gate — in
	// auto mode that means approval.
	await harness.setMode("auto");
	const elsewhere = await harness.runUserBash(
		"kubectl delete ns",
		"/tmp/other",
	);
	assert.equal(
		elsewhere,
		undefined,
		"falls through when no project rule applies",
	);
});

test("before_agent_start: injects blocklist context when rules exist", async () => {
	writeGlobal({
		enabled: true,
		entries: [
			"rm -rf /",
			{ pattern: "kubectl delete", reason: "no cluster deletions" },
		],
	});
	writeProject(projectDir, {
		enabled: true,
		entries: ["git push --force"],
	});
	const harness = makeHarness();

	const result = await harness.runBeforeAgentStart();
	assert.ok(result);
	assert.equal(result.message.customType, "blocklist-context");
	assert.equal(result.message.display, false);
	const content = String(result.message.content);
	assert.match(content, /rm -rf \//);
	assert.match(content, /kubectl delete/);
	assert.match(content, /no cluster deletions/);
	assert.match(content, /git push --force/);
});

test("before_agent_start: returns nothing when no rules exist", async () => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	const harness = makeHarness();

	const result = await harness.runBeforeAgentStart();
	assert.equal(result, undefined);
});

test("context: dedup keeps only the latest blocklist-context message", async () => {
	const harness = makeHarness();
	const handler = harness.blocklistContextHandler();

	const messages = [
		{ customType: "blocklist-context", content: "old", display: false },
		{ customType: "modes-context", content: "unrelated", display: false },
		{ customType: "blocklist-context", content: "new", display: false },
	];
	const result = await handler({ type: "context", messages }, harness.ctx);
	assert.deepEqual(
		result.messages.map((m: { customType?: string }) => m.customType),
		["modes-context", "blocklist-context"],
	);
	assert.equal(result.messages[1].content, "new");
});

test("user_bash: disabled blocklist lets everything through", async () => {
	writeGlobal({ enabled: false, entries: ["npm run drop-db"] });
	const harness = makeHarness();
	await harness.setMode("auto");

	const result = await harness.runUserBash("npm run drop-db");
	assert.equal(result, undefined);
});
