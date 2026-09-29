/**
 * AIO's proprietary minimalist editor frame — registration and lifecycle.
 * Replaces the bundled pi-zentui integration: AIO owns the editor factory,
 * wraps whatever editor is installed (QueueEditor chain), and renders it
 * inside the minimalist frame with live metadata.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildCostLabel,
	getUsageTotals,
	invalidateUsageTotalsCache,
	resolveContextUsage,
} from "./format.js";
import { readGitFrameStatus, type GitFrameStatus } from "./git.js";
import {
	MinimalistFrameEditor,
	type FrameBaseEditor,
} from "./editor.js";
import {
	DEFAULT_FRAME_STYLE,
	type FrameMetadata,
	type FrameStyle,
} from "./render.js";
import {
	FRAME_CAPABILITY_EVENT,
	FRAME_CAPABILITY_VERSION,
	getQueuePanelLines,
	isFrameEditorFactory,
} from "./protocol.js";

const FRAME_EDITOR_FACTORY_SYMBOL = Symbol.for("aio.frame-editor-factory");
const GIT_REFRESH_INTERVAL_MS = 10_000;

export interface FrameIntegrationDependencies {
	style?: Partial<FrameStyle>;
	/** Test seam: initial git status instead of spawning git. */
	readGit?: (cwd: string) => Promise<GitFrameStatus>;
}

type FrameEditorFactory = ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) & {
	[FRAME_EDITOR_FACTORY_SYMBOL]?: true;
};

export function registerFrameEditor(pi: ExtensionAPI, dependencies: FrameIntegrationDependencies = {}): void {
	const style: FrameStyle = { ...DEFAULT_FRAME_STYLE, ...dependencies.style };
	const readGit = dependencies.readGit ?? (async (cwd: string) => {
		const result = await readGitFrameStatus(cwd);
		return result.kind === "ok" ? result.status : emptyStatus();
	});

	// Synchronous capability probe answered on the shared event bus — only
	// once a TUI session actually installed the frame, so non-TUI and
	// not-yet-started sessions report unsupported.
	pi.events.on(FRAME_CAPABILITY_EVENT, (value: unknown) => {
		if (!probeActive || value === null || typeof value !== "object") return;
		const capability = value as { supported?: boolean; active?: boolean; version?: number };
		capability.supported = true;
		capability.active = true;
		capability.version = FRAME_CAPABILITY_VERSION;
	});

	let requestRender: (() => void) | undefined;
	let currentCtx: ExtensionContext | null = null;
	let probeActive = false;
	let gitStatus: GitFrameStatus = emptyStatus();
	let agentStartEpoch: number | undefined;
	let agentActive = false;
	let gitTimer: ReturnType<typeof setInterval> | undefined;

	function emptyStatus(): GitFrameStatus {
		return { branch: undefined, dirty: false, ahead: 0, behind: 0 };
	}

	function getMetadata(): FrameMetadata {
		const ctx = currentCtx;
		if (!ctx) return { cwd: "" };
		const totals = getUsageTotals(ctx);
		const context = resolveContextUsage(ctx);
		return {
			cwd: ctx.cwd,
			projectRoot: undefined,
			branch: gitStatus.branch,
			dirty: gitStatus.dirty,
			ahead: gitStatus.ahead,
			behind: gitStatus.behind,
			costLabel: buildCostLabel(totals),
			modelLabel: ctx.model?.id ?? "no-model",
			thinkingLevel: safeThinkingLevel(pi),
			contextPercent: context.percent,
			sessionName: ctx.sessionManager.getSessionName() ?? "",
			agentDurationMs: agentStartEpoch !== undefined ? Date.now() - agentStartEpoch : undefined,
			agentActive,
		};
	}

	async function refreshGit(): Promise<void> {
		const ctx = currentCtx;
		if (!ctx) return;
		try {
			gitStatus = await readGit(ctx.cwd);
		} catch {
			// Best-effort; keep the previous snapshot.
		}
		requestRender?.();
	}

	function startGitTimer(): void {
		stopGitTimer();
		gitTimer = setInterval(() => void refreshGit(), GIT_REFRESH_INTERVAL_MS);
		// Never hold the process open for a cosmetic refresh.
		gitTimer.unref?.();
	}

	function stopGitTimer(): void {
		if (gitTimer !== undefined) {
			clearInterval(gitTimer);
			gitTimer = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		currentCtx = ctx;
		gitStatus = emptyStatus();
		agentStartEpoch = undefined;
		agentActive = false;
		invalidateUsageTotalsCache();

		// AIO registers after queue, so the current factory is the QueueEditor
		// chain. Never displace a standalone Zentui install (symbol check; the
		// dependency is gone from AIO but a globally installed package may still
		// have claimed the editor). With no factory at all Pi uses its built-in
		// editor, which we cannot wrap — it stays native.
		const existingFactory = ctx.ui.getEditorComponent?.();
		if (
			!existingFactory ||
			isFrameEditorFactory(existingFactory) ||
			(existingFactory as Record<symbol, unknown>)[Symbol.for("pi-zentui.editor-factory")] === true
		) {
			return;
		}

		const previousText = ctx.ui.getEditorText?.() ?? "";
		const factory = ((tui: unknown, theme: unknown, keybindings: unknown) => {
			// SAFETY: the predecessor factory returns an EditorComponent; cast it
			// to FrameBaseEditor because the frame's optional-extension surface
			// (focused/onEscape/autocompleteList, …) is duck-typed at runtime.
			const base = (
				existingFactory as (t: unknown, th: unknown, k: unknown) => unknown
			)(tui, theme, keybindings) as FrameBaseEditor;
			const editor = new MinimalistFrameEditor(base, {
				uiTheme: ctx.ui.theme as never,
				style,
				getMetadata,
				getPanelLines: () => getQueuePanelLines(),
			});
			// SAFETY: Pi passes a TUI exposing requestRender(). The editor's
			// repaint must go straight to the TUI — never back through the
			// registrar's requestRender, which points at notifyChanged and
			// would recurse infinitely (notifyChanged -> requestRender ->
			// notifyChanged). Older hosts without the method degrade to a no-op.
			const tuiLike = tui as { requestRender?: () => void } | undefined;
			editor.setRequestRender(() => {
				if (typeof tuiLike?.requestRender === "function") tuiLike.requestRender();
			});
			requestRender = () => editor.notifyChanged();
			return editor;
		}) as FrameEditorFactory;
		factory[FRAME_EDITOR_FACTORY_SYMBOL] = true;

		ctx.ui.setEditorComponent(factory as never);
		if (previousText.trim().length > 0) ctx.ui.setEditorText(previousText);
		void refreshGit();
		startGitTimer();
		probeActive = true;
	});

	pi.on("session_shutdown", async () => {
		stopGitTimer();
		currentCtx = null;
		probeActive = false;
		requestRender = undefined;
		agentStartEpoch = undefined;
		agentActive = false;
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		requestRender?.();
	});

	pi.on("agent_start", async () => {
		agentStartEpoch = Date.now();
		agentActive = true;
		void refreshGit();
		requestRender?.();
	});

	pi.on("agent_end", async () => {
		agentActive = false;
		invalidateUsageTotalsCache();
		void refreshGit();
		requestRender?.();
	});

	pi.on("message_end", async () => {
		requestRender?.();
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (ctx?.hasUI) currentCtx = ctx;
		invalidateUsageTotalsCache();
		void refreshGit();
	});

}

function safeThinkingLevel(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getThinkingLevel();
	} catch {
		return undefined;
	}
}
