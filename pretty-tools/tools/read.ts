/* pi-pretty: read tool -- file reading with syntax highlighting and inline image support. */

import { basename, dirname } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	executeRtkTool,
	requireRtkSuccess,
	truncateRtkOutput,
} from "../../rtk/tool-routing.js";
import {
	BG_BASE,
	BG_ERROR,
	FG_DIM,
	FG_LNUM,
	FG_RULE,
	RST,
	resolveBaseBackground,
	TOOL_RESULT_INDENT,
	termWidth,
} from "../config.js";
import { normalizeLineEndings, shortPath } from "../helpers.js";
import {
	fillToolBackground,
	plural,
	renderFileContent,
	renderToolCallChrome,
	renderToolError,
	renderToolSummary,
} from "../render.js";
import { fitLine } from "../../ui/chrome.js";
import { resolveTextCtor } from "../tui-text.js";
import type {
	ComponentLike,
	ReadDetails,
	RenderCtxLike,
	SdkToolDef,
	TextContent,
	ThemeLike,
} from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

type ResponsiveReadState = {
	baseRender: (width: number) => string[];
	renderWidth: (width: number) => void;
};

const responsiveReadStates = new WeakMap<object, ResponsiveReadState>();

function installResponsiveReadRender(
	text: ComponentLike,
	renderWidth: (width: number) => void,
): void {
	let state = responsiveReadStates.get(text);
	if (!state) {
		state = {
			baseRender: text.render.bind(text),
			renderWidth,
		};
		responsiveReadStates.set(text, state);
		text.render = (width: number): string[] => {
			const current = responsiveReadStates.get(text);
			if (!current) return [];
			const fittedWidth = Math.max(1, Math.floor(width || termWidth()));
			current.renderWidth(fittedWidth);
			return current.baseRender(fittedWidth);
		};
	}
	state.renderWidth = renderWidth;
}

function getSkillName(filePath: string, content: string): string | undefined {
	if (basename(filePath) !== "SKILL.md") return undefined;

	const lines = content.split("\n");
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex(
			(line, index) => index > 0 && line.trim() === "---",
		);
		for (const line of lines.slice(1, end < 0 ? 1 : end)) {
			const match = /^name\s*:\s*(.+?)\s*$/.exec(line);
			if (!match) continue;
			const value = match[1].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				return value.slice(1, -1).trim() || basename(dirname(filePath));
			}
			return value || basename(dirname(filePath));
		}
	}

	return basename(dirname(filePath));
}

function renderSkillHeader(
	skillName: string,
	expanded: boolean,
	theme: ThemeLike,
): string {
	const label = theme.fg("accent", "[skill]");
	const name = theme.fg("toolTitle", skillName);
	const hint = theme.fg("dim", `ctrl+o to ${expanded ? "collapse" : "expand"}`);
	return `${label} ${name} ${hint}`;
}

