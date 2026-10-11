/* pi-pretty: bash tool -- command execution with styled output. */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	bashGrepGuardEnabled,
	resolveBaseBackground,
	TOOL_RESULT_INDENT,
	termWidth,
} from "../config.js";
import { findGnuGrepInvocation } from "../grep-guard.js";
import {
	compactErrorLines,
	inferBashExitCode,
	stripBashExitStatusLine,
} from "../helpers.js";
import {
	fillToolBackground,
	plural,
	renderToolCallChrome,
	renderToolDuration,
	renderToolError,
	renderToolSummary,
} from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type {
	BashDetails,
	ComponentLike,
	RenderCtxLike,
	SdkToolDef,
	TextContent,
	ThemeLike,
} from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

type ResponsiveBashState = {
	baseRender: (width: number) => string[];
	renderText: (width: number) => string;
};

const responsiveBashStates = new WeakMap<object, ResponsiveBashState>();

function installResponsiveBashRender(
	text: ComponentLike,
	renderText: (width: number) => string,
): void {
	let state = responsiveBashStates.get(text);
	if (!state) {
		state = {
			baseRender: text.render.bind(text),
			renderText,
		};
		responsiveBashStates.set(text, state);
		text.render = (width: number): string[] => {
			const current = responsiveBashStates.get(text);
			if (!current) return [];
			const fittedWidth = Math.max(1, Math.floor(width || termWidth()));
			text.setText(current.renderText(fittedWidth));
			return current.baseRender(fittedWidth);
		};
	}
	state.renderText = renderText;
}

export function registerBashTool(
	pi: ExtensionAPI,
	_cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (
		t?: string,
		x?: number,
		y?: number,
	) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);

	// SAFETY: the definition mirrors the SDK builtin bash's runtime shape — its own
	// parameters schema and execute contract — plus duck-typed renderCall/renderResult
	// extensions Pi accepts at runtime but ToolDefinition's generics cannot express.
	// Two deliberate widenings inside: the cached Text component carries a host-specific
	// `render(w)` member the SDK d.ts does not declare, and the literal is widened
	// once at its end (both covered by pretty-tools bash tests).
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: sdkTool.description
			? `${sdkTool.description} For text search: \`rg -n\`.`
			: "Execute shell commands. For text search: `rg -n`.",
		promptSnippet: "Execute commands via bash. For text search: `rg -n`.",
		promptGuidelines: [
			"For text search: `rg -n`. If no results, try `rg -u` (respects .gitignore by default).",
			"In rg: | means alternation, \\| means literal pipe. Opposite of GNU grep. Never use \\| for alternation.",
			"GNU grep (grep/egrep/fgrep) is blocked in bash; use the grep tool or `rg -n` instead.",
		],
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(
			async (tid, params, sig, _upd, ctx: ExtensionContext) => {
				const command = String((params as any).command ?? "");
				const gnuGrep = bashGrepGuardEnabled()
					? findGnuGrepInvocation(command)
					: undefined;
				if (gnuGrep) {
					const msg = [
						`Blocked GNU grep invocation: \`${gnuGrep}\`. Use the grep tool instead — it runs ripgrep (rg).`,
						`If you need shell search, run: rg -n "pattern"`,
						`Set PRETTY_BASH_GREP_GUARD=0 to disable this guard.`,
					].join("\n");
					return {
						content: [{ type: "text" as const, text: msg }],
						isError: true,
						details: {
							_type: "bashResult",
							text: msg,
							exitCode: 1,
							command,
						} as BashDetails,
					};
				}
				try {
					return (await sdkTool.execute(
						tid,
						params,
						sig,
						undefined,
						ctx,
					)) as Result;
				} catch (error: unknown) {
					const msg = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text" as const, text: msg }],
						isError: true,
						details: {
							_type: "bashResult",
							text: msg,
							exitCode: 1,
							command: String((params as any).command ?? ""),
						} as BashDetails,
					};
				}
			},
		),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TC("", 0, 0);
			const timeout =
				typeof args.timeout === "number"
					? `timeout ${args.timeout}s`
					: undefined;
			const tw = termWidth() || 80;
			const rawCmd = String(args.command ?? "");
			const headerBudget = ctx.expanded ? tw : Math.max(8, tw - 20);
			const cmd =
				rawCmd.length === 0
					? "..."
					: !ctx.expanded && rawCmd.length > headerBudget
						? `${rawCmd.slice(0, Math.max(1, headerBudget))}…`
						: rawCmd;
			const call = renderToolCallChrome(
				theme,
				"bash",
				[cmd, timeout].filter(Boolean).join(" · "),
				{
					icon: "$",
					tone: ctx.isError ? "error" : "accent",
					width: tw,
				},
			);
			text.setText(fillToolBackground(`\n${call}\n`, undefined, tw));
			return text;
		},

		renderResult(
			result: Result,
			_opt: unknown,
			theme: ThemeLike,
			ctx: RenderCtxLike,
		) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);

			const details = result.details;
			const tc = getText(result);
			const d: BashDetails | undefined =
				(details as BashDetails)?._type === "bashResult"
					? (details as BashDetails)
					: tc || ctx.isError
						? {
								_type: "bashResult",
								text: tc || "Error",
								exitCode: inferBashExitCode(tc, ctx.isError ? 1 : 0),
								command: "",
							}
						: undefined;

			if (d?._type === "bashResult") {
				const isErr = ctx.isError || (d.exitCode !== null && d.exitCode !== 0);
				const cleaned = stripBashExitStatusLine(d.text);
				const output = isErr ? compactErrorLines(cleaned).join("\n") : cleaned;
				const lineCount = output.split("\n").length;
				const exitCode = d.exitCode ?? (isErr ? 1 : 0);
				const rw = termWidth();

				const renderFn = (w: number) => {
					const header = renderToolSummary(
						theme,
						`exit ${exitCode}`,
						[plural(lineCount, "line"), renderToolDuration(result)],
						{
							tone: isErr ? "error" : "success",
							marker: isErr ? "✕" : "✓",
							hint: !ctx.expanded ? "ctrl+o expand" : undefined,
							width: w,
						},
					);
					if (!ctx.expanded)
						return fillToolBackground(`${header}\n`, undefined, w);
					if (!output.trim())
						return fillToolBackground(`${header}\n`, undefined, w);
					const show = output.split("\n");
					const out = [
						header,
						"",
						...show.map((line: string) => `${TOOL_RESULT_INDENT}${line}`),
					];
					return fillToolBackground(`${out.join("\n")}\n`, undefined, w);
				};

				text.setText(renderFn(rw));
				installResponsiveBashRender(text as ComponentLike, renderFn);
				return text;
			}

			if (ctx.isError) {
				text.setText(renderToolError(tc || "Error", theme));
				return text;
			}
			const fc = result.content?.[0];
			text.setText(
				fillToolBackground(
					`${TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
				),
			);
			return text;
		},
	} as unknown as ToolDefinition<any, any, any>);
}

function getText(result: Result): string {
	return (
		((result.content ?? []) as TextContent[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? ""
	);
}
