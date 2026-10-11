/**
 * styles — opt-in interaction styles layered on top of permission modes.
 *
 * A style changes how the agent works with the user; it never changes which
 * tools may run (the permission mode owns that, and every mode accepts every
 * style). Every session starts with no style: `/style <name>` is the only way
 * to turn one on, and the choice persists only within that session.
 *  - collaborate: check in at decision points and use the user as a guide
 *  - mentor:      teach while working (insights, handoffs, Socratic prompts, recaps)
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

export const STYLES = ["none", "collaborate", "mentor"] as const;
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
	mentor: "teach while working: insights, handoffs, guiding questions, recaps",
};

export function isStyle(value: unknown): value is Style {
	return (
		typeof value === "string" && (STYLES as readonly string[]).includes(value)
	);
}

/** Accepts `off` as an alias for `none`; everything else must match exactly. */
function parseStyle(value: string): Style | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "off") return "none";
	return isStyle(normalized) ? normalized : undefined;
}

export function styleMetadata(style: ActiveStyle): {
	icon: string;
	label: string;
	role: "success" | "accent";
} {
	return style === "collaborate"
		? { icon: "⇄", label: "Collaborate", role: "success" }
		: { icon: "✎", label: "Mentor", role: "accent" };
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

function mentorHandoffGuidance(mode: PermissionMode): string {
	if (isPassiveMode(mode)) {
		return `File edits are disabled in ${mode} mode, so do not plant TODO(human) markers. Instead, when a piece of work is small, well-scoped, and instructive, name it as something the user could write themselves: where it goes, what it must do, and the hints they need.${mode === "plan" ? " In the plan, mark such steps as the user's to write." : ""} Offer at most one per response, and skip it when the user asks you to just answer.`;
	}
	return "When a piece of work is small, well-scoped, and instructive (a function body, a condition, a test case, a few lines that encode a design decision), leave it for the user. Put a TODO(human) marker at the exact location, explain what it must do, give the context and hints they need, then stop and wait. When they return, review their attempt constructively (what works, what to improve, and why) before continuing. Offer at most one handoff at a time. Skip handoffs for boilerplate, urgent fixes, or when the user asks you to just do it.";
}

/** Build the per-turn instruction block for an active style under a mode. */
export function buildStyleContext(
	style: ActiveStyle,
	mode: PermissionMode,
): string {
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
		mode === "auto" ? `\n${autoModeNote("handoffs and guiding questions")}` : "";
	return `[MENTOR STYLE ACTIVE]
The user wants to learn while you work. Leave them more capable, not just with a finished task.
${SCOPE_NOTE}

How to teach:
- Explain as you go: after each meaningful decision or change, add a short "Insight" note on the why (the concept, trade-off, idiom, or pitfall) and point to the relevant file, symbol, or documentation so the user can dig deeper. Keep insights specific to this codebase and task, not generic tutorials.
- Hands-on handoffs: ${mentorHandoffGuidance(mode)}
- Socratic prompts: at key reasoning points such as diagnosing a bug or choosing a design, first ask one guiding question (what they think is happening, or which approach they would pick and why) before revealing your answer. Give the answer promptly if they ask for it or seem stuck.
- Recap: end each response that completed meaningful work with a brief "What you learned" section of 1-3 transferable takeaways.

Calibrate to the user: match the depth of explanation to their apparent experience, skip what they clearly know, and never be condescending.
Teaching never replaces correctness: verify claims and changes with the cheapest available check instead of narrating why they should work.${autoNote}`;
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
