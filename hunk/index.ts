// ---------------------------------------------------------------------------
// aio hunk integration: /hunk command family + tool + skill + enforce.
//
// Surfaces, matching upstream's agent workflow:
//   1. The `hunk` model tool wraps the non-interactive `hunk session *` CLI
//      (inspect / navigate / inline AI annotations / attention marks).
//   2. The `/hunk` user command opens an interactive review beside this
//      session through an ordered launcher chain (Otty pane split anchored
//      to $OTTY_PANE_ID → tmux → Otty tab → macOS Terminal.app → print).
//   3. `/hunk enforce` turns ON automatic inline AI annotations: after each
//      meaningful mutation batch, aio leaves bounded, file-anchored
//      comments on the live review — instead of annotations appearing only
//      when the model decides to call the hunk tool. Persists in
//      ~/.pi/agent/aio-hunk-enforce.json.
//
// The bundled hunk-review skill path is fed into resources_discover so the
// model loads Hunk's authoritative agent guidance natively. Everything
// degrades silently when hunk is not installed (optional integration per
// the aio house rules).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHunkTool } from "./tool.js";
import { formatHunkCommand, launchHunkInteractive, planLaunchAttempts } from "./launcher.js";
import { resolveHunkSkillPath, resetHunkSkillPathForTests } from "./skill.js";
import { readHunkEnforceState, writeHunkEnforceState, hunkEnforceFilePath, detectVcs } from "./enforce.js";
import { EnforceRuntime, mutationsFromToolResult, bashMutationsFromToolResult } from "./enforce-runtime.js";
import { hasLiveSession } from "./annotator.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type { HunkToolParams, HunkToolDetails } from "./tool.js";
export type { HunkAction } from "./tool.js";
export type { LaunchMode, LaunchAttempt } from "./launcher.js";
export type { HunkEnforceState } from "./enforce.js";

const OPEN_HELP =
	"/hunk [args] — open an interactive Hunk review of this checkout in a sibling terminal.\n" +
	"Without args: hunk diff (working tree, including untracked files).\n" +
	"Examples:\n" +
	"  /hunk                    review the working tree\n" +
	"  /hunk diff               same as bare /hunk\n" +
	"  /hunk diff --staged      review staged changes\n" +
	"  /hunk show HEAD~1        review an earlier commit\n" +
	"  /hunk diff --watch       auto-reload as the working tree changes\n" +
	"  /hunk on                 auto-annotate after every mutation batch\n" +
	"  /hunk off                return to inert (tool-call-only) annotations\n" +
	"  /hunk status             show enforce state, VCS, and live review\n" +
	"Then use the hunk tool to inspect, navigate, annotate, and highlight.\n" +
	"Launcher: " +
	"Otty pane split (anchored to this session) → tmux window → Otty tab → macOS Terminal.app → the printed command.";

const ENFORCE_HELP =
	"/hunk on — turn ON automatic inline AI annotations: after each meaningful\n" +
	"mutation batch (write / edit / apply_patch / mutation-shaped bash), aio\n" +
	"leaves bounded, file-anchored comments on the live review automatically.\n" +
	"Requires an open review (/hunk).\n" +
	"/hunk off — return to inert (annotations only when the model calls the\n" +
	"hunk tool).\n" +
	"/hunk status — show the enforce state, VCS checkout, and live review.\n" +
	"(/hunk enforce [on|off|status] still works as an alias.)\n" +
	"State persists across sessions in ~/.pi/agent/aio-hunk-enforce.json.";

function notifyCommand(
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		// eslint-disable-next-line no-console
		console.info(`[aio hunk] ${message}`);
	}
}

