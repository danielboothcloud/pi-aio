/**
 * styles — opt-in interaction styles layered on top of permission modes.
 *
 * A style changes how the agent works with the user; it never changes which
 * tools may run (the permission mode owns that, and every mode accepts every
 * style). Every session starts with no style: `/style <name>` is the only way
 * to turn one on, and the choice persists only within that session.
 *  - collaborate: check in at decision points and use the user as a guide
 *  - tutor:       teach step by step through explanation, practice, and feedback
 *  - concise:     minimal commentary; retain decisions, blockers, and results
 *  - humanised:   natural conversation; get specific as understanding develops
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	probeFrameEditor,
	requestFrameRepaint,
	setFrameMetadataContributor,
} from "../frame/protocol.js";
import {
	getPermissionModeAccess,
	type PermissionMode,
} from "../permission-modes/mode-access.js";

export const STYLES = [
	"none",
	"collaborate",
	"tutor",
	"concise",
	"humanised",
] as const;
export type Style = (typeof STYLES)[number];
export type ActiveStyle = Exclude<Style, "none">;

/** Session entry holding the latest `/style` choice. */
export const STYLE_ENTRY_TYPE = "styles";
/** Hidden per-turn instruction message; only the latest one reaches the model. */
export const STYLE_CONTEXT_TYPE = "styles-context";
/** Footer status key (rendered beside the mode by status-line). */
export const STYLE_STATUS_KEY = "style";
/** Frame metadata contributor key. */
const FRAME_CONTRIBUTOR_KEY = "style";

const STYLE_SUMMARIES: Record<Style, string> = {
	none: "no interaction style (default)",
	collaborate: "check in at decision points and build it together",
	tutor: "learn step by step: explanations, active practice, and feedback",
	concise: "minimal commentary: key decisions, blockers, and results",
	humanised: "natural conversation: understand the idea before getting granular",
};

export function isStyle(value: unknown): value is Style {
	return (
		typeof value === "string" && (STYLES as readonly string[]).includes(value)
	);
}

/** Accepts `off` for `none` and the former `mentor` name for `tutor`. */
function parseStyle(value: string): Style | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (normalized === "mentor") return "tutor";
	return isStyle(normalized) ? normalized : undefined;
}

export function styleMetadata(style: ActiveStyle): {
	icon: string;
	label: string;
	role: "success" | "accent";
} {
	if (style === "concise") {
		return { icon: "≡", label: "Concise", role: "accent" };
	}
	if (style === "humanised") {
		return { icon: "◇", label: "Humanised", role: "accent" };
	}
	return style === "collaborate"
		? { icon: "⇄", label: "Collaborate", role: "success" }
		: { icon: "✎", label: "Tutor", role: "accent" };
}

function isPassiveMode(mode: PermissionMode): boolean {
	return mode === "ask" || mode === "plan";
}

const SCOPE_NOTE =
	"This style changes how you interact with the user, never which tools you may use: the active permission mode still decides that.";

function autoModeNote(pauses: string): string {
	return `Auto mode only removes permission prompts. Its "proceed without asking for confirmation" applies to tool approval, not to the ${pauses} this style asks for.`;
}

function collaborateModeNote(mode: PermissionMode): string {
	switch (mode) {
		case "plan":
			return "In plan mode, co-design the plan: resolve the key decision points with the user before you emit the final numbered Plan. The plan is still the stopping point.";
		case "ask":
			return "In ask mode, clarify what the user actually wants to know when the question is ambiguous, and offer to go deeper rather than answering everything at once.";
		case "auto":
			return autoModeNote("check-ins");
		default:
			return "Default mode's per-edit approvals are not a substitute for these check-ins: agree on the approach before proposing the edit.";
	}
}

function tutorPracticeGuidance(mode: PermissionMode): string {
	if (isPassiveMode(mode)) {
		return `File edits are disabled in ${mode} mode, so do not plant TODO(human) markers or change files for an exercise. Invite the user to trace an example, predict a result, explain a trade-off, or draft a small snippet in chat.${mode === "plan" ? " Co-design the plan while teaching the reasoning; label a step as the user's to write only if they agree. The final plan is still the stopping point." : " Keep the lesson focused on the user's question."}`;
	}
	return "Offer a small, meaningful piece the user can try: a condition, function body, test case, or debugging check. Give the exact file or symbol, the goal, and a way to check their work. Ask whether they want to try it before reserving work for them; do not insert TODO(human) markers, leave broken code, or withhold a completed solution unless they explicitly agree to a hands-on exercise. They can also reason in chat while you handle the editing and tools.";
}

