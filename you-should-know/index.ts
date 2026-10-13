/**
 * you-should-know (YSK) — registrar.
 *
 * The dual-agent shadow auditor wired into Pi:
 *
 *  - Trigger: `tool_result` for successful file-mutating tools (`write`,
 *    `edit`, `apply_patch` by default — the diff-tools surface; configurable
 *    via `/ysk tools`). Error results, nested calls (parentToolCallId), and
 *    excluded paths never start an audit.
 *  - Engine: one bounded, isolated `ctx.modelRegistry.complete()` call per
 *    debounced burst (never per edit). The primary conversation is never
 *    touched: findings are custom entries, excluded from LLM context.
 *  - Silence contract: no findings ⇒ nothing appended, no toast, no noise.
 *  - Subagent children: a child ran by the `subagent` tool audits its own
 *    writes (same settings file, so parent-off ⇒ child-off), mirrors findings
 *    into a sidecar beside its runner-managed session file, and the parent
 *    surfaces (and deletes) them when the `subagent` tool result arrives —
 *    through the same box, status pill, and critical toast as local audits.
 *  - Control: `/ysk status|enable|disable|model|severity|tools|audit`,
 *    persisted in the global settings file (`aio-you-should-know.settings.json`,
 *    goal-settings contract). Off by default; once enabled it stays enabled
 *    across sessions and in children.
 *
 * The registrar owns no tool and gates nothing; registration order in
 * index.ts is not load-bearing (it is registered late, before yaml-hooks,
 * which must stay last).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { FrameMetadata } from "../frame/render.js";
import {
	probeFrameEditor,
	requestFrameRepaint,
	setFrameMetadataContributor,
} from "../frame/protocol.js";

import {
	appendChildAuditRecord,
	buildAuditPrompt,
	childProcessInfo,
	childSessionFile,
	createFindingDedupe,
	currentTaskDigest,
	extractChangedFiles,
	isExcluded,
	performAudit,
	readAndDropSidecar,
	readYskSettings,
	saveYskSettings,
	SEVERITY_ORDER,
	type CompleteFn,
	type PendingChange,
	type Severity,
	type YskSettings,
} from "./auditor.js";
import {
	criticalToastText,
	frameAuditingMeta,
	frameIdleMeta,
	registerShouldKnowRenderer,
	statusAuditingLine,
	statusOnLine,
	YSK_ENTRY_TYPE,
	YSK_STATUS_KEY,
	type YskEntryData,
} from "./display.js";

/** The subagents tool whose results carry `details.children[].sessionFile`. */
const SUBAGENT_TOOL_NAME = "subagent";

/** Frame metadata slot key while a minimalist frame owns the visual surface. */
const FRAME_CONTRIBUTOR_KEY = "you-should-know";

/** Model resolution against the registry (pin → registry, else session model). */
type SessionModel = NonNullable<ExtensionContext["model"]>;

interface ModelRegistryLike {
	find(provider: string, modelId: string): SessionModel | undefined;
	getModelsOfType(type: "chat", provider?: string): SessionModel[];
	getAvailableOfType(type: "chat"): Promise<readonly SessionModel[]>;
}

/**
 * Resolves a pin spec against the registry and the session's enabled set.
 * A provider prefix splits on the FIRST slash, but model ids may themselves
 * contain slashes (e.g. "synthetic/hf:zai-org/GLM-5.3" and the bare
 * "hf:zai-org/GLM-5.3" must both resolve), so the whole string is also tried
 * as a bare id through the scoped set and the catalogue.
 */
function lookupModelSpec(ctx: ExtensionContext, spec: string): SessionModel | undefined {
	const registry = registryFor(ctx);
	const slash = spec.indexOf("/");
	const split = slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : undefined;
	if (split) {
		const direct = registry.find(split.provider, split.id);
		if (direct) return direct;
	}
	const scoped = ctx.scopedModels ?? [];
	const scopedFull = scoped.find((entry) => entry.model?.id === spec)?.model as SessionModel | undefined;
	if (scopedFull) return scopedFull;
	if (split) {
		const scopedSplit = scoped.find(
			(entry) => entry.model?.provider === split.provider && entry.model?.id === split.id,
		)?.model as SessionModel | undefined;
		if (scopedSplit) return scopedSplit;
	}
	return registry.getModelsOfType("chat").find((m) =>
		split ? (m.provider === split.provider && m.id === split.id) || m.id === spec : m.id === spec,
	);
}

