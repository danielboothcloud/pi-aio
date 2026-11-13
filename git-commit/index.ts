/**
 * /git — user-only commit helper. The session model suggests a commit plan
 * (files grouped into one or more `type(scope): description` commits) in one
 * isolated call; the user reviews, edits, and commits it in an overlay.
 *
 * Deliberately NOT an agent surface: it registers a command only, never a
 * tool, so the agent cannot commit through it. The model only suggests;
 * nothing enters the conversation context. Subagent children register
 * nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { plural } from "../ui/chrome.js";
import {
	commitFiles,
	createGitRunner,
	currentBranch,
	findRepoRoot,
	GitError,
	pendingOperation,
	recentSubjects,
	stageAll,
	stagedDiff,
	stagedFiles,
	unstagedPaths,
	type ChangedFile,
	type GitRunner,
} from "./git.js";
import {
	buildPlanPrompt,
	cleanMessage,
	isConventional,
	parsePlan,
	PLAN_SYSTEM_PROMPT,
	singleGroup,
	subjectOf,
	type CommitGroup,
} from "./plan.js";
import { CommitPlanView, type PlanAction, type PlanCursor } from "./view.js";

/** ctx.modelRegistry.complete() narrowed to what /git uses. */
export type PlanCompleteFn = (
	model: unknown,
	context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options?: { signal?: AbortSignal; maxTokens?: number },
) => Promise<{ content: Array<Record<string, unknown>>; stopReason: string; errorMessage?: string }>;

export interface Suggestion {
	groups: CommitGroup[];
	/** Why the plan is a fallback (no model, failed or unusable reply). */
	notice?: string;
}

export interface GitCommitOptions {
	/** Test seam: git runner factory for a repository root. */
	makeRunner?: (cwd: string) => GitRunner;
	/** Test seam: replaces ctx.modelRegistry.complete. */
	complete?: PlanCompleteFn;
	timeoutMs?: number;
}