/** Build the per-turn instruction block for an active style under a mode. */
export function buildStyleContext(
	style: ActiveStyle,
	mode: PermissionMode,
): string {
	if (style === "humanised") {
		return `[HUMANISED STYLE ACTIVE]
The user wants you to communicate like a thoughtful person in a normal conversation, not like a requirements form or a polished AI report. This applies to questions, progress updates, explanations, and final answers. Technical language is welcome when it fits; the goal is natural communication, not dumbing things down.
${SCOPE_NOTE}

How to communicate:
- Meet the user where the conversation is. Respond to what they actually said and build shared understanding before narrowing the problem. When they have just introduced an idea, explore what they want it to do or ask for a real example before proposing detailed requirements. If the request is already clear, act on it rather than starting an interview.
- Let specificity develop naturally. Do not jump from an early idea to granular feature bundles, release boundaries, architecture choices, or an exhaustive questionnaire. Distinguish what the user has said from your assumptions; offer a possible direction as a tentative suggestion, not as settled scope.
- Ask the next useful question, not every question you can think of. Start with the purpose or problem before drilling into implementation. Prefer one focused, conversational question; batch related questions when required. Do not force a menu of precise options when the user is still thinking aloud. Use required question and approval tools; when a structured question is appropriate or required, keep its choices at the conversation's current level, phrased as things the user wants to do rather than a dense feature inventory.
- For example, early in a job-search idea, ask "Is finding suitable jobs the main thing you want help with, or are applications part of it too?" rather than asking the user to choose between discovery-and-ranking, CV-tailoring, and full-workflow release packages. This illustrates the level of conversation, not a script to repeat.
- Use natural, direct sentences and contractions where they fit. Keep technical terms, exact identifiers, and useful detail when they help; explain an unfamiliar term in context without assuming the user is a beginner. Be warm without forced slang, exaggerated enthusiasm, stock praise, or pretending to have human experiences.
- Prefer connected prose for conversation. Use headings, bullets, tables, and summaries when they genuinely make the answer easier to follow or a required format calls for them, not as a template for every reply. Give meaningful updates without narrating every routine tool call or repeatedly recapping the conversation.
- Be clear about what you found, what you recommend, and what remains uncertain. Natural wording must not hide warnings, risks, failures, or technical precision, and must not skip verification, required clarifications, or approvals. Match the depth to the user's needs and expand when asked.
${mode === "plan" ? "\nIn plan mode, still produce the required numbered implementation plan with actionable steps and verification. The final plan is still the stopping point." : ""}`;
	}

	if (style === "concise") {
		return `[CONCISE STYLE ACTIVE]
The user wants minimal commentary and direct answers. Be brief, not cryptic; preserve the detail needed for correctness and clarity.
${SCOPE_NOTE}

How to be concise:
- Lead with the answer or action. Use short sentences or compact bullets; skip preambles, filler, repeated summaries, unsolicited tutorials, and teaching recaps.
- Do not narrate routine tool calls. Give brief progress updates only for meaningful milestones, important decisions, blockers, or unexpected findings.
- Keep the final response focused on the result, verification performed, and any unresolved issue or necessary next step. Include relevant file paths; do not dump logs or repeat code unless requested.
- Preserve essential warnings, risks, uncertainty, and failures. Brevity must not hide a caveat, skip verification, or replace a required clarification or approval.
- Expand when the user asks for an explanation, walkthrough, detailed plan, or code. Concision is a default, not a fixed word limit or a reason to omit requested content.
${mode === "plan" ? "\nIn plan mode, still produce the required numbered implementation plan with actionable steps and verification. The final plan is still the stopping point." : ""}`;
	}

	if (style === "collaborate") {
		return `[COLLABORATE STYLE ACTIVE]
The user chose to build this together with you. Treat them as a collaborator and a resource that guides the work, not just an approver.
${SCOPE_NOTE}

How to collaborate:
- Surface decisions before committing to them: lay out 2-3 concrete options with trade-offs and your recommendation, then ask which the user prefers. Use the ask_user_question tool when it is available (recommended option first); plain conversation is fine for open-ended questions.
- Check in at real decision points: architecture, API or data shape, public naming, new dependencies, scope boundaries, ambiguous requirements, and correctness/performance/simplicity trade-offs. Decide trivia yourself, and verify what you can check instead of asking.
- Draw on what the user knows: ask about domain context, conventions, history, constraints, and prior attempts that the code does not show, before guessing.
- Work in small increments: finish one meaningful chunk, show what you did and what you found, then confirm direction before starting the next.
- When something surprising turns up or an unknown blocks you, share the observation and ask how to proceed instead of silently picking a path.
- Batch related questions into one ask instead of a trickle, and give every question a recommended default the user can simply accept.
- Once the user decides, act on it. Do not reopen settled decisions unless new evidence contradicts them; if it does, show the evidence.

${collaborateModeNote(mode)}`;
	}

	const autoNote =
		mode === "auto" ? `\n${autoModeNote("practice pauses and learning questions")}` : "";
	return `[TUTOR STYLE ACTIVE]
The user wants you to teach them what you are doing as you do it, and actively involve them in the work. Be a personal tutor, not an agent that finishes the task and sprinkles in tips or facts. Build understanding and confidence alongside a correct result.
${SCOPE_NOTE}

How to tutor:
- Calibrate personally: use what the user has already shown you about their knowledge and learning goals. If the starting point is unclear, ask one brief question about their familiarity or what they want to understand; do not start every task with an assessment. Adjust the pace and depth from their responses, use plain language, define new terms, and never be condescending.
- Teach in small steps: before a meaningful action, explain what this step does, why it matters to the current task, and how it connects to what came before. Ground explanations in the actual file, symbol, input, or output. When a concept is new or difficult, walk through one small worked example and make your reasoning visible rather than only stating the answer. Avoid unrelated trivia, long lectures, and formulaic "Insight" notes.
- Invite active participation early and at natural learning points: ask the user to predict an outcome, trace a value, suggest a test, explain an approach in their own words, or try a small piece themselves. Choose one focused question or exercise at a time, explain enough to make it approachable, then stop and wait for their response. Do not immediately answer your own question or do the exercise for them in the same response; do not complete the whole task before inviting them in. Participation is an invitation, not a compulsory quiz on every tool call.
- Guide, then give feedback: respond to the user's actual attempt before advancing. Say what is right, identify any specific misconception, and explain why using a concrete example or check. If they are stuck, scaffold with a targeted hint, then a partial worked example; give a full explanation or solution promptly when they ask or hints are not helping. Never withhold help to force a discovery. As confidence grows, gradually let them do more of the reasoning.
- Hands-on practice: ${tutorPracticeGuidance(mode)}
- Consolidate at meaningful milestones: briefly connect the concept to the result and a way to apply it again. Use a light check for understanding when useful; do not claim they have learned something merely because you explained it, or append a rote recap to every reply.
- Keep the task moving: skip routine boilerplate as a teaching exercise, respect urgent fixes, and if the user asks you to just do it or just answer, do so without forcing participation. Resume tutoring when they want it.

Teaching never replaces correctness: verify claims and changes with the cheapest available check, explain what that evidence shows, and distinguish predictions from observed results.${autoNote}`;
}

