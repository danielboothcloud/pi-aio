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
		hasUI?: boolean;
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
		hasUI: options.hasUI ?? true,
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

test("/style tutor teaches through active practice and shows in the footer", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle(" Tutor ");

	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "tutor" } },
	]);
	assert.equal(harness.statuses.get("style"), "✎ Tutor");
	assert.match(harness.notifications.at(-1)?.message ?? "", /^Style: Tutor/);

	const result = await harness.emit("before_agent_start");
	assert.equal(result.message.customType, STYLE_CONTEXT_TYPE);
	assert.equal(result.message.display, false);
	for (const cue of [
		/\[TUTOR STYLE ACTIVE\]/,
		/learning goals/,
		/before a meaningful action, explain/,
		/small worked example/,
		/one focused question or exercise at a time/,
		/stop and wait for their response/,
		/Do not immediately answer your own question/,
		/do not complete the whole task before inviting them in/,
		/respond to the user's actual attempt before advancing/,
		/targeted hint, then a partial worked example/,
		/give a full explanation or solution promptly/,
		/gradually let them do more of the reasoning/,
		/do not insert TODO\(human\) markers/,
		/unless they explicitly agree to a hands-on exercise/,
		/not a compulsory quiz/,
		/just do it or just answer/,
		/do not claim they have learned something/,
		/verify claims and changes with the cheapest available check/,
		/never which tools you may use/,
	]) {
		assert.match(result.message.content, cue);
	}
});

test("/style concise persists the choice and injects brief but complete guidance", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle(" Concise ");

	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "concise" } },
	]);
	assert.equal(harness.statuses.get("style"), "≡ Concise");
	assert.match(harness.notifications.at(-1)?.message ?? "", /^Style: Concise/);
	const result = await harness.emit("before_agent_start");
	assert.equal(result.message.customType, STYLE_CONTEXT_TYPE);
	assert.equal(result.message.display, false);
	for (const cue of [
		/\[CONCISE STYLE ACTIVE\]/,
		/minimal commentary and direct answers/,
		/Do not narrate routine tool calls/,
		/meaningful milestones/,
		/result, verification performed/,
		/Preserve essential warnings, risks, uncertainty, and failures/,
		/required clarification or approval/,
		/Expand when the user asks/,
		/not a fixed word limit/,
		/never which tools you may use/,
	]) {
		assert.match(result.message.content, cue);
	}
	assert.doesNotMatch(result.message.content, /\[(TUTOR|COLLABORATE) STYLE ACTIVE\]/);
});

test("concise respects every permission mode and retains the plan contract", () => {
	for (const mode of ["ask", "plan", "default", "auto"] as const) {
		const context = buildStyleContext("concise", mode);
		assert.match(context, /active permission mode still decides/);
		assert.match(context, /Brevity must not hide a caveat, skip verification/);
		if (mode === "plan") {
			assert.match(context, /required numbered implementation plan/);
			assert.match(context, /actionable steps and verification/);
			assert.match(context, /final plan is still the stopping point/);
		} else {
			assert.doesNotMatch(context, /In plan mode/);
		}
	}
});

test("/style ste persists its canonical name and injects ASD-STE100 writing guidance", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle(" STE ");

	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "ste" } },
	]);
	assert.equal(harness.statuses.get("style"), "◇ Simplified Technical English");
	assert.match(harness.notifications.at(-1)?.message ?? "", /^Style: Simplified Technical English/);
	const result = await harness.emit("before_agent_start");
	assert.equal(result.message.customType, STYLE_CONTEXT_TYPE);
	assert.equal(result.message.display, false);
	for (const cue of [
		/\[STE STYLE ACTIVE\]/,
		/Simplified Technical English principles from ASD-STE100/,
		/questions, progress updates, explanations, final answers, and documentation/,
		/20 words per sentence in instructions and 25 words in descriptions/,
		/Do not omit the subject, verb, or articles/,
		/one instruction per sentence/,
		/imperative verb/,
		/condition before the instruction/,
		/numbered steps for procedures and vertical lists/,
		/Use the active voice/,
		/passive voice only when the agent is unknown/,
		/simple present, simple past, and simple future/,
		/past participle as an adjective/,
		/-ing form only as a technical noun/,
		/same term for the same thing/,
		/Avoid idioms, slang, figurative language, and contractions/,
		/no more than three words/,
		/one topic per paragraph and no more than six sentences/,
		/warning before the action/,
		/Keep code, commands, paths, API names, identifiers, literal values, and quoted source text exact/,
		/sentence limits apply to prose, not these literals/,
		/not a compliance checker/,
		/controlled dictionary, approved meanings and parts of speech/,
		/Do not claim that text is fully ASD-STE100 compliant without verification/,
		/never which tools you may use/,
	]) {
		assert.match(result.message.content, cue);
	}
	assert.doesNotMatch(result.message.content, /\[(HUMANISED|TUTOR|COLLABORATE|CONCISE) STYLE ACTIVE\]/);
});

