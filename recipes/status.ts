import type { ExtensionAPI, ExtensionContext, SourceInfo } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { chromeFrameRow, chromeFrameRule, type ChromeTheme } from "../ui/chrome.js";
import { ACTIVE_RECIPE_ENV, RECIPE_FLAG, RECIPE_STAGE_ENV, parseModelSpec } from "./config.js";
import { findRecipeModel, recipeRuntime } from "./apply.js";

/** Custom session entries never enter model context or start a model call. */
export const RECIPE_STATUS_ENTRY = "recipe-status-report";

export interface ObservedExtensionSource {
	path: string;
	source: string;
	commands: string[];
	tools: string[];
}

/** An allowlisted runtime snapshot: no credentials, headers, or full settings. */
export interface RecipeStatusReport {
	version: 1;
	capturedAt: string;
	recipe: string | null;
	selection: string | null;
	configSource: string | null;
	configured: {
		model: string | null;
		thinking: string | null;
		models: string[] | null;
		extensions: string[] | null;
	};
	runtime: {
		model: string | null;
		api: string | null;
		thinking: string;
		modelMatchesRecipe: boolean | null;
		scopeMode: "scoped" | "all";
		scopedModels: string[];
		activeTools: string[];
		registeredProviders: string[] | null;
	};
	launch: {
		recipe: string | null;
		bridged: boolean;
		extensionPolicy: "explicit-only" | "configured-plus-explicit";
		extensions: string[];
		models: string[] | null;
	};
	/** Evidence from actual registrations, NOT a complete loaded-extension inventory. */
	observedExtensionSources: ObservedExtensionSource[];
	notes: string[];
}

/** Avoid terminal control characters and credentials embedded in source URLs. */
function safeText(value: string): string {
	let text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	const scheme = text.indexOf("://");
	let authorityStart = -1;
	if (scheme >= 0) authorityStart = scheme + 3;
	else if (/^git:/i.test(text)) authorityStart = 4;
	else if (/^git@/i.test(text)) authorityStart = 0;
	if (authorityStart >= 0) {
		// Pi accepts Git shorthand as well as URLs. Remove ALL userinfo up
		// to the final @ in the authority, including passwords containing @.
		const suffix = text.slice(authorityStart);
		const boundary = suffix.search(/[/?#]/);
		const end = boundary < 0 ? text.length : authorityStart + boundary;
		const at = text.lastIndexOf("@", end - 1);
		if (at >= authorityStart) {
			text = `${text.slice(0, authorityStart)}[redacted]@${text.slice(at + 1)}`;
		}
		// Query/fragment content can contain arbitrary credential names.
		text = text.replace(/[?#].*$/, "?[redacted]");
	}
	return text;
}

/** Synchronous inspection only: never refresh catalogs or resolve credentials. */
export function buildRecipeStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	launch: { argv?: string[]; env?: NodeJS.ProcessEnv } = {},
): RecipeStatusReport {
	const state = recipeRuntime();
	const def = state.active;
	const parsed = parseArgs((launch.argv ?? process.argv).slice(2));
	const env = launch.env ?? process.env;
	const requested = def?.config.model ? parseModelSpec(def.config.model) : undefined;
	const expectedModel = requested ? findRecipeModel(ctx, requested.model) : undefined;
	const model = ctx.model;
	const canonical = model ? `${model.provider}/${model.id}` : null;
	const flag = parsed.unknownFlags.get(RECIPE_FLAG);
	const sources = new Map<string, ObservedExtensionSource>();

	const observe = (sourceInfo: SourceInfo | undefined, kind: "commands" | "tools", name: string): void => {
		if (!sourceInfo || sourceInfo.path.startsWith("builtin:")) return;
		const path = safeText(sourceInfo.path);
		let source = sources.get(path);
		if (!source) {
			source = { path, source: safeText(sourceInfo.source), commands: [], tools: [] };
			sources.set(path, source);
		}
		if (!source[kind].includes(name)) source[kind].push(name);
	};
	for (const command of pi.getCommands()) {
		if (command.source === "extension") observe(command.sourceInfo, "commands", command.name);
	}
	for (const tool of pi.getAllTools()) observe(tool.sourceInfo, "tools", tool.name);

	const notes = [
		"Observed sources come from actual tool/command registrations; passive or provider-only extensions may be absent. This is not a complete loaded-extension inventory.",
		"pi list and package-update banners describe saved packages, not this runtime's extension selection.",
		"No provider request or authentication refresh was performed.",
		"Active tools are declarations to the model; registered deferred/codemode tools may remain callable through other tools. Provider IDs are not an extension inventory.",
	];
	const flagName = typeof flag === "string" ? flag.trim() : "";
	const launchRecipe = flagName || env[ACTIVE_RECIPE_ENV]?.trim() || null;
	if (state.activeName && launchRecipe !== state.activeName && (def?.config.models || def?.config.extensions)) {
		notes.push("The active recipe differs from the launch recipe; restart to apply its extension set and model scope.");
	}
	if (requested && expectedModel && canonical !== `${expectedModel.provider}/${expectedModel.id}`) {
		notes.push("The runtime model differs from the recipe's configured model (it may have been changed in-session).");
	}
	if (def?.config.models?.length && !ctx.scopedModels.length) {
		notes.push("The recipe declares a model scope, but the current runtime is unscoped (all available models).");
	}

	return {
		version: 1,
		capturedAt: new Date().toISOString(),
		recipe: state.activeName ?? null,
		selection: state.source ?? null,
		configSource: def ? `${def.source}: ${safeText(def.baseDir)}` : null,
		configured: {
			model: def?.config.model ?? null,
			thinking: def?.config.thinkingLevel ?? requested?.thinking ?? null,
			models: def?.config.models ? [...def.config.models] : null,
			extensions: def?.config.extensions?.map(safeText) ?? null,
		},
		runtime: {
			model: canonical,
			api: model?.api ?? null,
			thinking: pi.getThinkingLevel(),
			modelMatchesRecipe: expectedModel ? canonical === `${expectedModel.provider}/${expectedModel.id}` : null,
			scopeMode: ctx.scopedModels.length ? "scoped" : "all",
			scopedModels: ctx.scopedModels.map(entry => `${entry.model.provider}/${entry.model.id}`),
			activeTools: [...pi.getActiveTools()],
			registeredProviders: ctx.modelRegistry.getRegisteredProviderIds?.().map(safeText) ?? null,
		},
		launch: {
			recipe: launchRecipe,
			bridged: env[RECIPE_STAGE_ENV] === "1",
			extensionPolicy: parsed.noExtensions ? "explicit-only" : "configured-plus-explicit",
			extensions: (parsed.extensions ?? []).map(safeText),
			models: parsed.models ?? null,
		},
		observedExtensionSources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
		notes,
	};
}

export function formatRecipeStatus(report: RecipeStatusReport, view: "summary" | "full" = "full"): string {
	const lines = [
		`Snapshot: ${report.capturedAt}`,
		`Recipe: ${report.recipe ?? "off"} (selected by ${report.selection ?? "none"})`,
		`Config source: ${report.configSource ?? "none"}`,
		`Model — runtime: ${report.runtime.model ?? "none"}`,
		`API — runtime: ${report.runtime.api ?? "none"}`,
		`Thinking — runtime: ${report.runtime.thinking}`,
		`Model — configured: ${report.configured.model ?? "inherited"}`,
		`Model matches recipe: ${report.runtime.modelMatchesRecipe === null ? "unverified" : String(report.runtime.modelMatchesRecipe)}`,
		`Thinking — configured: ${report.configured.thinking ?? "inherited"}`,
		`Scope — runtime: ${report.runtime.scopeMode === "all" ? "ALL available models" : `${report.runtime.scopedModels.length} model(s)`}`,
		...report.runtime.scopedModels.map(model => `  ${model}`),
		`Scope — configured patterns: ${report.configured.models?.join(", ") ?? "inherited"}`,
		`Scope — launch CLI: ${report.launch.models?.join(", ") ?? "not supplied"}`,
		`Extensions — launch policy: ${report.launch.extensionPolicy}${report.launch.bridged ? " (recipe relaunch)" : ""}`,
		...report.launch.extensions.map(source => `  ${source}`),
		`Extensions — configured: ${report.configured.extensions?.join(", ") ?? "inherited"}`,
		"Observed extension sources (runtime registrations):",
	];
	for (const source of report.observedExtensionSources) {
		lines.push(`  ${source.source} — ${source.path}`);
		lines.push(`    ${source.commands.length} commands, ${source.tools.length} tools registered`);
	}
	if (!report.observedExtensionSources.length) lines.push("  No source metadata available.");
	const providers = report.runtime.registeredProviders;
	lines.push(`Registered provider IDs: ${providers === null ? "unavailable" : providers.join(", ") || "none"}`);
	lines.push(`Tools declared to model: ${report.runtime.activeTools.length}`);
	if (view === "full") lines.push(`  ${report.runtime.activeTools.join(", ") || "none"}`);
	lines.push(...report.notes.map(note => `Note: ${note}`));
	return lines.map(safeText).join("\n");
}

/** Width-safe shared-chrome view of the immutable runtime snapshot. */
export function renderRecipeStatusRows(
	report: RecipeStatusReport,
	chrome: ChromeTheme,
	width: number,
	expanded = false,
): string[] {
	if (width <= 0) return [];
	const lines = formatRecipeStatus(report, expanded ? "full" : "summary").split("\n");
	return [
		chromeFrameRule(chrome, width, "top", "RECIPE STATUS"),
		...lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 4)))
			.map(line => chromeFrameRow(chrome, line, width)),
		chromeFrameRule(chrome, width, "bottom"),
	];
}