/**
 * Models offered for `/ysk model`: the session's scoped (enabled) models
 * first; otherwise models with working credentials; the full catalogue only
 * as a last resort.
 */
async function enabledModelList(ctx: ExtensionContext): Promise<SessionModel[]> {
	const scoped = ctx.scopedModels ?? [];
	if (scoped.length > 0) {
		return scoped.map((entry) => entry.model as SessionModel);
	}
	try {
		const available = await registryFor(ctx).getAvailableOfType("chat");
		if (available && available.length > 0) return [...available];
	} catch {
		// Availability probing must never break the command.
	}
	return registryFor(ctx).getModelsOfType("chat");
}

function registryFor(ctx: ExtensionContext): ModelRegistryLike {
	// SAFETY: mapped slice of the registry surface; the class's generic model
	// types are intentionally erased to the session-model type here so callers
	// stay provider-neutral.
	return ctx.modelRegistry as unknown as ModelRegistryLike;
}

function resolveAuditModel(
	ctx: ExtensionContext,
	settings: YskSettings,
): { model: SessionModel | undefined; description: string } {
	if (settings.model) {
		const resolved = lookupModelSpec(ctx, settings.model);
		if (resolved) return { model: resolved, description: `${resolved.provider}/${resolved.id}` };
		return { model: undefined, description: settings.model };
	}
	const session = ctx.model;
	if (session) return { model: session, description: `${session.provider}/${session.id}` };
	return { model: undefined, description: "(no model)" };
}

interface ToolResultShape {
	toolName: string;
	isError: boolean;
	parentToolCallId?: string;
	input: Record<string, unknown>;
	/** The subagent tool's publicRun details; other tools carry their own. */
	details?: unknown;
}

const SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "enable", description: "Turn the shadow auditor on (persisted)" },
	{ name: "disable", description: "Turn it off (persisted; children stop too)" },
	{ name: "status", description: "Show settings and the audit model" },
	{ name: "model", description: "Pin the sub-agent model: /ysk model <provider/id> | off" },
	{ name: "severity", description: "Minimum severity shown: info | warning | critical" },
	{ name: "tools", description: "Which tools are audited, comma-separated" },
	{ name: "audit", description: "Manually audit one file: /ysk audit <path>" },
];