test("ste respects every permission mode and keeps required plans and checks", () => {
	for (const mode of ["ask", "plan", "default", "auto"] as const) {
		const context = buildStyleContext("ste", mode);
		assert.match(context, /active permission mode still decides/);
		assert.match(context, /Preserve technical detail, warnings, risks, uncertainty, failures, and verification results/);
		assert.match(context, /Do not skip required questions, approval tools, checks, or response formats/);
		if (mode === "plan") {
			assert.match(context, /required numbered implementation plan/);
			assert.match(context, /actionable steps and verification/);
			assert.match(context, /final plan is still the stopping point/);
		} else {
			assert.doesNotMatch(context, /In plan mode/);
		}
	}
});

test("switching to and from ste keeps only current guidance; off clears it", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("collaborate");
	const collaborate = await harness.emit("before_agent_start");
	await harness.runStyle("ste");
	const ste = await harness.emit("before_agent_start");
	const messages = [
		styleMessage("[HUMANISED STYLE ACTIVE] old guidance"),
		styleMessage(collaborate.message.content),
		userMessage,
		styleMessage(ste.message.content),
	];
	assert.deepEqual((await harness.emit("context", { messages })).messages, [
		userMessage,
		messages[3],
	]);

	await harness.runStyle("concise");
	const concise = await harness.emit("before_agent_start");
	messages.push(styleMessage(concise.message.content));
	assert.deepEqual((await harness.emit("context", { messages })).messages, [
		userMessage,
		messages[4],
	]);

	await harness.runStyle("ste");
	await harness.runStyle("off");
	assert.equal(await harness.emit("before_agent_start"), undefined);
	assert.equal(harness.statuses.get("style"), undefined);
	assert.equal(contributedFrameMetadata().style, undefined);
	assert.deepEqual((await harness.emit("context", { messages })).messages, [userMessage]);
});

test("ste works without UI dialogs and humanised reports its canonical name", async () => {
	const harness = makeHarness({ hasUI: false });
	await harness.emit("session_start");
	await harness.runStyle("humanised");
	await harness.runStyle("");
	assert.equal(harness.notifications.at(-1)?.message, "Style: ste");
	assert.deepEqual(harness.selectOptions, []);
	assert.equal(harness.statuses.size, 0);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[STE STYLE ACTIVE\]/);
});

test("ste and legacy humanised entries restore without rewriting history", async () => {
	for (const style of ["ste", "humanised"]) {
		for (const event of ["session_start", "session_tree"]) {
			const harness = makeHarness({
				branch: [
					{ type: "custom", customType: "styles", data: { style: "tutor" } },
					{ type: "custom", customType: "styles", data: { style } },
				],
			});
			await harness.emit(event);
			assert.equal(harness.statuses.get("style"), "◇ Simplified Technical English");
			assert.deepEqual(harness.entries, []);
			const result = await harness.emit("before_agent_start");
			assert.match(result.message.content, /\[STE STYLE ACTIVE\]/);
			assert.doesNotMatch(result.message.content, /\[HUMANISED STYLE ACTIVE\]/);
		}
	}
});

test("the former humanised command persists only the canonical ste name", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle(" Humanised ");
	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "ste" } },
	]);
	assert.equal(harness.statuses.get("style"), "◇ Simplified Technical English");
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[STE STYLE ACTIVE\]/);
	assert.doesNotMatch(result.message.content, /\[HUMANISED STYLE ACTIVE\]/);
});

test("ste contributes its own frame label and cleans up on shutdown", async () => {
	const harness = makeHarness({ frameSupported: true });
	await harness.emit("session_start");
	await harness.runStyle("ste");
	assert.deepEqual(contributedFrameMetadata().style, {
		icon: "◇",
		label: "Simplified Technical English",
		role: "accent",
	});
	assert.equal(harness.statuses.get("style"), undefined);
	await harness.emit("session_shutdown");
	assert.equal(contributedFrameMetadata().style, undefined);
});

test("switching from tutor to concise replaces teaching guidance; off clears it", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("tutor");
	const tutor = await harness.emit("before_agent_start");
	await harness.runStyle("concise");
	const concise = await harness.emit("before_agent_start");
	const messages = [
		styleMessage(tutor.message.content),
		userMessage,
		styleMessage(concise.message.content),
	];
	const filtered = await harness.emit("context", { messages });
	assert.deepEqual(filtered.messages, [userMessage, messages[2]]);
	await harness.runStyle("off");
	assert.equal(await harness.emit("before_agent_start"), undefined);
	assert.equal(harness.statuses.get("style"), undefined);
	const cleared = await harness.emit("context", { messages });
	assert.deepEqual(cleared.messages, [userMessage]);
});

