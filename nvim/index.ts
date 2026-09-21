// ---------------------------------------------------------------------------
// aio nvim integration — registration.
//
//   /nvim <path>[:line[:col]]   open the file in a Neovim buffer in a new
//                               otty pane beside this session
//   /nvim -r <path>[:line]      read-only view
//   open_nvim (tool)            the agent opens a file for you — typically
//                               right after a write/edit, handing you the
//                               changed file at the changed line
//
// The launcher chain mirrors hunk/launcher.ts: otty pane split anchored to
// $OTTY_PANE_ID → tmux → otty tab → macOS Terminal.app → print. nvim owns
// the pane afterward (exec keeps the pane alive in the editor until :q).
// ---------------------------------------------------------------------------

import { Type, type Static } from "typebox";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	buildNvimArgs,
	formatNvimCommand,
	openInNvim,
	parseFileTarget,
	resolveNvimPath,
	type NvimOpenRequest,
} from "./core.js";
import { throwIfAborted } from "./abort.js";

const NvimToolParameters = Type.Object({
	path: Type.String({
		description: "File to open (relative to cwd or absolute). Shorthand path:line or path:line:col anchors the cursor.",
	}),
	line: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based line to place the cursor on (overrides path:line)." }),
	),
	column: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based column (requires line)." }),
	),
	readOnly: Type.Optional(
		Type.Boolean({ description: "Open read-only (nvim -R). Default false." }),
	),
});

export type NvimToolParams = Static<typeof NvimToolParameters>;

export type NvimToolDetails = {
	readonly command: string;
	readonly launched: boolean;
};

function toolResult(text: string, details: NvimToolDetails): AgentToolResult<NvimToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

const TOOL_DESCRIPTION = `Open a file in Neovim in a new terminal pane beside the user's session (otty split when available, else tmux/otty tab/Terminal.app).

Use this when the user asks to "open" a file you were reading or editing, and right after a write/edit when they will want to see it in their editor: pass the changed file and the line you changed (firstChangedLine for edits). The editor pane opens beside the conversation; the user stays in control of their keyboard — do not open more than a handful of files per task.`;

export function createNvimTool(pi: ExtensionAPI): ToolDefinition<typeof NvimToolParameters> {
	return {
		name: "open_nvim",
		label: "Open in Neovim",
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"Open a file (optionally at a line) in Neovim in a new terminal pane beside the user's session — use after write/edit to hand the user the changed file.",
		promptGuidelines: [
			"After editing a file, offer to open it at the changed line rather than opening it unprompted every time.",
			"path:line shorthand works; line/column parameters override the shorthand.",
		],
		parameters: NvimToolParameters,

		async execute(
			_callId: string,
			params: NvimToolParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<NvimToolDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<NvimToolDetails>> {
			throwIfAborted(signal);
			const shorthand = parseFileTarget(params.path);
			const request: NvimOpenRequest = {
				path: resolveNvimPath(shorthand.path, ctx.cwd),
			};
			// Explicit line/column parameters override the path:line shorthand.
			if (params.line !== undefined) {
				request.line = params.line;
			} else if (shorthand.line !== undefined) {
				request.line = shorthand.line;
			}
			if (params.column !== undefined) {
				request.column = params.column;
			} else if (params.line === undefined && shorthand.column !== undefined) {
				request.column = shorthand.column;
			}
			if (params.readOnly) {
				request.readOnly = true;
			}
			const output = await openInNvim(pi, ctx, request);
			return toolResult(output, {
				command: formatNvimCommand(request),
				launched: !output.startsWith("no terminal launcher"),
			});
		},
	};
}

const NVIM_HELP =
	"/nvim <path>[:line[:col]] — open a file in Neovim in a new Otty pane beside this session.\n" +
	"  /nvim src/index.ts          open at the top\n" +
	"  /nvim src/index.ts:42       open with the cursor on line 42\n" +
	"  /nvim src/index.ts:42:7     line 42, column 7\n" +
	"  /nvim -r src/index.ts:42    read-only view\n" +
	"The agent can open files for you too (open_nvim tool). Launcher: Otty pane split (anchored to this session) → tmux → Otty tab → Terminal.app → the printed command.";

export default function registerNvim(pi: ExtensionAPI): void {
	pi.registerTool(createNvimTool(pi));

	pi.registerCommand("nvim", {
		description: "Open a file in Neovim in a new Otty pane beside this session",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length === 0 || trimmed === "help" || trimmed === "-h") {
				notifyNvim(ctx, NVIM_HELP);
				return;
			}

			// -r / --read-only flag, then the target.
			let readOnly = false;
			let target = trimmed;
			if (target.startsWith("-r ") || target.startsWith("--read-only ")) {
				readOnly = true;
				target = target.replace(/^(--read-only|-r)\s+/, "");
			}
			if (target.length === 0) {
				notifyNvim(ctx, NVIM_HELP, "warning");
				return;
			}

			const parsed = parseFileTarget(target);
			const request: NvimOpenRequest = {
				path: resolveNvimPath(parsed.path, ctx.cwd),
			};
			if (parsed.line !== undefined) {
				request.line = parsed.line;
			}
			if (parsed.column !== undefined) {
				request.column = parsed.column;
			}
			if (readOnly) {
				request.readOnly = true;
			}
			const output = await openInNvim(pi, ctx, request);
			notifyNvim(ctx, output);
		},
	});

	pi.registerCommand("nvim-open-help", {
		description: "Show /nvim usage and launcher behavior",
		handler: async (_args, ctx) => {
			notifyNvim(ctx, NVIM_HELP);
		},
	});
}

function notifyNvim(
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		// eslint-disable-next-line no-console
		console.info(`[aio nvim] ${message}`);
	}
}
