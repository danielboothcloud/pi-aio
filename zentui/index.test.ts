import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerAioZentui } from "./index.ts";
import {
	AIO_UI_STATE_EVENT,
	ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT,
	ZENTUI_WORKING_LINE_SEGMENT_EVENT,
} from "./protocol.ts";

type Listener = (value: unknown) => void;
type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function makeHarness(options: { existing?: boolean; active?: boolean } = {}) {
	const listeners = new Map<string, Set<Listener>>();
	const handlers = new Map<string, LifecycleHandler[]>();
	const segments: Array<{ key: string; text?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	let registerCalls = 0;
	let active = options.active ?? true;

	const events = {
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
		on(channel: string, listener: Listener) {
			const channelListeners = listeners.get(channel) ?? new Set<Listener>();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
	};

	const installCapability = () => {
		events.on(ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT, (value) => {
			const capability = value as {
				supported: boolean;
				active: boolean;
				version?: number;
			};
			capability.supported = true;
			capability.active = active;
			capability.version = 1;
		});
	};
	if (options.existing) installCapability();
	events.on(ZENTUI_WORKING_LINE_SEGMENT_EVENT, (value) => {
		segments.push(value as { key: string; text?: string });
	});

	const pi = {
		events,
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const registerZentui = () => {
		registerCalls++;
		installCapability();
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			theme: { fg: (_role: string, text: string) => text },
		},
	} as ExtensionContext;
	const emitLifecycle = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
	};

	return {
		ctx,
		emitLifecycle,
		events,
		get registerCalls() {
			return registerCalls;
		},
		pi,
		registerZentui,
		segments,
		statuses,
		setActive(value: boolean) {
			active = value;
		},
	};
}

test("registerAioZentui loads bundled Zentui once and publishes AIO state", async () => {
	const harness = makeHarness();
	const result = registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
		getMode: () => "auto",
		getEffort: () => "xhigh",
	});

	assert.deepEqual(result, { bundled: true });
	assert.equal(harness.registerCalls, 1);
	await harness.emitLifecycle("session_start");
	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: "▶ Auto" },
		{ key: "aio:effort", text: "think:xhigh" },
	]);
});

test("registerAioZentui skips its bundled factory when Zentui already exists", () => {
	const harness = makeHarness({ existing: true });
	const result = registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
	});

	assert.deepEqual(result, { bundled: false });
	assert.equal(harness.registerCalls, 0);
});

test("working-line bridge follows live mode and effort updates", async () => {
	const harness = makeHarness();
	registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
		getMode: () => "default",
		getEffort: () => "medium",
	});
	await harness.emitLifecycle("session_start");

	harness.events.emit(AIO_UI_STATE_EVENT, { mode: "plan", effort: "high" });
	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: "⏸ Plan" },
		{ key: "aio:effort", text: "think:high" },
	]);
});

test("working-line bridge removes its segments when ownership is inactive", async () => {
	const harness = makeHarness({ active: false });
	registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
		getMode: () => "ask",
		getEffort: () => "low",
	});
	await harness.emitLifecycle("session_start");

	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: undefined },
		{ key: "aio:effort", text: undefined },
	]);

	harness.setActive(true);
	await harness.emitLifecycle("agent_start");
	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: "? Ask" },
		{ key: "aio:effort", text: "think:low" },
	]);
});

test("working-line bridge refreshes direct mode mutations at lifecycle boundaries", async () => {
	const harness = makeHarness();
	let mode: "plan" | "auto" = "plan";
	registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
		getMode: () => mode,
		getEffort: () => "high",
	});
	await harness.emitLifecycle("session_start");

	mode = "auto";
	await harness.emitLifecycle("agent_start");
	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: "▶ Auto" },
		{ key: "aio:effort", text: "think:high" },
	]);
});

test("bridge republishes startup statuses after Zentui installs interception", async () => {
	const harness = makeHarness();
	registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
		getMode: () => "ask",
		getEffort: () => "low",
	});
	await harness.emitLifecycle("session_start");

	assert.equal(harness.statuses.get("modes"), "? Ask");
	assert.equal(harness.statuses.get("effort"), "effort:low");
});

test("working-line bridge cleans up package-qualified segments on shutdown", async () => {
	const harness = makeHarness();
	registerAioZentui(harness.pi, {
		registerZentui: harness.registerZentui,
	});
	await harness.emitLifecycle("session_start");
	await harness.emitLifecycle("session_shutdown");

	assert.deepEqual(harness.segments.slice(-2), [
		{ key: "aio:permission-mode", text: undefined },
		{ key: "aio:effort", text: undefined },
	]);
});
