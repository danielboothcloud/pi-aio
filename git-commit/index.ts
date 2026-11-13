/**
 * /commit — user-only commit helper. The session model suggests one commit
 * message for the staged changes in one isolated call; the user commits it
 * (c), edits it (e), or commits and pushes it after a confirmation (p).
 *
 * Deliberately NOT an agent surface: it registers a command only, never a
 * tool, so the agent cannot commit or push through it. The model only
 * suggests; nothing enters the conversation context. Subagent children
 * register nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { plural } from "../ui/chrome.js";
import {
	commitStaged,
	createGitRunner,
	currentBranch,
	findRepoRoot,
	GitError,
	pendingOperation,
	pushCommits,
	recentSubjects,
	resolvePushTarget,
	stageAll,
	stagedDiff,
	stagedFiles,
	unstagedPaths,
	type ChangedFile,
	type GitRunner,
	type PushTarget,
} from "./git.js";
import {
	buildMessagePrompt,
	cleanMessage,
	FALLBACK_MESSAGE,
	MESSAGE_SYSTEM_PROMPT,
	parseMessage,
	subjectOf,
} from "./message.js";
import { CommitView, type CommitAction } from "./view.js";

/** ctx.modelRegistry.complete() narrowed to what /commit uses. */
export type MessageCompleteFn = (
	model: unknown,
	context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options?: { signal?: AbortSignal; maxTokens?: number },
) => Promise<{ content: Array<Record<string, unknown>>; stopReason: string; errorMessage?: string }>;

export interface Suggestion {
	message: string;
	/** Why the message is a template (no model, failed or unusable reply). */
	notice?: string;
}

export interface CommitOptions {
	/** Test seam: git runner factory for a repository root. */
	makeRunner?: (cwd: string) => GitRunner;
	/** Test seam: replaces ctx.modelRegistry.complete. */
	complete?: MessageCompleteFn;
	timeoutMs?: number;
}

/** Reasoning models spend part of this budget on thinking before the message. */
const MAX_TOKENS = 16_384;

function replyText(content: Array<Record<string, unknown>>): string {
	return content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function shortReason(text: string): string {
	return cleanMessage(text).slice(0, 160);
}

/** One isolated model call. Never throws: failures become the template message with a notice. */
export async function suggestMessage(input: {
	git: GitRunner;
	files: readonly ChangedFile[];
	model: unknown;
	complete: MessageCompleteFn | undefined;
	signal: AbortSignal;
}): Promise<Suggestion> {
	const fallback = (notice: string): Suggestion => ({ message: FALLBACK_MESSAGE, notice });
	if (!input.model || !input.complete) return fallback("No model is active: write the message yourself");
	try {
		const [branch, diff, subjects] = await Promise.all([
			currentBranch(input.git),
			stagedDiff(input.git),
			recentSubjects(input.git),
		]);
		const response = await input.complete(input.model, {
			systemPrompt: MESSAGE_SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: buildMessagePrompt({ branch, files: input.files, diff, recentSubjects: subjects }),
				timestamp: Date.now(),
			}],
		}, { signal: input.signal, maxTokens: MAX_TOKENS });
		if (input.signal.aborted || response.stopReason === "aborted") return fallback("Suggestion cancelled");
		if (response.stopReason === "error") {
			const reason = shortReason(response.errorMessage ?? "");
			return fallback(`Suggestion failed${reason ? `: ${reason}` : ""}`);
		}
		const message = parseMessage(replyText(response.content));
		if (message) return { message };
		return fallback(response.stopReason === "length"
			? "The model used its whole output budget before it wrote a message"
			: "The model reply did not contain a commit message");
	} catch (error) {
		const reason = shortReason(error instanceof Error ? error.message : String(error));
		return fallback(`Suggestion failed${reason ? `: ${reason}` : ""}`);
	}
}

