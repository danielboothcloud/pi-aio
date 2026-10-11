// ---------------------------------------------------------------------------
// aio nvim integration — registration.
//
//   /nvim <path>[:line[:col]]   open the file in a Neovim buffer in a new
//                               otty pane beside this session
//   /nvim -r <path>[:line]      read-only view
//   /nvim @a.ts:3 @b.ts         @-references (pi's @-file completion shape);
//                               several tokens open several panes
//
// This is a USER-initiated surface only: nvim owns no agent tool.
//
// Typing /nvim suggests files this session read or edited first (tracked
// from tool_result events), then git-tracked project files. Pi's built-in
// @-file completion inserts `@path`, which the handler strips — without
// that, nvim would open a nonexistent "@path" buffer.
//
// The launcher chain: otty pane split anchored to
// $OTTY_PANE_ID → tmux → otty tab → macOS Terminal.app → print. nvim owns
// the pane afterward (exec keeps the pane alive in the editor until :q).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import {
	buildNvimCompletions,
	filePathsFromToolResult,
	openInNvim,
	parseFileTarget,
	resolveNvimPath,
	splitNvimTargets,
	stripAtReference,
	touchSessionFiles,
	type NvimOpenRequest,
	type SessionFileEntry,
} from "./core.js";

const NVIM_HELP =
	"/nvim <path>[:line[:col]] — open a file in Neovim in a new Otty pane beside this session.\n" +
	"  /nvim src/index.ts          open at the top\n" +
	"  /nvim src/index.ts:42       open with the cursor on line 42\n" +
	"  /nvim src/index.ts:42:7     line 42, column 7\n" +
	"  /nvim -r src/index.ts:42    read-only view\n" +
	"  /nvim @src/index.ts         @-references work too (pi's @-file completion)\n" +
	"  /nvim @a.ts:3 @b.ts         several files — one pane each\n" +
	"Typing /nvim suggests files this session read or edited first, then project files.\n" +
	"Launcher: Otty pane split (anchored to this session) → tmux → Otty tab → Terminal.app → the printed command.";

// ---- session file tracking (the /nvim suggestion source) ----
//
// Pure helpers (SessionFileEntry, filePathsFromToolResult, touchSessionFiles,
// buildNvimCompletions) live in core.ts so the node:test suite can load them
// without the SDK value-import chain; this module only wires them up.

export default function registerNvim(pi: ExtensionAPI): void {
	// ---- session file MRU (feeds /nvim argument suggestions) ----

	let sessionFiles: SessionFileEntry[] = [];
	// The completions callback gets no ctx; track the session cwd from
	// tool_result events (the process cwd is only a bootstrap default).
	let sessionCwd = process.cwd();

	pi.on("tool_result", async (event, ctx) => {
		sessionCwd = ctx.cwd;
		const { paths, edited } = filePathsFromToolResult(event);
		if (paths.length === 0) return undefined;
		sessionFiles = touchSessionFiles(
			sessionFiles,
			paths.map((path) => resolvePath(ctx.cwd, path)),
			edited,
			Date.now(),
		);
		return undefined;
	});

	/** Project files for suggestions: git-tracked, best effort. */
	const listProjectFiles = async (cwd: string): Promise<string[]> => {
		try {
			const result = await pi.exec("git", ["ls-files"], { cwd, timeout: 2_000 });
			if (result.code !== 0) return [];
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.slice(0, 500);
		} catch {
			return [];
		}
	};

	pi.registerCommand("nvim", {
		description: "Open a file in Neovim in a new Otty pane beside this session",
		getArgumentCompletions: async (prefix: string) => {
			const projectFiles = await listProjectFiles(sessionCwd);
			const items = buildNvimCompletions(prefix, sessionFiles, projectFiles, sessionCwd);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length === 0 || trimmed === "help" || trimmed === "-h") {
				notifyNvim(ctx, NVIM_HELP);
				return;
			}

			// -r / --read-only flag, then the target(s).
			let readOnly = false;
			let rest = trimmed;
			if (rest.startsWith("-r ") || rest.startsWith("--read-only ")) {
				readOnly = true;
				rest = rest.replace(/^(--read-only|-r)\s+/, "");
			}
			// @-tokens split into multiple targets; without @ the whole string
			// stays one target (paths may contain spaces).
			const tokens = splitNvimTargets(rest);
			const targets: string[] = [];
			for (const [index, token] of tokens.entries()) {
				if (index === 0 && (token === "-r" || token === "--read-only")) {
					readOnly = true;
					continue;
				}
				targets.push(token);
			}
			if (targets.length === 0) {
				notifyNvim(ctx, NVIM_HELP, "warning");
				return;
			}

			const outputs: string[] = [];
			for (const target of targets) {
				const parsed = parseFileTarget(stripAtReference(target));
				if (parsed.path.length === 0) continue;
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
				outputs.push(await openInNvim(pi, ctx, request));
			}
			notifyNvim(ctx, outputs.join("\n"));
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