function replyText(content: Array<Record<string, unknown>>): string {
	return content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

/** One isolated model call. Never throws: failures become a fallback plan with a notice. */
export async function suggestPlan(input: {
	git: GitRunner;
	files: readonly ChangedFile[];
	model: unknown;
	complete: PlanCompleteFn | undefined;
	signal: AbortSignal;
}): Promise<Suggestion> {
	if (!input.model || !input.complete) {
		return { groups: singleGroup(input.files), notice: "No model is active: write the message yourself" };
	}
	try {
		const [branch, diff, subjects] = await Promise.all([
			currentBranch(input.git),
			stagedDiff(input.git),
			recentSubjects(input.git),
		]);
		const response = await input.complete(input.model, {
			systemPrompt: PLAN_SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: buildPlanPrompt({ branch, files: input.files, diff, recentSubjects: subjects }),
				timestamp: Date.now(),
			}],
		}, { signal: input.signal, maxTokens: 4096 });
		if (input.signal.aborted || response.stopReason === "aborted") {
			return { groups: singleGroup(input.files), notice: "Suggestion cancelled" };
		}
		if (response.stopReason === "error") {
			const reason = cleanMessage(response.errorMessage ?? "").slice(0, 160);
			return { groups: singleGroup(input.files), notice: `Suggestion failed${reason ? `: ${reason}` : ""}` };
		}
		const groups = parsePlan(replyText(response.content), input.files);
		return groups
			? { groups }
			: { groups: singleGroup(input.files), notice: "The model reply was not a usable plan" };
	} catch (error) {
		const reason = cleanMessage(error instanceof Error ? error.message : String(error)).slice(0, 160);
		return { groups: singleGroup(input.files), notice: `Suggestion failed${reason ? `: ${reason}` : ""}` };
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

async function openPlanView(
	ctx: ExtensionContext,
	state: { branch: string; groups: CommitGroup[]; files: readonly ChangedFile[]; cursor?: PlanCursor; notice?: string; unstagedCount: number },
): Promise<PlanAction> {
	return ctx.ui.custom<PlanAction>(
		(tui, theme, _keys, done) =>
			new CommitPlanView({
				theme,
				...state,
				requestRender: () => tui.requestRender(),
				getMaxRows: () => Math.floor(tui.terminal.rows * 0.9),
				done,
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", margin: 1, maxHeight: "90%", minWidth: 60, width: "85%" },
		},
	);
}

/** Non-TUI (RPC) review: one editor dialog per group. Undefined = cancel. */
async function reviewInDialogs(ctx: ExtensionContext, groups: CommitGroup[]): Promise<CommitGroup[] | undefined> {
	const out: CommitGroup[] = [];
	for (const [index, group] of groups.entries()) {
		const edited = await ctx.ui.editor(
			`Commit ${index + 1}/${groups.length} (empty message skips it): ${group.files.join(", ")}`,
			group.message,
		);
		if (edited === undefined) return undefined;
		const message = edited.trim();
		out.push({ ...group, message: message || group.message, include: message.length > 0 });
	}
	return out;
}

async function confirmCommit(ctx: ExtensionContext, groups: readonly CommitGroup[]): Promise<boolean> {
	const invalid = groups.filter((group) => !isConventional(group.message));
	const empty = groups.some((group) => !subjectOf(group.message));
	if (empty) {
		ctx.ui.notify("Every commit needs a message", "warning");
		return false;
	}
	if (invalid.length === 0) return true;
	return ctx.ui.confirm(
		"Commit anyway?",
		`${plural(invalid.length, "message")} do not match type(scope): description:\n${
			invalid.map((group) => `  ${subjectOf(group.message)}`).join("\n")
		}`,
	);
}

async function commitGroups(
	git: GitRunner,
	groups: readonly CommitGroup[],
	files: readonly ChangedFile[],
): Promise<{ done: string[]; error?: string }> {
	const byPath = new Map(files.map((file) => [file.path, file]));
	const done: string[] = [];
	for (const group of groups) {
		const groupFiles = group.files.flatMap((path) => byPath.get(path) ?? []);
		try {
			const hash = await commitFiles(git, groupFiles, `${group.message.trim()}\n`);
			done.push(`${hash} ${subjectOf(group.message)}`);
		} catch (error) {
			const reason = error instanceof GitError ? error.message : String(error);
			return { done, error: `Commit ${done.length + 1} failed (${subjectOf(group.message)}): ${reason}` };
		}
	}
	return { done };
}

export async function runGitCommit(ctx: ExtensionContext, options: GitCommitOptions = {}): Promise<void> {
	if (!ctx.hasUI) return;
	const makeRunner = options.makeRunner ?? createGitRunner;
	const root = await findRepoRoot(ctx.cwd, makeRunner);
	if (!root) {
		ctx.ui.notify("/git: the current directory is not inside a git repository", "warning");
		return;
	}
	const git = makeRunner(root);
	try {
		const pending = await pendingOperation(git);
		if (pending) {
			ctx.ui.notify(`/git: finish ${pending} with plain git first`, "warning");
			return;
		}

		let files = await stagedFiles(git);
		let unstaged = await unstagedPaths(git);
		if (files.length === 0) {
			if (unstaged.length === 0) {
				ctx.ui.notify("/git: nothing to commit, the working tree is clean", "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Nothing is staged. Stage all changes?",
				`git add -A will stage ${plural(unstaged.length, "file")}:\n${describeFiles(unstaged)}`,
			);
			if (!ok) return;
			await stageAll(git);
			files = await stagedFiles(git);
			unstaged = await unstagedPaths(git);
			if (files.length === 0) {
				ctx.ui.notify("/git: nothing to commit after staging", "info");
				return;
			}
		}
		if (files.some((file) => file.status === "U")) {
			ctx.ui.notify("/git: resolve the merge conflicts first", "warning");
			return;
		}

		const complete = options.complete ?? (
			// SAFETY: the registry's complete() fulfills the narrowed seam; its
			// generic SDK types are erased only here.
			ctx.modelRegistry.complete.bind(ctx.modelRegistry) as unknown as PlanCompleteFn
		);
		const suggest = async (): Promise<Suggestion> => {
			const run = new AbortController();
			const timer = setTimeout(() => run.abort(), options.timeoutMs ?? 90_000);
			timer.unref?.();
			try {
				return await withLoader(ctx, "Suggesting commits…", true, (signal) => {
					signal.addEventListener("abort", () => run.abort(), { once: true });
					return suggestPlan({ git, files, model: ctx.model, complete, signal: run.signal });
				});
			} finally {
				clearTimeout(timer);
			}
		};

		const branch = await currentBranch(git);
		let suggestion = await suggest();
		let groups = suggestion.groups;
		let notice = suggestion.notice;
		let cursor: PlanCursor | undefined;
		let chosen: CommitGroup[] | undefined;

		if (ctx.mode !== "tui") {
			const reviewed = await reviewInDialogs(ctx, groups);
			chosen = reviewed?.filter((group) => group.include);
			if (!chosen || chosen.length === 0 || !(await confirmCommit(ctx, chosen))) return;
		}
		while (!chosen) {
			const action = await openPlanView(ctx, { branch, groups, files, cursor, notice, unstagedCount: unstaged.length });
			if (action.type === "cancel") return;
			groups = action.groups;
			if (action.type === "edit") {
				cursor = action.cursor;
				const group = groups[cursor.group];
				if (!group) continue;
				const edited = await ctx.ui.editor(`Commit message · ${plural(group.files.length, "file")}`, group.message);
				if (edited !== undefined && edited.trim()) groups[cursor.group] = { ...group, message: edited.trim() };
			} else if (action.type === "regenerate") {
				suggestion = await suggest();
				groups = suggestion.groups;
				notice = suggestion.notice;
				cursor = undefined;
			} else {
				const included = groups.filter((group) => group.include);
				if (included.length === 0) {
					notice = "Every commit is skipped: press space to include one";
					continue;
				}
				if (await confirmCommit(ctx, included)) chosen = included;
			}
		}

		const result = await withLoader(ctx, `Committing ${plural(chosen.length, "commit")}…`, false, () =>
			commitGroups(git, chosen, files));
		if (result.done.length > 0) {
			ctx.ui.notify(`Committed on ${branch}:\n${result.done.map((line) => `  ${line}`).join("\n")}`, "info");
		}
		if (result.error) ctx.ui.notify(`/git: ${result.error}. Later commits were not made; their files stay staged.`, "error");
	} catch (error) {
		ctx.ui.notify(`/git: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export function registerGitCommit(pi: ExtensionAPI, options: GitCommitOptions = {}): void {
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;
	pi.registerCommand("git", {
		description: "Commit staged changes: the AI suggests commit groups and type(scope): description messages for you to edit",
		handler: async (_args, ctx) => runGitCommit(ctx, options),
	});
}