/** Runs `task` behind a loader in the TUI; `cancellable` lets esc abort it. */
async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	cancellable: boolean,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (ctx.mode !== "tui") return task(new AbortController().signal);
	let running: Promise<T> | undefined;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable });
		loader.onAbort = () => done();
		running = task(loader.signal);
		running.then(() => done(), () => done());
		return loader;
	});
	// After a cancel the task sees its aborted signal and settles on its own.
	if (!running) throw new Error("the loader did not start");
	return running;
}

function describeFiles(paths: readonly string[], limit = 8): string {
	const shown = paths.slice(0, limit).map((path) => `  ${path}`);
	if (paths.length > limit) shown.push(`  … and ${paths.length - limit} more`);
	return shown.join("\n");
}

async function openCommitView(
	ctx: ExtensionContext,
	state: { branch: string; message: string; files: readonly ChangedFile[]; notice?: string; unstagedCount: number },
): Promise<CommitAction> {
	return ctx.ui.custom<CommitAction>(
		(tui, theme, _keys, done) =>
			new CommitView({
				theme,
				...state,
				getMaxRows: () => Math.floor(tui.terminal.rows * 0.9),
				done,
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", margin: 1, maxHeight: "90%", minWidth: 60, width: "85%" },
		},
	);
}

/** Resolves the push target and asks the user. Returns the target, or a reason it is not used. */
async function confirmPush(ctx: ExtensionContext, git: GitRunner): Promise<PushTarget | { notice?: string }> {
	const target = await resolvePushTarget(git);
	if ("error" in target) return { notice: `Cannot push: ${target.error}` };
	const ok = await ctx.ui.confirm(
		"Are you sure you want to commit and push?",
		`The commit is made, then pushed to ${target.label}.`,
	);
	return ok ? target : {};
}

/** Non-TUI (RPC) review: an editor dialog, then a choice. Undefined = cancel. */
async function reviewInDialogs(
	ctx: ExtensionContext,
	git: GitRunner,
	message: string,
): Promise<Chosen | undefined> {
	const edited = (await ctx.ui.editor("Commit message (empty cancels)", message))?.trim();
	if (!edited || !subjectOf(edited)) return undefined;
	const choice = await ctx.ui.select("Commit", ["Commit", "Commit and push", "Cancel"]);
	if (choice === "Commit") return { message: edited };
	if (choice !== "Commit and push") return undefined;
	const push = await confirmPush(ctx, git);
	if ("args" in push) return { message: edited, push };
	if (push.notice) ctx.ui.notify(`/commit: ${push.notice}`, "warning");
	return undefined;
}

interface StagedState {
	git: GitRunner;
	files: ChangedFile[];
	unstaged: string[];
}

/** Finds the repository and the staged set (staging all after a confirmation). Undefined = stop. */
async function prepareStaged(ctx: ExtensionContext, makeRunner: (cwd: string) => GitRunner): Promise<StagedState | undefined> {
	const root = await findRepoRoot(ctx.cwd, makeRunner);
	if (!root) {
		ctx.ui.notify("/commit: the current directory is not inside a git repository", "warning");
		return undefined;
	}
	const git = makeRunner(root);
	const pending = await pendingOperation(git);
	if (pending) {
		ctx.ui.notify(`/commit: finish ${pending} with plain git first`, "warning");
		return undefined;
	}
	let files = await stagedFiles(git);
	let unstaged = await unstagedPaths(git);
	if (files.length === 0) {
		if (unstaged.length === 0) {
			ctx.ui.notify("/commit: nothing to commit, the working tree is clean", "info");
			return undefined;
		}
		const ok = await ctx.ui.confirm(
			"Nothing is staged. Stage all changes?",
			`git add -A will stage ${plural(unstaged.length, "file")}:\n${describeFiles(unstaged)}`,
		);
		if (!ok) return undefined;
		await stageAll(git);
		files = await stagedFiles(git);
		unstaged = await unstagedPaths(git);
		if (files.length === 0) {
			ctx.ui.notify("/commit: nothing to commit after staging", "info");
			return undefined;
		}
	}
	if (files.some((file) => file.status === "U")) {
		ctx.ui.notify("/commit: resolve the merge conflicts first", "warning");
		return undefined;
	}
	return { git, files, unstaged };
}

interface Chosen {
	message: string;
	push?: PushTarget;
}

/** The TUI loop: the overlay reports an action until the user commits, pushes, or cancels. */
async function reviewInOverlay(
	ctx: ExtensionContext,
	state: StagedState & { branch: string },
	first: Suggestion,
	suggest: () => Promise<Suggestion>,
): Promise<Chosen | undefined> {
	let { message, notice } = first;
	for (;;) {
		const action = await openCommitView(ctx, {
			branch: state.branch,
			message,
			files: state.files,
			notice,
			unstagedCount: state.unstaged.length,
		});
		if (action.type === "cancel") return undefined;
		if (action.type === "edit") {
			const edited = await ctx.ui.editor(`Commit message · ${plural(state.files.length, "file")}`, message);
			if (edited !== undefined && edited.trim()) message = edited.trim();
		} else if (action.type === "regenerate") {
			({ message, notice } = await suggest());
		} else if (!subjectOf(message)) {
			notice = "The commit needs a message: press e to write one";
		} else if (action.type === "commit") {
			return { message };
		} else {
			const push = await confirmPush(ctx, state.git);
			if ("args" in push) return { message, push };
			if (push.notice) notice = push.notice;
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof GitError || error instanceof Error ? error.message : String(error);
}

/** Commits, then pushes when asked, and reports the result. */
async function commitAndPush(ctx: ExtensionContext, git: GitRunner, branch: string, chosen: Chosen): Promise<void> {
	let hash: string;
	try {
		hash = await withLoader(ctx, "Committing…", false, () => commitStaged(git, `${chosen.message}\n`));
	} catch (error) {
		ctx.ui.notify(`/commit: the commit failed: ${errorText(error)}. Your changes stay staged.`, "error");
		return;
	}
	const made = `${hash} ${subjectOf(chosen.message)}`;
	const push = chosen.push;
	if (!push) {
		ctx.ui.notify(`Committed on ${branch}: ${made}`, "info");
		return;
	}
	try {
		await withLoader(ctx, `Pushing to ${push.label}…`, true, (signal) => pushCommits(git, push, signal));
		ctx.ui.notify(`Committed and pushed to ${push.label}: ${made}`, "info");
	} catch (error) {
		ctx.ui.notify(`/commit: committed ${made}, but the push failed: ${errorText(error)}`, "error");
	}
}

export async function runCommit(ctx: ExtensionContext, options: CommitOptions = {}): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const state = await prepareStaged(ctx, options.makeRunner ?? createGitRunner);
		if (!state) return;
		const { git, files } = state;
		const complete = options.complete ?? (
			// SAFETY: the registry's complete() fulfills the narrowed seam; its
			// generic SDK types are erased only here.
			ctx.modelRegistry.complete.bind(ctx.modelRegistry) as unknown as MessageCompleteFn
		);
		const suggest = async (): Promise<Suggestion> => {
			const run = new AbortController();
			const timer = setTimeout(() => run.abort(), options.timeoutMs ?? 90_000);
			timer.unref?.();
			try {
				return await withLoader(ctx, "Writing a commit message…", true, (signal) => {
					signal.addEventListener("abort", () => run.abort(), { once: true });
					return suggestMessage({ git, files, model: ctx.model, complete, signal: run.signal });
				});
			} finally {
				clearTimeout(timer);
			}
		};

		const branch = await currentBranch(git);
		const first = await suggest();
		const chosen = ctx.mode === "tui"
			? await reviewInOverlay(ctx, { ...state, branch }, first, suggest)
			: await reviewInDialogs(ctx, git, first.message);
		if (chosen) await commitAndPush(ctx, git, branch, chosen);
	} catch (error) {
		ctx.ui.notify(`/commit: ${errorText(error)}`, "error");
	}
}

export function registerCommit(pi: ExtensionAPI, options: CommitOptions = {}): void {
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;
	pi.registerCommand("commit", {
		description: "Commit staged changes with an AI-suggested type(scope): description message (c commit · e edit · p commit and push)",
		handler: async (_args, ctx) => runCommit(ctx, options),
	});
}
