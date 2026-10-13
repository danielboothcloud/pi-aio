/**
 * btw — isolated side-question engine.
 *
 * One bounded model call through an injected registry-complete seam (the same
 * CompleteFn contract you-should-know's shadow auditor uses). Never throws:
 * infrastructure failures come back as `error` on the outcome so the /btw
 * command can surface a warning toast instead of breaking the prompt cycle it
 * runs inside. No Pi host imports — tests inject the complete seam directly.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { BTW_SYSTEM_PROMPT } from "./context.js";

/** Shape of ctx.modelRegistry.complete() narrowed to what the engine uses. */
export type BtwCompleteFn = (
	model: unknown,
	context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options?: { signal?: AbortSignal },
) => Promise<{
	content: Array<Record<string, unknown>>;
	stopReason: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
}>;

export interface BtwUsage {
	inputTokens: number;
	outputTokens: number;
	costTotal: number;
}

export interface SideQuestionOutcome {
	answer: string;
	usage?: BtwUsage;
	/** Wall-clock duration of the full side call. */
	latencyMs: number;
	/** Infrastructure error (stream failure, empty reply); never a verdict. */
	error?: string;
}

export const MAX_ANSWER_CHARS = 2400;
const MAX_ERROR_CHARS = 200;

/** Strips ANSI/control sequences and caps length before terminal display. */
export function sanitizeForTerminal(text: unknown, max: number): string {
	if (typeof text !== "string") return "";
	const stripped = stripTerminalSequences(text)
		.split("\n")
		.map((line) =>
			line
				.split("")
				.filter((ch) => {
					// Keep tab and printable characters; every remaining control
					// code (carriage returns included) is dropped.
					const code = ch.charCodeAt(0);
					return code === 9 || (code >= 32 && code !== 127);
				})
				.join(""),
		)
		.join("\n")
		.trimEnd();
	return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** Extracts text blocks from an assistant content array. */
export function textFromContent(content: Array<Record<string, unknown>> | undefined): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function toUsage(usage: { input?: number; output?: number; cost?: { total?: number } } | undefined): BtwUsage | undefined {
	if (!usage) return undefined;
	return {
		inputTokens: usage.input ?? 0,
		outputTokens: usage.output ?? 0,
		costTotal: usage.cost?.total ?? 0,
	};
}

/**
 * Runs one isolated side question. Never throws: failures come back as
 * `error` so the caller toasts a warning instead of throwing mid-prompt.
 */
export async function runSideQuestion(options: {
	model: unknown;
	prompt: string;
	complete: BtwCompleteFn;
	signal?: AbortSignal;
}): Promise<SideQuestionOutcome> {
	const startedAt = Date.now();
	try {
		const response = await options.complete(
			options.model,
			{
				systemPrompt: BTW_SYSTEM_PROMPT,
				messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
			},
			{ signal: options.signal },
		);

		if (options.signal?.aborted) {
			return { answer: "", latencyMs: Date.now() - startedAt, error: "aborted" };
		}

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return {
				answer: "",
				usage: toUsage(response.usage),
				latencyMs: Date.now() - startedAt,
				error:
					response.stopReason === "error"
						? sanitizeForTerminal(response.errorMessage ?? "the side call failed", MAX_ERROR_CHARS)
						: "aborted",
			};
		}

		const answer = sanitizeForTerminal(textFromContent(response.content), MAX_ANSWER_CHARS);
		if (!answer.trim()) {
			return {
				answer: "",
				usage: toUsage(response.usage),
				latencyMs: Date.now() - startedAt,
				error: "the model returned an empty answer",
			};
		}
		return {
			answer,
			usage: toUsage(response.usage),
			latencyMs: Date.now() - startedAt,
		};
	} catch (error) {
		const message = sanitizeForTerminal(
			error instanceof Error ? error.message : String(error),
			MAX_ERROR_CHARS,
		);
		return {
			answer: "",
			latencyMs: Date.now() - startedAt,
			error: message || "the side call failed",
		};
	}
}