test("concise works without UI dialogs", async () => {
	const harness = makeHarness({ hasUI: false });
	await harness.emit("session_start");
	await harness.runStyle("concise");
	await harness.runStyle("");
	assert.equal(harness.notifications.at(-1)?.message, "Style: concise");
	assert.deepEqual(harness.selectOptions, []);
	assert.equal(harness.statuses.size, 0);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[CONCISE STYLE ACTIVE\]/);
});

test("the former mentor command is an alias that persists the canonical tutor name", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle(" Mentor ");

	assert.deepEqual(harness.entries, [
		{ customType: "styles", data: { style: "tutor" } },
	]);
	assert.equal(harness.statuses.get("style"), "✎ Tutor");
	assert.match(harness.notifications.at(-1)?.message ?? "", /^Style: Tutor/);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[TUTOR STYLE ACTIVE\]/);
	assert.doesNotMatch(result.message.content, /\[MENTOR STYLE ACTIVE\]/);
});

test("/style with no argument offers a selector; off and none clear it", async () => {
	const harness = makeHarness({ selections: ["collaborate"] });
	await harness.emit("session_start");

	await harness.runStyle("");
	assert.deepEqual(
		harness.selectOptions[0]?.map((option) => option.split(" ")[0]),
		["none", "collaborate", "tutor", "concise", "ste"],
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

test("tutor, concise, and ste can be selected from the menu", async () => {
	for (const [style, status] of [
		["tutor", "✎ Tutor"],
		["concise", "≡ Concise"],
		["ste", "◇ Simplified Technical English"],
	] as const) {
		const harness = makeHarness({ selections: [style] });
		await harness.emit("session_start");
		await harness.runStyle("");
		assert.equal(harness.statuses.get("style"), status);
		assert.deepEqual(harness.entries.at(-1), {
			customType: "styles",
			data: { style },
		});
	}
});

test("tutor works without a UI and /style reports the canonical name", async () => {
	const harness = makeHarness({ hasUI: false });
	await harness.emit("session_start");
	await harness.runStyle("mentor");
	await harness.runStyle("");
	assert.equal(harness.notifications.at(-1)?.message, "Style: tutor");
	assert.deepEqual(harness.selectOptions, []);
	assert.equal(harness.statuses.size, 0);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[TUTOR STYLE ACTIVE\]/);
});

test("unknown styles are rejected without changing the active style", async () => {
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("tutor");
	await harness.runStyle("teacher");

	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Use: none \| collaborate \| tutor \| concise \| ste/,
	);
	const result = await harness.emit("before_agent_start");
	assert.match(result.message.content, /\[TUTOR STYLE ACTIVE\]/);
});

test("/style completes canonical style names", () => {
	const harness = makeHarness();
	const command = harness.commands.get("style");
	const complete = command.getArgumentCompletions;
	assert.match(command.description, /none \| collaborate \| tutor \| concise \| ste/);
	assert.deepEqual(
		complete(" T ").map((item: { value: string }) => item.value),
		["tutor"],
	);
	assert.deepEqual(
		complete("").map((item: { value: string }) => item.value),
		["none", "collaborate", "tutor", "concise", "ste"],
	);
	assert.deepEqual(
		complete("co").map((item: { value: string }) => item.value),
		["collaborate", "concise"],
	);
	assert.deepEqual(
		complete("con").map((item: { value: string }) => item.value),
		["concise"],
	);
	assert.deepEqual(complete(" S "), [
		{
			label: "ste",
			value: "ste",
			description: "Simplified Technical English: clear, direct wording based on ASD-STE100",
		},
	]);
	assert.equal(complete("h"), null, "legacy humanised alias is not advertised");
	assert.equal(complete("m"), null, "legacy mentor alias is not advertised");
	assert.equal(complete("zz"), null);
});

test("style guidance adapts to the active permission mode", async () => {
	for (const mode of ["ask", "plan"] as const) {
		const context = buildStyleContext("tutor", mode);
		assert.match(context, new RegExp(`File edits are disabled in ${mode} mode`));
		assert.match(context, /do not plant TODO\(human\) markers or change files/);
		assert.match(context, /draft a small snippet in chat/);
		assert.doesNotMatch(context, /unless they explicitly agree to a hands-on exercise/);
	}
	const planTutor = buildStyleContext("tutor", "plan");
	assert.match(planTutor, /user's to write only if they agree/);
	assert.match(planTutor, /final plan is still the stopping point/);

	for (const mode of ["default", "auto"] as const) {
		const context = buildStyleContext("tutor", mode);
		assert.match(context, /Ask whether they want to try it before reserving work/);
		assert.match(context, /do not insert TODO\(human\) markers, leave broken code/);
		assert.match(context, /unless they explicitly agree to a hands-on exercise/);
	}
	const autoTutor = buildStyleContext("tutor", "auto");
	assert.match(autoTutor, /Auto mode only removes permission prompts/);
	assert.match(autoTutor, /not to the practice pauses and learning questions/);

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
		await harness.runStyle("tutor");
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
		styleMessage("[MENTOR STYLE ACTIVE] old"),
		userMessage,
		styleMessage("[TUTOR STYLE ACTIVE] new"),
	];
	assert.deepEqual(
		filterStyleContext(messages, "tutor")?.map(
			(message) => (message as { content: unknown }).content,
		),
		["hi", "[TUTOR STYLE ACTIVE] new"],
	);
	assert.deepEqual(filterStyleContext(messages, "none"), [userMessage]);
	assert.equal(filterStyleContext([userMessage], "none"), undefined);
	assert.equal(filterStyleContext([styleMessage("x")], "tutor"), undefined);

	// Through the handler: clearing the style strips earlier instructions.
	const harness = makeHarness();
	await harness.emit("session_start");
	await harness.runStyle("tutor");
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
			{ type: "custom", customType: "styles", data: { style: "tutor" } },
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

test("tutor and legacy mentor entries restore as tutor on resume and tree navigation", async () => {
	for (const style of ["tutor", "mentor"]) {
		for (const event of ["session_start", "session_tree"]) {
			const harness = makeHarness({
				branch: [
					{ type: "custom", customType: "styles", data: { style: "collaborate" } },
					{ type: "custom", customType: "styles", data: { style } },
				],
			});
			await harness.emit(event);
			assert.equal(harness.statuses.get("style"), "✎ Tutor");
			assert.deepEqual(harness.entries, [], "restore must not rewrite session history");
			const result = await harness.emit("before_agent_start");
			assert.match(result.message.content, /\[TUTOR STYLE ACTIVE\]/);
		}
	}
});

test("concise restores on resume and tree navigation without rewriting history", async () => {
	for (const event of ["session_start", "session_tree"]) {
		const harness = makeHarness({
			branch: [
				{ type: "custom", customType: "styles", data: { style: "tutor" } },
				{ type: "custom", customType: "styles", data: { style: "concise" } },
			],
		});
		await harness.emit(event);
		assert.equal(harness.statuses.get("style"), "≡ Concise");
		assert.deepEqual(harness.entries, []);
		const result = await harness.emit("before_agent_start");
		assert.match(result.message.content, /\[CONCISE STYLE ACTIVE\]/);
	}
});

test("concise contributes its own frame label and cleans up on shutdown", async () => {
	const harness = makeHarness({ frameSupported: true });
	await harness.emit("session_start");
	await harness.runStyle("concise");
	assert.deepEqual(contributedFrameMetadata().style, {
		icon: "≡",
		label: "Concise",
		role: "accent",
	});
	assert.equal(harness.statuses.get("style"), undefined);
	await harness.emit("session_shutdown");
	assert.equal(contributedFrameMetadata().style, undefined);
});

test("a later off or invalid entry overrides a legacy style choice", async () => {
	for (const legacy of ["mentor", "humanised"]) {
		for (const style of ["none", 42]) {
			const harness = makeHarness({
				branch: [
					{ type: "custom", customType: "styles", data: { style: legacy } },
					{ type: "custom", customType: "styles", data: { style } },
				],
			});
			await harness.emit("session_tree");
			assert.equal(await harness.emit("before_agent_start"), undefined);
		}
	}
});

test("with the frame installed the style renders in the frame, not the footer", async () => {
	const harness = makeHarness({ frameSupported: true });
	await harness.emit("session_start");
	await harness.runStyle("tutor");

	assert.deepEqual(contributedFrameMetadata().style, {
		icon: "✎",
		label: "Tutor",
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
				{ type: "custom", customType: "styles", data: { style: "humanised" } },
				{ type: "custom", customType: "styles", data: { style: "ste" } },
			],
		});
		await harness.emit("session_start");

		assert.equal(harness.commands.has("style"), false);
		assert.equal(harness.handlers.has("before_agent_start"), false);
		const filtered = await harness.emit("context", {
			messages: [
				styleMessage("[TUTOR STYLE ACTIVE] inherited"),
				styleMessage("[CONCISE STYLE ACTIVE] inherited"),
				styleMessage("[HUMANISED STYLE ACTIVE] inherited"),
				styleMessage("[STE STYLE ACTIVE] inherited"),
				userMessage,
			],
		});
		assert.deepEqual(filtered.messages, [userMessage]);
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
	}
});
