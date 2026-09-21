// Prompt-surface support: the before_agent_start handler injects a short
// hook-awareness note (disable with PI_YAML_HOOKS_PROMPT_AWARENESS=0) and
// same-turn system context from user.prompt.submit hooks. Fail-open: prompt
// hook failures never block the agent turn. Ported from pi-yaml-hooks (MIT).

import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV, isEnvDisabled } from "./env.js";
import { resolveHookConfigPaths } from "./paths.js";
import { summarizeHookSources, loadDiscoveredHooks, type HookLoadSnapshot } from "./discovery.js";
import type { HooksRuntime } from "./runtime.js";
import type { RuntimeRegistry } from "./registry.js";
import { safeGetSessionId } from "./host-adapter.js";

const PROMPT_AWARENESS_DISABLE_ENV = "PI_YAML_HOOKS_PROMPT_AWARENESS";
const PROMPT_CONTEXT_PREFIX = "Context from aio yaml hooks user.prompt.submit:";

export function registerPromptSupport(
	pi: ExtensionAPI,
	runtimeRegistry: RuntimeRegistry | undefined,
): void {
	pi.on("before_agent_start", (event, ctx) => handleBeforeAgentStart(event, ctx, runtimeRegistry));
}

async function handleBeforeAgentStart(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	runtimeRegistry: RuntimeRegistry | undefined,
): Promise<BeforeAgentStartEventResult | undefined> {
	const blocks = await buildPromptBlocks(event.prompt, ctx, runtimeRegistry);
	if (blocks === undefined) {
		// Fail-open: a prompt-hook dispatch failure never blocks the turn.
		return { systemPrompt: event.systemPrompt };
	}
	if (blocks.length === 0) return undefined;

	return {
		systemPrompt: [event.systemPrompt.trimEnd(), ...blocks].join("\n\n"),
	};
}

async function buildPromptBlocks(
	prompt: string,
	ctx: ExtensionContext,
	runtimeRegistry: RuntimeRegistry | undefined,
): Promise<readonly string[] | undefined> {
	let sessionID: string | undefined;
	try {
		const awareness = buildHookAwarenessSystemPrompt(ctx);
		if (!runtimeRegistry) {
			return awareness ? [awareness] : [];
		}

		runtimeRegistry.rememberContext(ctx.cwd, ctx);
		sessionID = safeGetSessionId(ctx.sessionManager);
		if (!sessionID) {
			reportPromptDispatchFailure(ctx.cwd, undefined, "missing_session");
			return undefined;
		}

		const result = await runtimeRegistry.getRuntimeFor(ctx.cwd)["user.prompt.submit"]({
			sessionID,
			prompt,
		});
		const contextBlocks = result.additionalContext.map((text) => `${PROMPT_CONTEXT_PREFIX}\n${text}`);
		return awareness ? [awareness, ...contextBlocks] : contextBlocks;
	} catch (error) {
		let failureType = "unknown";
		if (error instanceof Error) {
			failureType = error.name;
		} else if (error !== null && error !== undefined) {
			const constructor = (error as { constructor?: { name?: string } }).constructor;
			failureType = constructor?.name ?? "unknown";
		}
		reportPromptDispatchFailure(ctx.cwd, sessionID, failureType);
		return undefined;
	}
}

function reportPromptDispatchFailure(
	cwd: string,
	sessionID: string | undefined,
	failureType: string,
): void {
	// eslint-disable-next-line no-console
	console.error("[aio yaml hooks] Prompt submission hooks failed; continuing without injected context.");
	void cwd;
	void sessionID;
	void failureType;
}

// Accept a small set of common "off" spellings so users do not have to
// remember a single canonical form.
function isPromptAwarenessDisabled(): boolean {
	return isEnvDisabled(PROMPT_AWARENESS_DISABLE_ENV);
}

export function buildHookAwarenessSystemPrompt(ctx: Pick<ExtensionContext, "cwd" | "hasUI">): string | undefined {
	if (isPromptAwarenessDisabled()) {
		return undefined;
	}

	const loaded: HookLoadSnapshot = loadDiscoveredHooks({ projectDir: ctx.cwd });
	const summary = summarizeHookSources(loaded.sources);
	const paths = resolveHookConfigPaths();
	const globalPath = paths.global ?? "none";

	const lines = [
		"Hook-awareness for this session (aio yaml hooks):",
		`- active hook config (global): ${globalPath}`,
		paths.project
			? `- project hook config: ${paths.project} (trusted and active when loaded)`
			: "- no project hook file is present for this repo/worktree scope",
	];

	if (loaded.errors.length > 0) {
		lines.push(`- current hook files have ${loaded.errors.length} validation issue(s); use /hooks-validate for the exact errors`);
	} else {
		lines.push(`- loaded ${summary.total} hooks (${summary.global} global, ${summary.project} project)`);
	}

	lines.push("- command actions are unsupported; prefer bash-backed hooks");
	lines.push("- tool actions inject a follow-up prompt into the current session only; they cannot target other sessions");
	lines.push(`- synchronous bash hooks inherit a ${optionsBudgetSeconds()}s per-turn budget via PI_YAML_HOOKS_* env (see docs)`);
	void ENV;

	if (!ctx.hasUI) {
		lines.push("- UI is unavailable in this mode: notify/setStatus degrade and confirm denies by default");
	}

	return lines.join("\n");
}

function optionsBudgetSeconds(): number {
	// Mirror the default prompt-hook bash budget documented in the reference.
	return 60;
}
