/* pi-pretty: find tool -- RTK-enforced file search with SDK fallback. */

import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	executeRtkTool,
	limitRtkLines,
	requireRtkSuccess,
} from "../../rtk/tool-routing.js";
import {
	BG_ERROR,
	FG_DIM,
	RST,
	resolveBaseBackground,
	TOOL_RESULT_INDENT,
} from "../config.js";
import { shortPath } from "../helpers.js";
import {
	fillToolBackground,
	renderFindResults,
	renderToolDuration,
	renderToolError,
} from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type {
	FffServiceWithCursor,
	FindDetails,
	RenderCtxLike,
	SdkToolDef,
	TextContent,
	ThemeLike,
} from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

function getText(result: Result): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => (c as TextContent).text ?? "")
		.join("\n");
}

function buildRtkFindArgs(
	pattern: string,
	path: string | undefined,
): string[] | undefined {
	const absolute = pattern.startsWith("/");
	const parts = pattern
		.replace(/^\.?\//, "")
		.split("/")
		.filter(Boolean);
	const filePattern = parts.pop() ?? pattern;
	const staticDirectories: string[] = [];

	for (const part of parts) {
		if (part === "**") continue;
		if (/[*?[\]]/.test(part)) return undefined;
		staticDirectories.push(part);
	}

	const searchPath = join(absolute ? "/" : (path ?? "."), ...staticDirectories);
	return [filePattern, searchPath];
}

function parseRtkFindOutput(output: string, limit: number): string {
	const lines = output.replace(/\r\n?/g, "\n").trim().split("\n");
	const paths: string[] = [];

	for (const line of lines) {
		const match = /^(\S*\/)\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		const directory = match[1] === "./" ? "" : match[1];
		for (const file of (match[2] ?? "").split(/\s+/).filter(Boolean)) {
			paths.push(`${directory}${file}`);
			if (paths.length >= limit) return paths.join("\n");
		}
	}

	return paths.length > 0 ? paths.join("\n") : limitRtkLines(output, limit);
}

async function sdkFindAsFindResult(
	sdkTool: SdkToolDef,
	tid: string,
	params: Record<string, unknown>,
	sig: AbortSignal | undefined,
	ctx: ExtensionContext,
	pattern: string,
	extraNotices: string[],
): Promise<Result> {
	const result = (await sdkTool.execute(
		tid,
		params,
		sig,
		undefined,
		ctx,
	)) as Result;
	const tc = getText(result);
	const prev = (result.details as FindDetails | undefined)?.notices ?? [];
	const notices = [...(Array.isArray(prev) ? prev : []), ...extraNotices];
	result.details = {
		_type: "findResult",
		text: tc,
		pattern,
		matchCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
		notices,
	};
	return result;
}

export function registerFindTool(
	pi: ExtensionAPI,
	cwd: string,
	_fffService: FffServiceWithCursor | null | undefined,
	sdkTool: SdkToolDef,
	TextComp?: new (
		t?: string,
		x?: number,
		y?: number,
	) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	pi.registerTool({
		name: "find",
		label: "Find",
		description: sdkTool.description ?? "Find files matching a glob pattern",
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(
			async (tid, params, sig, _upd, ctx: ExtensionContext) => {
				const pattern = String(params.pattern ?? "");
				const path = params.path ? String(params.path) : undefined;
				const effectiveLimit = Math.max(
					1,
					typeof params.limit === "number" ? params.limit : 100,
				);
				const rtkArgs = buildRtkFindArgs(pattern, path);
				if (!rtkArgs) {
					return sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
						"RTK find cannot represent wildcard directory segments; results from SDK find (fd).",
					]);
				}
				const routed = await executeRtkTool(pi, "find", rtkArgs, ctx.cwd, sig);

				if (routed) {
					requireRtkSuccess("find", routed);
					const text = parseRtkFindOutput(routed.stdout, effectiveLimit);
					return {
						content: [{ type: "text" as const, text }],
						details: {
							_type: "findResult",
							text,
							pattern,
							matchCount: text ? text.split("\n").filter(Boolean).length : 0,
							notices: ["Search engine: RTK find."],
						},
					};
				}

				return sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
					"RTK could not execute; results from SDK find (fd).",
				]);
			},
		),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const a = args as { pattern?: unknown; path?: unknown; limit?: unknown };
			const text = (ctx as RenderCtxLike).lastComponent ?? new TC("", 0, 0);
			const pattern = a.pattern == null ? "" : String(a.pattern);
			const pathArg =
				a.path == null ? "<missing>" : shortPath(cwd, home, String(a.path));
			const limit = a.limit;
			const findLabel = theme.fg(
				ctx.isError ? "error" : "toolTitle",
				theme.bold("✱ find"),
			);
			const patternPart = pattern ? theme.fg("toolTitle", pattern) : "";
			const inPart = theme.fg("dim", " in ");
			const pathPart = theme.fg("toolOutput", pathArg);
			const limitPart =
				limit !== undefined && limit !== null
					? theme.fg("dim", ` limit ${limit}`)
					: "";
			const out = `${findLabel} ${patternPart}${inPart}${pathPart}${limitPart}`;
			text.setText(
				fillToolBackground(
					`\n${TOOL_RESULT_INDENT}${out}\n`,
					ctx.isError ? BG_ERROR : undefined,
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
			const r = result;
			const text = (ctx as RenderCtxLike).lastComponent ?? new TC("", 0, 0);
			if (ctx.isError) {
				text.setText(renderToolError(getText(r) || "Error", theme));
				return text;
			}
			const d = r.details as FindDetails | undefined;
			if (d?._type === "findResult") {
				if (!d.text.trim()) {
					const noticeStr = d.notices?.length
						? `\n${TOOL_RESULT_INDENT}${theme.fg("warning", `[${d.notices.join(". ")}]`)}`
						: "";
					text.setText(
						fillToolBackground(
							`\n${TOOL_RESULT_INDENT}${theme.fg("dim", "0 files")}${noticeStr}\n`,
						),
					);
					return text;
				}
				if (!ctx.expanded) {
					const duration = renderToolDuration(r);
					text.setText(
						fillToolBackground(
							`${TOOL_RESULT_INDENT}${FG_DIM}${d.matchCount} files — ctrl+o to expand${RST}${duration ? `${FG_DIM}· ${duration}${RST}` : ""}\n`,
						),
					);
					return text;
				}
				const rendered = renderFindResults(d.text, theme)
					.split("\n")
					.map((l) => `${TOOL_RESULT_INDENT}${l}`)
					.join("\n");
				const noticeStr = d.notices?.length
					? `\n${TOOL_RESULT_INDENT}${theme.fg("warning", `[${d.notices.join(". ")}]`)}`
					: "";
				const duration = renderToolDuration(r);
				text.setText(
					fillToolBackground(
						`\n${TOOL_RESULT_INDENT}${theme.fg("dim", `${d.matchCount} files`)}${duration ? `${FG_DIM}· ${duration}${RST}` : ""}\n${rendered}${noticeStr}\n`,
					),
				);
				return text;
			}
			const fc = r.content?.[0] as TextContent | undefined;
			text.setText(
				fillToolBackground(
					`\n${TOOL_RESULT_INDENT}${theme.fg("dim", fc?.text?.slice(0, 120) ?? "0 files")}\n`,
				),
			);
			return text;
		},
	} as unknown as ToolDefinition);
}
