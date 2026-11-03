// Session navigation: a plain-English rewind picker on double-Esc (/rewind)
// and a grouped resume picker for /resume (/sessions, `pi --sessions`).
// Pi's own /tree, /fork and `pi --resume` stay available unchanged.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	parseArgs,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { setEditorIntercepts } from "../ui/editor-intercepts.js";
import { buildCheckpoints, type TreeNodeLike } from "./checkpoints.js";
import { type RewindResult, RewindPicker } from "./rewind-view.js";
import { ResumePicker, type ResumeScope } from "./resume-view.js";
import { readLastExchange, type SessionLike } from "./sessions.js";

export const REWIND_COMMAND = "rewind";
export const SESSIONS_COMMAND = "sessions";
export const SESSIONS_FLAG = "sessions";
/** Same window pi uses for its own double-Escape. */
export const DOUBLE_ESCAPE_MS = 500;

type DoubleEscapeAction = "tree" | "fork" | "none";

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/** Pi's doubleEscapeAction: trusted project settings override global ones. */
export function readDoubleEscapeAction(cwd: string, projectTrusted: boolean): DoubleEscapeAction {
	const sources = [readSettings(join(getAgentDir(), "settings.json"))];
	if (projectTrusted) sources.push(readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json")));
	let action: DoubleEscapeAction = "tree";
	for (const settings of sources) {
		const value = settings.doubleEscapeAction;
		if (value === "tree" || value === "fork" || value === "none") action = value;
	}
	return action;
}

/** Pi's default layout keeps one sub-directory per folder under <agentDir>/sessions. */
function usesDefaultSessionDir(sessionDir: string): boolean {
	return resolve(dirname(sessionDir)) === resolve(getAgentDir(), "sessions");
}

/**
 * The startup picker is for launches that have not chosen a session yet. A
 * recipe relaunch after a pick forwards the user's argv (including
 * --sessions) together with --session <file>; never reopen the picker there.
 */
export function launchSelectsSession(argv: string[]): boolean {
	const parsed = parseArgs(argv.slice(2));
	return Boolean(
		parsed.continue || parsed.resume || parsed.session !== undefined ||
		parsed.sessionId !== undefined || parsed.fork !== undefined || parsed.noSession,
	);
}

function maxPickerRows(rows: number): number {
	return Math.max(10, Math.floor(rows * 0.8));
}

export async function applyRewind(ctx: ExtensionCommandContext, result: RewindResult): Promise<void> {
	const { checkpoint, action } = result;
	switch (action) {
		case "edit":
			await ctx.navigateTree(checkpoint.id, { summarize: false });
			return;
		case "after":
			await ctx.navigateTree(checkpoint.endId, { summarize: false });
			return;
		case "summary":
			ctx.ui.notify("Summarizing the later conversation…", "info");
			await ctx.navigateTree(checkpoint.id, { summarize: true });
			return;
		case "fork":
			await ctx.fork(checkpoint.id, { position: "before" });
			return;
	}
}

export function registerSessionNav(pi: ExtensionAPI, argv: string[] = process.argv): void {
	let currentCtx: ExtensionContext | undefined;
	let doubleEscape: DoubleEscapeAction = "tree";
	let lastEscape: number | undefined;
	let startupPickerShown = false;

	pi.registerFlag(SESSIONS_FLAG, {
		description: "Start with AIO's session picker open (a friendlier --resume)",
		type: "boolean",
		default: false,
	});

	function runCommand(name: string): void {
		try {
			pi.sendUserMessage(`/${name}`, { expandPromptTemplates: true });
		} catch (error) {
			currentCtx?.ui.notify(`Could not open /${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function onEscape(): boolean {
		const ctx = currentCtx;
		if (!ctx || ctx.mode !== "tui" || doubleEscape === "none") return false;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			lastEscape = undefined;
			return false;
		}
		const now = Date.now();
		if (lastEscape !== undefined && now - lastEscape < DOUBLE_ESCAPE_MS) {
			lastEscape = undefined;
			runCommand(REWIND_COMMAND);
			return true;
		}
		// The first press still reaches pi (it is harmless on an idle, empty
		// editor); only the second one is claimed, so pi never opens its tree.
		lastEscape = now;
		return false;
	}

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		lastEscape = undefined;
		if (ctx.mode !== "tui") return;
		doubleEscape = readDoubleEscapeAction(ctx.cwd, ctx.isProjectTrusted());
		setEditorIntercepts({
			escape: onEscape,
			submit: (text) => {
				if (text.trim() !== "/resume") return false;
				runCommand(SESSIONS_COMMAND);
				return true;
			},
			action: (action) => {
				if (action !== "app.session.resume") return false;
				runCommand(SESSIONS_COMMAND);
				return true;
			},
		});
		if (
			event.reason === "startup" && !startupPickerShown &&
			pi.getFlag(SESSIONS_FLAG) === true && !launchSelectsSession(argv)
		) {
			startupPickerShown = true;
			setTimeout(() => runCommand(SESSIONS_COMMAND), 0);
		}
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
		setEditorIntercepts(undefined);
	});

	pi.registerCommand(REWIND_COMMAND, {
		description: "Go back to an earlier prompt in this session (double-Esc)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Rewind needs the interactive terminal; use /tree instead.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for pi to finish (or press Esc to stop it), then rewind.", "warning");
				return;
			}
			const sm = ctx.sessionManager;
			const tree: TreeNodeLike[] = sm.getTree();
			const checkpoints = buildCheckpoints(tree, sm.getLeafId());
			if (checkpoints.length === 0) {
				ctx.ui.notify("No prompts to rewind to yet.", "info");
				return;
			}
			const result = await ctx.ui.custom<RewindResult | undefined>((tui, theme, _keys, done) =>
				new RewindPicker({
					theme,
					checkpoints,
					maxRows: () => maxPickerRows(tui.terminal.rows),
					done,
					requestRender: () => tui.requestRender(),
				}));
			if (!result) return;
			try {
				await applyRewind(ctx, result);
			} catch (error) {
				ctx.ui.notify(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand(SESSIONS_COMMAND, {
		description: "Resume another session (replaces /resume's picker; pi --sessions opens it at startup)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The session picker needs the interactive terminal.", "warning");
				return;
			}
			const sm = ctx.sessionManager;
			const cwd = sm.getCwd();
			const sessionDir = sm.getSessionDir();
			const currentPath = sm.getSessionFile();
			const loadSessions = (scope: ResumeScope): Promise<SessionLike[]> =>
				scope === "folder"
					? SessionManager.list(cwd, sessionDir)
					: usesDefaultSessionDir(sessionDir) ? SessionManager.listAll() : SessionManager.listAll(sessionDir);
			const path = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) =>
				new ResumePicker({
					theme,
					cwd,
					currentPath,
					homeDir: homedir(),
					loadSessions,
					loadPreview: (file) => readLastExchange(file),
					maxRows: () => maxPickerRows(tui.terminal.rows),
					done,
					requestRender: () => tui.requestRender(),
				}));
			if (!path) return;
			if (path === currentPath) {
				ctx.ui.notify("That session is already open.", "info");
				return;
			}
			try {
				await ctx.switchSession(path);
			} catch (error) {
				ctx.ui.notify(`Could not open the session: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
