import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	contributedFrameMetadata,
	FRAME_CAPABILITY_EVENT,
	setFrameMetadataContributor,
} from "../frame/protocol.ts";
import {
	getPermissionModeAccess,
	setPermissionModeAccess,
} from "../permission-modes/mode-access.ts";
import {
	buildStyleContext,
	filterStyleContext,
	registerStyles,
	STYLE_CONTEXT_TYPE,
} from "./index.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any>;

function makeHarness(
	options: {
		branch?: unknown[];
		selections?: string[];
		frameSupported?: boolean;
	} = {},
) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, EventHandler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const selectOptions: string[][] = [];
	const selections = [...(options.selections ?? [])];

	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
		},
		events: {
			emit: (event: string, payload: { supported?: boolean }) => {
				if (event === FRAME_CAPABILITY_EVENT && options.frameSupported) {
					payload.supported = true;
				}
			},
		},
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: unknown) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
			select: async (_prompt: string, choices: string[]) => {
				selectOptions.push(choices);
				const next = selections.shift();
				return next ? choices.find((c) => c.startsWith(next)) : undefined;
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses.set(key, value);
			},
			theme: { fg: (_role: string, text: string) => text },
		},
	} as unknown as ExtensionCommandContext;

	registerStyles(pi);

	const emit = async (event: string, payload: unknown = {}) => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			result = (await handler(payload, ctx)) ?? result;
		}
		return result;
	};
	const runStyle = (args: string) => commands.get("style")?.handler(args, ctx);

	return {
		commands,
		emit,
		entries,
		handlers,
		notifications,
		runStyle,
		selectOptions,
		statuses,
	};
}

function styleMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: STYLE_CONTEXT_TYPE,
		content,
		display: false,
	} as unknown as AgentMessage;
}

const userMessage = { role: "user", content: "hi" } as unknown as AgentMessage;

test.afterEach(() => {
	setFrameMetadataContributor("style", undefined);
});

test("no style is active until /style is run", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");

	assert.equal(await harness.emit("before_agent_start"), undefined);
	assert.equal(harness.statuses.get("style"), undefined);
	assert.equal(contributedFrameMetadata().style, undefined);
	assert.deepEqual(harness.entries, []);
});

test("/style mentor injects teaching guidance and shows in the footer", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("Mentor");

	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "mentor" } },
	]);
	assert.equal(harness.statuses.get("style"), "✎ Mentor");
	assert.match(harness.notifications.at(-1)?.message ?? "", /^Style: Mentor/);

	const result = await harness.emit("before_agent_start");
	assert.equal(result.message.customType, STYLE_CONTEXT_TYPE);
	assert.equal(result.message.display, false);
	for (const cue of [
		/\[MENTOR STYLE ACTIVE\]/,
		/"Insight"/,
		/TODO\(human\)/,
		/guiding question/,
		/What you learned/,
		/never which tools you may use/,
	]) {
		assert.match(result.message.content, cue);
	}
});

test("/style with no argument offers a selector; off and none clear it", async () => {
	const harness = makeHarness({ selections: ["collaborate"] });
	await harness.emit("session_start");

	await harness.runStyle("");
	assert.deepEqual(
		harness.selectOptions[0]?.map((option) => option.split(" ")[0]),
		["none", "collaborate", "mentor"],
	);
	assert.equal(harness.statuses.get("style"), "⇄ Collaborate");
	const active = await harness.emit("before_agent_start");
	assert.match(active.message.content, /\[COLLABORATE STYLE ACTIVE\]/);
	assert.match(active.message.content, /ask_user_question/);

	await harness.runStyle("off");
	assert.equal(harness.statuses.get("style"), undefined);
	assert.equal(await harness.emit("before_agent_start"), undefined);
	assert.deepEqual(harness.entries.at(-1), {
		customType: "styles",
		data: { style: "none" },
	});
});

test("unknown styles are rejected without changing the active style", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("mentor");
	await harness.runStyle("teacher");

	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Use: none \| collaborate \| mentor/,
	);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[MENTOR STYLE ACTIVE\]/);
});

test("/style completes style names", () => {
	const harness = makeHarness();
	const complete = harness.commands.get("style").getArgumentCompletions;
	assert.deepEqual(
		complete("m").map((item: { value: string }) => item.value),
		["mentor"],
	);
	assert.equal(complete("zz"), null);
});

