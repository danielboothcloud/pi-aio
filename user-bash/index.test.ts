import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBlocklist } from "../blocklist/index.ts";
import { registerPermissionModes } from "../permission-modes/index.ts";
import { getPermissionModeAccess, setPermissionModeAccess } from "../permission-modes/mode-access.ts";
import { registerRtk } from "../rtk/index.ts";
import registerYamlHooks from "../yaml-hooks/index.ts";
import { ENV } from "../yaml-hooks/env.ts";
import { registerUserBash } from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness(mode = "tui", existingEditor = false) {
	const handlers = new Map<string, Handler[]>();
	const editors: unknown[] = [];
	const pi = new Proxy({
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getActiveTools: () => ["read", "bash", "write"],
	}, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ExtensionAPI;
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: {
			getEditorComponent: () => existingEditor ? (() => {}) : undefined,
			setEditorComponent: (editor: unknown) => editors.push(editor),
			setWidget: () => {},
			setStatus: () => {},
			select: () => assert.fail("typed commands must not prompt"),
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, handlers, editors };
}

test("all AIO user-command interceptors are absent even with legacy hooks enabled", (t) => {
	const previous = process.env.PI_YAML_HOOKS_ENABLE_USER_BASH;
	const access = getPermissionModeAccess();
	try {
		process.env.PI_YAML_HOOKS_ENABLE_USER_BASH = "1";
		const stderr = t.mock.method(process.stderr, "write", () => true);
		const h = harness();
		registerBlocklist(h.pi);
		registerPermissionModes(h.pi);
		registerUserBash(h.pi);
		registerRtk(h.pi);
		registerYamlHooks(h.pi);
		assert.equal(h.handlers.has("user_bash"), false, "Pi must execute ! and !! directly");
		assert.ok((h.handlers.get("tool_call")?.length ?? 0) >= 4, "agent gates and rewriting remain");
		assert.equal(ENV.enableUserBash(), false);
		assert.equal(stderr.mock.calls.some((call) => String(call.arguments[0]).includes("ENABLE_USER_BASH")), false);
	} finally {
		// Restore the singleton even when it was uninitialized before registration.
		setPermissionModeAccess(access);
		if (previous === undefined) delete process.env.PI_YAML_HOOKS_ENABLE_USER_BASH;
		else process.env.PI_YAML_HOOKS_ENABLE_USER_BASH = previous;
	}
});

test("installs the bash-hint editor in TUI without taking over an existing editor", () => {
	for (const existing of [false, true]) {
		const h = harness("tui", existing);
		registerUserBash(h.pi);
		for (const handler of h.handlers.get("session_start") ?? []) handler({}, h.ctx);
		assert.equal(h.editors.length, existing ? 0 : 1);
	}
});

test("does not install an editor outside TUI", () => {
	const h = harness("rpc");
	registerUserBash(h.pi);
	for (const handler of h.handlers.get("session_start") ?? []) handler({}, h.ctx);
	assert.deepEqual(h.editors, []);
});

test("shutdown clears the hint editor", () => {
	const h = harness();
	registerUserBash(h.pi);
	for (const handler of h.handlers.get("session_shutdown") ?? []) handler({}, h.ctx);
	assert.deepEqual(h.editors, [undefined]);
});