export default function registerHunk(pi: ExtensionAPI): void {
	// The tool throws its own "no active sessions" guidance, so registration
	// is unconditional; hunk-not-installed degrades inside the tool's error
	// classification.
	pi.registerTool(createHunkTool(pi));

	// Enforce state: persisted toggle + debounced annotation driver.
	let enforceState = readHunkEnforceState();
	const runtime = new EnforceRuntime((command, args, options) => pi.exec(command, args, options), {
		maxCommentsPerBatch: enforceState.maxCommentsPerBatch,
		maxBashAnnotations: enforceState.maxBashAnnotations,
	});

	const hunkExec = (command: string, args: string[], options?: { timeout?: number; cwd?: string }) =>
		pi.exec(command, args, options);

	const setEnforce = async (on: boolean, ctx: ExtensionContext): Promise<void> => {
		if (on) {
			// Enforce is meaningless outside a hunk-supported checkout: hunk
			// reviews VCS changesets, so a plain directory has no diff to
			// annotate. Stay OFF there.
			const vcsKind = await detectVcs(hunkExec, ctx.cwd);
			if (vcsKind === "none") {
				notifyCommand(
					ctx,
					`Hunk enforce stays OFF: ${ctx.cwd} is not a git, jujutsu, or sapling checkout — hunk has no diff to review in a plain directory. cd into a repository and run /hunk on again.`,
					"warning",
				);
				return;
			}
			enforceState = { ...enforceState, enforce: true };
			writeHunkEnforceState(enforceState);
			runtime.clear();
			notifyCommand(ctx, `Hunk enforce ON (${vcsKind} checkout detected): mutations will be auto-annotated on the live review. Open one with /hunk if none is running.`);
			return;
		}
		enforceState = { ...enforceState, enforce: false };
		writeHunkEnforceState(enforceState);
		runtime.clear();
		notifyCommand(ctx, "Hunk enforce OFF: annotations only when the model calls the hunk tool.");
	};

	const showEnforceStatus = async (ctx: ExtensionContext): Promise<void> => {
		const vcsKind = await detectVcs(hunkExec, ctx.cwd);
		const liveReview = enforceState.enforce ? await hasLiveSession(hunkExec, ctx.cwd) : false;
		let liveReviewLine = "not probed (enforce is off)";
		if (enforceState.enforce) {
			liveReviewLine = liveReview ? "detected — annotations will land on it" : "none right now — open one with /hunk";
		}
		notifyCommand(
			ctx,
			`Hunk enforce: ${enforceState.enforce ? "ON" : "OFF"} (max ${enforceState.maxCommentsPerBatch} comments/batch, bash budget ${enforceState.maxBashAnnotations}).
Live review: ${liveReviewLine}
VCS checkout: ${vcsKind === "none" ? "none — enforce is disabled outside repositories" : vcsKind}
State file: ${hunkEnforceFilePath()}`,
		);
	};

	pi.registerCommand("hunk", {
		description: "Open an interactive Hunk review in a sibling terminal",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim();
			if (trimmed.length === 0) {
				return [
					{ value: "on", label: "on — auto-annotate after mutations" },
					{ value: "off", label: "off — inert annotations" },
					{ value: "status", label: "status — enforce state, VCS, live review" },
					{ value: "diff", label: "diff — review the working tree" },
				];
			}
			if (/^(on|off|status|enforce)/.test(trimmed)) {
				return [
					{ value: "on", label: "on — auto-annotate after mutations" },
					{ value: "off", label: "off — inert annotations" },
					{ value: "status", label: "status — enforce state, VCS, live review" },
				];
			}
			if (prefix.startsWith("diff") || prefix.startsWith("show") || prefix.startsWith("log") || prefix.startsWith("stash")) {
				return [{ value: prefix, label: formatHunkCommand(prefix.trim().split(/\s+/)) }];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// ---- enforce toggles: /hunk on|off|status (enforce = alias) ----
			let enforceArg: string | undefined;
			if (trimmed === "on" || trimmed === "off" || trimmed === "status") {
				enforceArg = trimmed;
			} else if (trimmed === "enforce") {
				enforceArg = "on";
			} else if (trimmed.startsWith("enforce ")) {
				enforceArg = trimmed.slice("enforce".length).trim();
			}
			if (enforceArg !== undefined) {
				if (enforceArg === "on") {
					await setEnforce(true, ctx);
					return;
				}
				if (enforceArg === "off") {
					await setEnforce(false, ctx);
					return;
				}
				if (enforceArg === "status") {
					await showEnforceStatus(ctx);
					return;
				}
				notifyCommand(ctx, ENFORCE_HELP, "warning");
				return;
			}

			// ---- bare /hunk or review args: open the review ----
			if (trimmed === "help") {
				notifyCommand(ctx, `${OPEN_HELP}\n\n${ENFORCE_HELP}`);
				return;
			}
			const reviewArgs = trimmed.length > 0 ? trimmed.split(/\s+/) : ["diff"];
			const output = await launchHunkInteractive(pi, ctx, reviewArgs);
			notifyCommand(ctx, output);
			// After the review opens, reset the probe cache so enforce picks
			// it up on the next mutation.
			runtime.clear();
		},
	});

	pi.registerCommand("hunk-open-help", {
		description: "Show /hunk usage and launcher behavior",
		handler: async (_args, ctx) => {
			notifyCommand(ctx, OPEN_HELP);
		},
	});

	// ---- enforce watcher: mutation tool_results → debounced annotation ----

	pi.on("tool_result", async (event, ctx) => {
		if (!enforceState.enforce) return undefined;
		if (event.isError) return undefined;
		const batch = [...mutationsFromToolResult(event), ...bashMutationsFromToolResult(event)];
		if (batch.length === 0) return undefined;

		void runtime.queue(batch, { repo: ctx.cwd }, ctx.cwd, undefined, (outcome) => {
			if (ctx.hasUI) {
				// Quiet confirmation — and failures surface here too: a swallowed
				// annotation failure reads as "enforce silently does nothing".
				ctx.ui.setStatus("aio-hunk-enforce", outcome.left > 0 ? `hunk: ${outcome.left} note(s)` : `hunk: ${outcome.text}`);
			} else if (outcome.left === 0 && /^annotation failed/.test(outcome.text)) {
				// Headless: only real failures are worth a stderr line; the
				// "no review / nothing anchorable" cases stay silent.
				// eslint-disable-next-line no-console
				console.error(`[aio hunk] ${outcome.text}`);
			}
		});
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		runtime.clear();
	});

	// Surface the bundled hunk-review skill natively (optional: missing or
	// broken hunk installs contribute nothing).
	pi.on("resources_discover", async () => {
		const skillPath = await resolveHunkSkillPath((command, args, options) => pi.exec(command, args, options));
		return skillPath ? { skillPaths: [skillPath] } : undefined;
	});
}

export { formatHunkCommand, planLaunchAttempts, resetHunkSkillPathForTests };