test("style guidance adapts to the active permission mode", async () => {
	const planMentor = buildStyleContext("mentor", "plan");
	assert.match(planMentor, /do not plant TODO\(human\) markers/);
	assert.match(planMentor, /mark such steps as the user's to write/);
	assert.doesNotMatch(planMentor, /Put a TODO\(human\) marker/);

	const autoMentor = buildStyleContext("mentor", "auto");
	assert.match(autoMentor, /Put a TODO\(human\) marker/);
	assert.match(autoMentor, /Auto mode only removes permission prompts/);

	assert.match(
		buildStyleContext("collaborate", "plan"),
		/co-design the plan/,
	);
	assert.match(
		buildStyleContext("collaborate", "auto"),
		/not to the check-ins this style asks for/,
	);
	assert.match(
		buildStyleContext("collaborate", "default"),
		/per-edit approvals are not a substitute/,
	);

	// End to end: the injection reads the live permission mode.
	const previous = getPermissionModeAccess();
	setPermissionModeAccess({ getMode: () => "plan", setMode: async () => {} });
	try {
		const harness = makeHarness();
		await harness.emit("session_start");
		await harness.runStyle("mentor");
		const result = await harness.emit("before_agent_start");
		assert.match(result.message.content, /disabled in plan mode/);
	} finally {
		setPermissionModeAccess(
			previous ?? { getMode: () => "default", setMode: async () => {} },
		);
	}
});

test("context keeps only the latest style instruction and drops all when off", async () => {
	const messages = [
		styleMessage("old"),
		userMessage,
		styleMessage("new"),
	];
	assert.deepEqual(
		filterStyleContext(messages, "mentor")?.map(
			(message) => (message as { content: unknown }).content,
		),
		["hi", "new"],
	);
	assert.deepEqual(filterStyleContext(messages, "none"), [userMessage]);
	assert.equal(filterStyleContext([userMessage], "none"), undefined);
	assert.equal(filterStyleContext([styleMessage("x")], "mentor"), undefined);

	// Through the handler: clearing the style strips earlier instructions.
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("mentor");
	await harness.runStyle("none");
	const filtered = await harness.emit("context", { messages });
	assert.deepEqual(filtered.messages, [userMessage]);
});

test("session restore brings back this session's style, otherwise none", async () => {
	const restored = makeHarness({
		branch: [
			{ type: "custom", customType: "styles", data: { style: "collaborate" } },
			{ type: "message", message: userMessage },
		],
	});
	await restored.emit("session_start");
	assert.equal(restored.statuses.get("style"), "⇄ Collaborate");
	const result = await restored.emit("before_agent_start");
	assert.match(result.message.content, /\[COLLABORATE STYLE ACTIVE\]/);

	const cleared = makeHarness({
		branch: [
			{ type: "custom", customType: "styles", data: { style: "mentor" } },
			{ type: "custom", customType: "styles", data: { style: "none" } },
		],
	});
	await cleared.emit("session_start");
	assert.equal(await cleared.emit("before_agent_start"), undefined);

	const corrupt = makeHarness({
		branch: [{ type: "custom", customType: "styles", data: { style: 42 } }],
	});
	await corrupt.emit("session_tree");
	assert.equal(await corrupt.emit("before_agent_start"), undefined);
});

test("with the frame installed the style renders in the frame, not the footer", async () => {
	const harness = makeHarness({ frameSupported: true });
	await harness.emit("session_start");
	await harness.runStyle("mentor");

	assert.deepEqual(contributedFrameMetadata().style, {
		icon: "✎",
		label: "Mentor",
		role: "accent",
	});
	assert.equal(harness.statuses.get("style"), undefined);

	await harness.runStyle("none");
	assert.equal(contributedFrameMetadata().style, undefined);
});

test("subagent children never get a style and strip inherited instructions", async () => {
	const previous = process.env.AIO_SUBAGENT_CHILD;
	process.env.AIO_SUBAGENT_CHILD = "1";
	try {
		const harness = makeHarness({
			branch: [
				{ type: "custom", customType: "styles", data: { style: "mentor" } },
			],
		});
		await harness.emit("session_start");

		assert.equal(harness.commands.has("style"), false);
		assert.equal(harness.handlers.has("before_agent_start"), false);
		const filtered = await harness.emit("context", {
			messages: [styleMessage("inherited"), userMessage],
		});
		assert.deepEqual(filtered.messages, [userMessage]);
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
	}
});