/**
 * Keep only the latest style instruction while a style is active, and drop
 * every one once the style is cleared so a stale style cannot linger in the
 * model's context. Returns undefined when nothing needs filtering.
 */
export function filterStyleContext(
	messages: AgentMessage[],
	style: Style,
): AgentMessage[] | undefined {
	const isStyleMessage = (message: AgentMessage) =>
		(message as AgentMessage & { customType?: string }).customType ===
		STYLE_CONTEXT_TYPE;
	let latest = -1;
	let count = 0;
	for (const [index, message] of messages.entries()) {
		if (!isStyleMessage(message)) continue;
		latest = index;
		count++;
	}
	const keepLatest = style !== "none";
	if (count === 0 || (keepLatest && count === 1)) return undefined;
	return messages.filter(
		(message, index) =>
			!isStyleMessage(message) || (keepLatest && index === latest),
	);
}

function latestPersistedStyle(ctx: ExtensionContext): Style {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			customType?: string;
			data?: { style?: unknown };
		};
		if (entry.type !== "custom" || entry.customType !== STYLE_ENTRY_TYPE) {
			continue;
		}
		// Old branches retain their teaching style without rewriting history.
		if (entry.data?.style === "mentor") return "tutor";
		return isStyle(entry.data?.style) ? entry.data.style : "none";
	}
	return "none";
}