export function registerReadTool(
	pi: ExtensionAPI,
	cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (
		t?: string,
		x?: number,
		y?: number,
	) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	// SAFETY: the definition mirrors the SDK builtin read's runtime shape — its own
	// parameters schema and execute contract — plus duck-typed renderCall/renderResult
	// extensions Pi accepts at runtime but ToolDefinition's generics cannot express,
	// so the literal is widened once at this boundary (asserted at its end below).
	pi.registerTool({
		name: "read",
		label: "Read",
		description: sdkTool.description ?? "Read file contents",
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(
			async (tid, params, sig, _upd, ctx: ExtensionContext) => {
				const p = params as any;
				const filePath = String(p.path ?? "");
				const isImage = /\.(?:jpe?g|png|gif|webp|bmp)$/i.test(filePath);

				if (!isImage) {
					const routed = await executeRtkTool(
						pi,
						"read",
						[filePath, "--line-numbers"],
						ctx.cwd,
						sig,
					);
					if (routed) {
						requireRtkSuccess("read", routed);
						const offset =
							typeof p.offset === "number" ? Math.max(1, p.offset) : 1;
						const end =
							typeof p.limit === "number"
								? offset + Math.max(0, p.limit)
								: Infinity;
						const numberedLines = normalizeLineEndings(routed.stdout)
							.trimEnd()
							.split("\n")
							.map((line) => /^\s*(\d+)\s+[│|]\s?(.*)$/.exec(line))
							.filter((match): match is RegExpExecArray => match !== null)
							.map((match) => ({
								number: Number(match[1]),
								text: match[2] ?? "",
							}));
						const selected = numberedLines
							.filter((line) => line.number >= offset && line.number < end)
							.map((line) => line.text);
						const start = offset - 1;
						const tc = truncateRtkOutput(selected.join("\n"));
						return {
							content: [{ type: "text" as const, text: tc }],
							details: {
								_type: "readFile",
								filePath,
								content: tc,
								offset: start,
								lineCount: tc ? tc.split("\n").length : 0,
							} as ReadDetails,
						};
					}
				}

				// Images have no RTK representation. SDK execution is also the fail-open
				// path when the RTK binary cannot execute the requested text read.
				const result = (await sdkTool.execute(
					tid,
					p,
					sig,
					undefined,
					ctx,
				)) as Result;
				const imageBlock = (result.content as any[])?.find(
					(c: any) => c.type === "image",
				);
				if (imageBlock) {
					result.details = {
						_type: "readImage",
						filePath,
					} as ReadDetails;
					return result;
				}

				const tc = normalizeLineEndings(getText(result));
				result.details = {
					_type: "readFile",
					filePath,
					content: tc,
					offset: typeof p.offset === "number" ? p.offset : 0,
					lineCount: tc ? tc.split("\n").length : 0,
				} as ReadDetails;
				return result;
			},
		),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);
			if (!ctx.isError) {
				text.setText("");
				return text;
			}

			const path = String(args.path ?? "");
			const label = theme.fg("error", theme.bold("→ read"));
			text.setText(
				fillToolBackground(
					`\n${TOOL_RESULT_INDENT}${label} ${theme.fg("toolTitle", path)}\n`,
					BG_ERROR,
				),
			);
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

			if (ctx.isError) {
				text.setText(
					fillToolBackground(
						renderToolError(getText(result) || "Error", theme),
						BG_ERROR,
					),
				);
				return text;
			}

			const d = result.details as ReadDetails | undefined;

			// Image content is preserved for ToolExecution's host-generic image pass.
			// Keep the SDK's text note visible as a fallback when host images are hidden
			// or unsupported by the terminal.
			if (d?._type === "readImage") {
				const note = getText(result);
				text.setText(note ? fillToolBackground(note, BG_BASE) : "");
				return text;
			}

			// File content — line-numbered display
			if (d?._type === "readFile" && d.content) {
				const lines = d.content.split("\n");
				const total = lines.length;
				const filePath = String(d.filePath ?? "");
				const skillName = getSkillName(filePath, d.content);
				const p2 = shortPath(cwd, home, filePath);
				const off2 = typeof d.offset === "number" ? `:${d.offset}` : "";
				// Every render transition invalidates async work from the previous view.
				ctx.state._readRenderGeneration = String(
					Number(ctx.state._readRenderGeneration ?? "0") + 1,
				);
				if (!ctx.expanded) {
					const renderCollapsed = (width: number) => {
						const content = skillName
							? `\n${TOOL_RESULT_INDENT}${renderSkillHeader(skillName, false, theme)}\n`
							: `\n${renderToolCallChrome(theme, "read", `${p2}${off2}`, { width })}\n${renderToolSummary(theme, plural(total, "line"), [], { hint: "ctrl+o expand", width })}\n`;
						text.setText(fillToolBackground(content, BG_BASE, width));
					};
					installResponsiveReadRender(text as ComponentLike, renderCollapsed);
					renderCollapsed(termWidth());
					return text;
				}

				const maxShow = lines.length;
				const show = lines.slice(0, maxShow);
				const numberWidth = Math.max(3, String(total).length);
				let lastWidth = -1;
				const renderExpanded = (width: number) => {
					if (width === lastWidth) return;
					lastWidth = width;
					const generation = String(
						Number(ctx.state._readRenderGeneration ?? "0") + 1,
					);
					ctx.state._readRenderGeneration = generation;
					const gutterWidth = numberWidth + 4;
					const codeWidth = Math.max(1, width - gutterWidth);
					const header = skillName
						? renderSkillHeader(skillName, true, theme)
						: renderToolCallChrome(theme, "read", `${p2}${off2}`, { width });
					const out: string[] = ["", header];
					out.push(
						`${TOOL_RESULT_INDENT}${FG_RULE}${"─".repeat(Math.max(1, width - 1))}${RST}`,
					);
					for (let i = 0; i < show.length; i++) {
						const lineNo = String((d.offset || 0) + i + 1);
						const display = fitLine(show[i] ?? "", codeWidth, `${FG_DIM}›${RST}`);
						out.push(
							`${TOOL_RESULT_INDENT}${FG_LNUM}${" ".repeat(Math.max(0, numberWidth - lineNo.length))}${lineNo}${RST} ${FG_RULE}│${RST} ${display}${RST}`,
						);
					}
					out.push("");
					const plain = out.join("\n");
					text.setText(fillToolBackground(plain, BG_BASE, width));
					ctx.state._rt = plain;

					void renderFileContent(
						d.content,
						d.filePath,
						d.offset || 0,
						maxShow,
						codeWidth,
					)
						.then((highlighted) => {
							if (ctx.state._readRenderGeneration !== generation) return;
							const padded = highlighted
								.split("\n")
								.map((line, index) => {
									const lineNo = String((d.offset || 0) + index + 1);
									return `${TOOL_RESULT_INDENT}${FG_LNUM}${" ".repeat(Math.max(0, numberWidth - lineNo.length))}${lineNo}${RST} ${FG_RULE}│${RST} ${line}${RST}`;
								})
								.join("\n");
							const divider = `${TOOL_RESULT_INDENT}${FG_RULE}${"─".repeat(Math.max(1, width - 1))}${RST}\n`;
							const rendered = `\n${header}\n${divider}${padded}\n`;
							text.setText(fillToolBackground(rendered, BG_BASE, width));
							ctx.state._rt = rendered;
							text.invalidate?.();
						})
						.catch(() => {});
				};

				installResponsiveReadRender(text as ComponentLike, renderExpanded);
				renderExpanded(termWidth());
				return text;
			}

			const fc = result.content?.[0];
			text.setText(
				fillToolBackground(
					`${TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
					BG_BASE,
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