export function registerYouShouldKnow(pi: ExtensionAPI): void {
	// Custom entries only ever render for humans, in parents and children.
	registerShouldKnowRenderer(pi);

	const child = childProcessInfo();
	// Latest live context for sync lookups (command autocomplete); event
	// handlers only ever carry the base ExtensionContext.
	let lastCtx: ExtensionContext | undefined;

	// NOTE: pkcs re-refreshed per event; a flip in the settings file applies
	const settings = (): YskSettings => readYskSettings();

	const state = {
		pending: new Map<string, PendingChange>(),
		timer: null as ReturnType<typeof setTimeout> | null,
		inFlight: false,
		queuedRun: false,
		abort: new AbortController(),
		dedupe: createFindingDedupe(),
		failureLatched: false,
	};

	// =====================================================================
	// Status pill (never in children; cleared whenever disabled)
	// =====================================================================

	// Frame contribution is live: the closure re-reads settings and the pinned
	// model on every frame render, so a flip is reflected without re-registering.
	function frameContribution(auditing: number | null): () => Partial<FrameMetadata> {
		return () => {
			const current = settings();
			if (!current.enabled) return {};
			if (auditing !== null) {
				return { ysk: frameAuditingMeta(auditing) };
			}
			const pinnedId = current.model ? current.model.split("/").pop() : undefined;
			return { ysk: frameIdleMeta(pinnedId) };
		};
	}

	function syncStatus(ctx: ExtensionContext, auditing: number | null = null): void {
		if (child.isChild) return;
		const current = settings();
		// While the minimalist frame owns the visual surface, state embeds in
		// its border via the metadata protocol and the footer stays quiet;
		// without the frame, the status-line pill carries the same texts.
		if (probeFrameEditor(pi).supported) {
			setFrameMetadataContributor(
				FRAME_CONTRIBUTOR_KEY,
				current.enabled ? frameContribution(auditing) : undefined,
			);
			requestFrameRepaint();
			if (ctx.hasUI) ctx.ui.setStatus(YSK_STATUS_KEY, undefined);
			return;
		}
		setFrameMetadataContributor(FRAME_CONTRIBUTOR_KEY, undefined);
		if (!ctx.hasUI) return;
		if (!current.enabled) {
			ctx.ui.setStatus(YSK_STATUS_KEY, undefined);
			return;
		}
		if (auditing !== null) {
			ctx.ui.setStatus(YSK_STATUS_KEY, statusAuditingLine(auditing));
			return;
		}
		const resolved = resolveAuditModel(ctx, current);
		ctx.ui.setStatus(YSK_STATUS_KEY, statusOnLine(resolved.model ? resolved.description : undefined));
	}

	function failureNotice(ctx: ExtensionContext, message: string): void {
		if (state.failureLatched || child.isChild || !ctx.hasUI) return;
		state.failureLatched = true;
		ctx.ui.notify(`You Should Know: ${message} Further audit problems stay silent until settings change.`, "warning");
	}

	// =====================================================================
	// One audit batch over the injected registry (shared by parent and child)
	// =====================================================================

	async function runBatch(batch: PendingChange[], ctx: ExtensionContext): Promise<void> {
		let current: YskSettings | undefined;
		try {
			current = settings();
			if (!current.enabled || batch.length === 0) return;

			const { model, description } = resolveAuditModel(ctx, current);
			if (!model) {
				failureNotice(
					ctx,
					description === "(no model)"
						? "no model is available for audits; skipping them."
						: `configured audit model "${description}" was not found; skipping audits. Fix with /ysk model <provider/id>.`,
				);
				return;
			}

			// SAFETY: the registry's complete() fulfills the injected audit
			// signature (content/stopReason/errorMessage/usage); its generic
			// SDK types are erased at this single seam.
			const complete = ctx.modelRegistry.complete.bind(ctx.modelRegistry) as unknown as CompleteFn;

			const taskDigest = currentTaskDigest(ctx.sessionManager.getBranch());
			const prompt = await buildAuditPrompt(ctx.cwd, batch, current, taskDigest);

			syncStatus(ctx, batch.length);
			const outcome = await performAudit({
				settings: current,
				model,
				prompt,
				complete,
				signal: state.abort.signal,
			});

			if (outcome.error) {
				failureNotice(ctx, `the sub-agent call failed (${outcome.error}).`);
				return;
			}

			// Silence contract: nothing shown when nothing was found.
			const { shown } = state.dedupe.filterRecent(outcome.findings);
			if (shown.length === 0) return;

			const entryData: YskEntryData = {
				model: description,
				origin: null,
				files: batch.map((change) => change.displayPath),
				findings: shown,
				shown: shown.length,
				raised: outcome.raised,
				minSeverity: current.minSeverity,
				usage: outcome.usage,
				latencyMs: outcome.latencyMs,
				timestamp: Date.now(),
			};
			pi.appendEntry(YSK_ENTRY_TYPE, entryData);

			// Child runs mirror the finding next to their runner-managed session
			// file; the parent consumes it when the subagent result arrives.
			if (child.isChild) {
				const sessionFile = childSessionFile();
				if (sessionFile) {
					await appendChildAuditRecord(
						{
							agent: child.agent,
							runId: child.runId,
							auditAt: Date.now(),
							model: description,
							files: entryData.files,
							findings: shown,
							usage: outcome.usage,
							latencyMs: outcome.latencyMs,
						},
						sessionFile,
					);
				}
			}

			const toast = criticalToastText(entryData);
			if (toast && ctx.hasUI) ctx.ui.notify(toast, "error");
		} catch {
			// A background auditor must never break the tool pipeline.
		} finally {
			// Status only; re-flushing is owned by flushPending so it happens
			// strictly after inFlight clears.
			if (!child.isChild) syncStatus(ctx);
		}
	}

	function flushPending(ctx: ExtensionContext): void {
		if (state.inFlight) {
			state.queuedRun = true;
			return;
		}
		if (state.pending.size === 0) return;
		const current = settings();
		if (!current.enabled) return;
		const all = [...state.pending.values()];
		state.pending.clear();
		const batch = all.slice(0, current.maxFilesPerAudit);
		const overflow = all.slice(current.maxFilesPerAudit);
		for (const item of overflow) state.pending.set(item.absPath, item);
		if (overflow.length > 0) state.queuedRun = true;
		state.inFlight = true;
		void runBatch(batch, ctx).finally(() => {
			state.inFlight = false;
			if (state.queuedRun) {
				state.queuedRun = false;
				flushPending(ctx);
			}
		});
	}

	// =====================================================================
	// Subagent sidecar surfacing (parent only)
	// =====================================================================

	async function surfaceChildFindings(details: unknown, ctx: ExtensionContext): Promise<void> {
		try {
			const children =
				(details as { children?: Array<{ sessionFile?: string }> } | undefined)?.children ?? [];
			for (const childEntry of children) {
				const sessionFile = childEntry?.sessionFile;
				if (typeof sessionFile !== "string" || !sessionFile) continue;
				const records = await readAndDropSidecar(sessionFile);
				for (const record of records) {
					if (record.findings.length === 0) continue;
					const { shown } = state.dedupe.filterRecent(record.findings);
					if (shown.length === 0) continue;
					const entryData: YskEntryData = {
						model: record.model,
						origin: `subagent '${record.agent ?? "child"}'`,
						files: record.files,
						findings: shown,
						shown: shown.length,
						raised: record.findings.length,
						minSeverity: settings().minSeverity,
						usage: record.usage,
						latencyMs: record.latencyMs,
						timestamp: record.auditAt,
					};
					pi.appendEntry(YSK_ENTRY_TYPE, entryData);
					const toast = criticalToastText(entryData);
					if (toast && ctx.hasUI) ctx.ui.notify(toast, "error");
				}
			}
		} catch {
			// Surfacing is best-effort; leftover sidecars sit beside their child
			// session for manual inspection.
		}
	}

	// =====================================================================
	// tool_result entry point (synchronous enqueue only — never blocks the pipeline)
	// =====================================================================

	function onToolResult(event: ToolResultShape, ctx: ExtensionContext): void {
		const current = settings();
		if (!current.enabled) return;
		if (event.isError) return; // successes only
		if (event.parentToolCallId) return; // nested calls (codemode etc.)

		if (event.toolName === SUBAGENT_TOOL_NAME) {
			if (!child.isChild) void surfaceChildFindings(event.details, ctx);
			return;
		}

		if (!current.auditTools.includes(event.toolName)) return;
		const targets = extractChangedFiles(event.toolName, event.input);
		if (!targets) return;

		let scheduled = 0;
		for (const target of targets) {
			const absPath = path.resolve(ctx.cwd, target.rawPath);
			// Relative display when possible; an absolute input shows project-relative.
			const displayPath = path.isAbsolute(target.rawPath)
				? path.relative(ctx.cwd, absPath) || target.rawPath
				: target.rawPath;
			if (isExcluded(displayPath, current.exclude)) continue;
			state.pending.set(absPath, {
				absPath,
				displayPath,
				toolName: event.toolName,
				changeDescription: target.changeDescription,
				capturedAt: Date.now(),
			});
			scheduled++;
		}
		if (scheduled === 0) return;

		// Children flush on the next tick (they can exit right after writing);
		// parents coalesce bursts within the configured window.
		const delay = child.isChild ? 0 : current.batchWindowMs;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = null;
			flushPending(ctx);
		}, delay);
	}

	// =====================================================================
	// Events
	// =====================================================================

	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		try {
			onToolResult(event, ctx);
		} catch {
			// Fail-closed: a broken audit must never break the pipeline.
		}
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		syncStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		lastCtx = ctx;
		syncStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		setFrameMetadataContributor(FRAME_CONTRIBUTOR_KEY, undefined);
		state.abort.abort();
		state.abort = new AbortController();
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		state.pending.clear();
		state.inFlight = false;
		state.queuedRun = false;
	});

	// =====================================================================
	// /ysk command (parents only; children run headless)
	// =====================================================================

	if (!child.isChild) {
		pi.registerCommand("ysk", {
			description: "You Should Know (Pi Edition) — dual-agent shadow auditor",
			getArgumentCompletions: async (argumentPrefix: string) => {
				const trimmed = argumentPrefix ?? "";
				const parts = trimmed.split(/\s+/);
				const head = parts[0] ?? "";
				const tail = parts.slice(1).join(" ");

				if (head === "model" && lastCtx) {
					const models = await enabledModelList(lastCtx);
					return models
						.map((m) => ({
							value: `${m.provider}/${m.id}`,
							label: m.id,
							description: m.provider,
						}))
						.filter((item) => item.value.startsWith(tail))
						.slice(0, 30);
				}
				if (head === "severity") {
					return SEVERITY_ORDER.filter((s) => s.startsWith(tail)).map((s) => ({
						value: s,
						label: s,
						description: s === "info" ? "show everything" : s === "warning" ? "default" : "critical only",
					}));
				}
				if (head === "tools") {
					const names = new Set<string>([...settings().auditTools, "write", "edit", "apply_patch", "bash"]);
					try {
						for (const tool of pi.getAllTools()) names.add(tool.name);
					} catch {
						// Tool info is optional flavor for completions.
					}
					return [...names]
						.filter((n) => n.startsWith(tail))
						.sort()
						.map((n) => ({ value: n, label: n, description: "audit this tool" }));
				}
				return SUBCOMMANDS.filter((sub) => sub.name.startsWith(trimmed)).map((sub) => ({
					value: sub.name,
					label: sub.name,
					description: sub.description,
				}));
			},
			handler: async (args: string, ctx) => {
				const parts = (args ?? "").trim().split(/\s+/);
				const sub = parts[0] ?? "";
				const body = parts.slice(1).join(" ").trim();
				const current = settings();

				switch (sub) {
					case "": {
						const pinned = current.model ?? "(session model)";
						ctx.ui.notify(
							[
								`You Should Know: ${current.enabled ? "enabled" : "disabled"} · sub-agent: ${pinned}`,
								`audited tools: ${current.auditTools.join(", ")} · min severity: ${current.minSeverity}`,
								`commands: ${SUBCOMMANDS.map((cmd) => cmd.name).join(", ")}`,
							].join("\n"),
							"info",
						);
						return;
					}
					case "enable": {
						saveYskSettings({ enabled: true });
						state.failureLatched = false;
						syncStatus(ctx);
						ctx.ui.notify("You Should Know: enabled — file changes are audited in the background.", "info");
						return;
					}
					case "disable": {
						saveYskSettings({ enabled: false });
						state.abort.abort();
						state.abort = new AbortController();
						state.pending.clear();
						if (state.timer) {
							clearTimeout(state.timer);
							state.timer = null;
						}
						syncStatus(ctx);
						ctx.ui.notify(
							"You Should Know: disabled — subagent children stop auditing too.",
							"info",
						);
						return;
					}
					case "model": {
						if (!body) {
							ctx.ui.notify(
								`You Should Know sub-agent model: ${current.model ?? `${ctx.model ? `${ctx.model.provider}/${ctx.model.id} (session)` : "(none)"}`}\nSet with /ysk model <provider/id>; /ysk model off follows the session model.`,
								"info",
							);
							return;
						}
						if (body === "off") {
							saveYskSettings({ model: null });
							state.failureLatched = false;
							syncStatus(ctx);
							ctx.ui.notify("You Should Know: sub-agent now follows the session model.", "info");
							return;
						}
						const resolved = resolveAuditModel(ctx, { ...current, model: body });
						if (!resolved.model) {
							ctx.ui.notify(`You Should Know: model "${body}" not found. Check /model for available models.`, "error");
							return;
						}
						saveYskSettings({ model: resolved.description });
						state.failureLatched = false;
						syncStatus(ctx);
						ctx.ui.notify(`You Should Know: sub-agent model set to ${resolved.description}.`, "info");
						return;
					}
					case "severity": {
						if (!SEVERITY_ORDER.includes(body as Severity)) {
							ctx.ui.notify(`You Should Know: severity must be one of ${SEVERITY_ORDER.join(" | ")}.`, "error");
							return;
						}
						saveYskSettings({ minSeverity: body as Severity });
						ctx.ui.notify(`You Should Know: minimum severity is now ${body}.`, "info");
						return;
					}
					case "tools": {
						const tools = body
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean);
						if (tools.length === 0) {
							ctx.ui.notify(`You Should Know: current audit tools: ${current.auditTools.join(", ")}`, "info");
							return;
						}
						saveYskSettings({ auditTools: tools });
						ctx.ui.notify(`You Should Know: auditing tools: ${tools.join(", ")}`, "info");
						return;
					}
					case "audit": {
						if (!body) {
							ctx.ui.notify("Usage: /ysk audit <path>", "error");
							return;
						}
						const absPath = path.resolve(ctx.cwd, body);
						if (!existsSync(absPath)) {
							ctx.ui.notify(`You Should Know: no such file: ${body}`, "error");
							return;
						}
						state.pending.set(absPath, {
							absPath,
							displayPath: path.relative(ctx.cwd, absPath) || absPath,
							toolName: "manual",
							changeDescription: "manual audit requested via /ysk audit",
							capturedAt: Date.now(),
						});
						flushPending(ctx);
						return;
					}
					default: {
						ctx.ui.notify(
							`You Should Know: unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map((cmd) => cmd.name).join(", ")}.`,
							"warning",
						);
					}
				}
			},
		});
	}
}