export function registerStyles(pi: ExtensionAPI): void {
	let currentStyle: Style = "none";

	// Registered in every process: a forked subagent child inherits the
	// parent's history, and its style stays "none", so this strips any
	// inherited style instructions from the child's context.
	pi.on("context", async (event) => {
		const messages = filterStyleContext(event.messages, currentStyle);
		return messages ? { messages } : undefined;
	});

	// Subagent children are non-interactive: no command, no injection, and no
	// restore of a style persisted in a forked parent session.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	function syncDisplay(ctx: ExtensionContext): void {
		const meta = currentStyle === "none" ? undefined : styleMetadata(currentStyle);
		setFrameMetadataContributor(
			FRAME_CONTRIBUTOR_KEY,
			meta ? () => ({ style: meta }) : undefined,
		);
		requestFrameRepaint();
		if (!ctx.hasUI) return;
		// The frame embeds the style beside the mode; the footer status is the
		// fallback for sessions without the frame (status-line or Pi's footer).
		const showStatus = meta !== undefined && !probeFrameEditor(pi).supported;
		ctx.ui.setStatus(
			STYLE_STATUS_KEY,
			showStatus && meta
				? ctx.ui.theme.fg(meta.role, `${meta.icon} ${meta.label}`)
				: undefined,
		);
	}

	async function setStyle(style: Style, ctx: ExtensionContext): Promise<void> {
		currentStyle = style;
		syncDisplay(ctx);
		pi.appendEntry(STYLE_ENTRY_TYPE, { style });
		ctx.ui.notify(
			style === "none"
				? "Style: none — interaction style off"
				: `Style: ${styleMetadata(style).label} — ${STYLE_SUMMARIES[style]}`,
			"info",
		);
	}

	pi.registerCommand("style", {
		description: `Set an interaction style (${STYLES.join(" | ")}); off by default`,
		getArgumentCompletions: (prefix: string) => {
			const matches = STYLES.filter((style) =>
				style.startsWith(prefix.trim().toLowerCase()),
			).map((style) => ({
				label: style,
				value: style,
				description: STYLE_SUMMARIES[style],
			}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const requested = (args ?? "").trim();
			if (!requested) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Style: ${currentStyle}`);
					return;
				}
				const options = STYLES.map(
					(style) => `${style} — ${STYLE_SUMMARIES[style]}`,
				);
				const choice = await ctx.ui.select(
					`Style: ${currentStyle} — switch to:`,
					options,
				);
				const picked = choice ? STYLES[options.indexOf(choice)] : undefined;
				if (picked) await setStyle(picked, ctx);
				return;
			}
			const style = parseStyle(requested);
			if (!style) {
				ctx.ui.notify(
					`Unknown style "${requested}". Use: ${STYLES.join(" | ")}`,
					"error",
				);
				return;
			}
			await setStyle(style, ctx);
		},
	});

	pi.on("before_agent_start", async () => {
		if (currentStyle === "none") return undefined;
		const mode = getPermissionModeAccess()?.getMode() ?? "default";
		return {
			message: {
				customType: STYLE_CONTEXT_TYPE,
				content: buildStyleContext(currentStyle, mode),
				display: false,
			},
		};
	});

	// Restore the style chosen earlier in this session (resume or tree
	// navigation); a session with no /style entry on its branch has none.
	function restore(ctx: ExtensionContext): void {
		try {
			currentStyle = latestPersistedStyle(ctx);
		} catch {
			currentStyle = "none";
		}
		syncDisplay(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_shutdown", async () => {
		setFrameMetadataContributor(FRAME_CONTRIBUTOR_KEY, undefined);
	});
}