/** Width-safe persistent TUI report; non-context custom entry, not a model message. */
export function registerRecipeStatusRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<RecipeStatusReport>(RECIPE_STATUS_ENTRY, (entry, options, theme) => {
		const report = entry.data;
		if (!report || report.version !== 1) return undefined;
		// SAFETY: shared chrome passes Pi theme roles; this adapter preserves
		// the receiver while bridging its string role type to Pi's role union.
		const chrome: ChromeTheme = { fg: (role, text) => theme.fg(role as Parameters<typeof theme.fg>[0], text) };
		return {
			render(width: number): string[] {
				return renderRecipeStatusRows(report, chrome, width, options.expanded);
			},
			invalidate(): void {},
		};
	});
}

/** Inspection only: no setModel/setActiveTools, config writes, or model calls. */
export function showRecipeStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { format?: "text" | "json"; stderr?: (text: string) => void } = {},
): void {
	const report = buildRecipeStatus(pi, ctx);
	pi.appendEntry(RECIPE_STATUS_ENTRY, report);
	if (ctx.mode === "print" || ctx.mode === "json") {
		// Pi's print-mode UI has a no-op notify implementation. Use stderr
		// explicitly so the report is visible without corrupting JSON stdout.
		const write = options.stderr ?? ((text: string) => { process.stderr.write(text); });
		write(options.format === "json"
			? `recipe-status: ${JSON.stringify(report)}\n`
			: `${formatRecipeStatus(report)}\n`);
		return;
	}
	if (options.format === "json" || ctx.mode === "rpc") {
		ctx.ui.notify(options.format === "json" ? JSON.stringify(report, null, 2) : formatRecipeStatus(report), "info");
	}
}
