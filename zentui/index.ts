import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configPath } from "pi-zentui/extensions/zentui/config.ts";
import registerZentui from "pi-zentui/extensions/zentui/index.ts";
import {
	getEffectiveLevel,
} from "../effort/effort-status.js";
import { getPermissionModeAccess } from "../permission-modes/mode-access.js";
import {
	AIO_UI_STATE_EVENT,
	type AioUiStateUpdate,
	probeZentuiWorkingLine,
	publishZentuiWorkingLineSegment,
	ZENTUI_WORKING_LINE_SEGMENT_PROTOCOL_VERSION,
} from "./protocol.js";
import { seedZentuiConfig } from "./seed.js";

const MODE_SEGMENT_KEY = "aio:permission-mode";
const EFFORT_SEGMENT_KEY = "aio:effort";

const MODE_PRESENTATION = {
	default: { icon: "●", label: "Default", role: "muted" },
	ask: { icon: "?", label: "Ask", role: "accent" },
	plan: { icon: "⏸", label: "Plan", role: "warning" },
	auto: { icon: "▶", label: "Auto", role: "accent" },
} as const;

type PermissionMode = keyof typeof MODE_PRESENTATION;

interface ZentuiIntegrationDependencies {
	registerZentui?: (pi: ExtensionAPI) => void;
	getMode?: () => PermissionMode;
	getEffort?: () => string;
	/** Test seam; defaults to the real seed-once-if-absent write. */
	seedZentuiConfig?: () => void;
}

function isAioUiStateUpdate(value: unknown): value is AioUiStateUpdate {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registerWorkingLineBridge(
	pi: ExtensionAPI,
	dependencies: ZentuiIntegrationDependencies,
): void {
	let currentMode = dependencies.getMode?.() ?? "default";
	let currentEffort = dependencies.getEffort?.() ?? "unknown";
	let sessionActive = false;

	const refreshState = () => {
		currentMode = dependencies.getMode?.() ?? currentMode;
		currentEffort = dependencies.getEffort?.() ?? currentEffort;
	};

	const removeSegments = () => {
		publishZentuiWorkingLineSegment(pi, MODE_SEGMENT_KEY);
		publishZentuiWorkingLineSegment(pi, EFFORT_SEGMENT_KEY);
	};

	const publish = () => {
		if (!sessionActive) return;
		const capability = probeZentuiWorkingLine(pi);
		if (
			!capability.active ||
			(capability.version ?? 0) < ZENTUI_WORKING_LINE_SEGMENT_PROTOCOL_VERSION
		) {
			removeSegments();
			return;
		}
		const mode = MODE_PRESENTATION[currentMode];
		publishZentuiWorkingLineSegment(
			pi,
			MODE_SEGMENT_KEY,
			`${mode.icon} ${mode.label}`,
		);
		publishZentuiWorkingLineSegment(
			pi,
			EFFORT_SEGMENT_KEY,
			currentEffort === "unknown" ? undefined : `think:${currentEffort}`,
		);
	};

	pi.events.on(AIO_UI_STATE_EVENT, (value) => {
		if (!isAioUiStateUpdate(value)) return;
		if (value.mode && value.mode in MODE_PRESENTATION) currentMode = value.mode;
		if (typeof value.effort === "string" && value.effort.length > 0) {
			currentEffort = value.effort;
		}
		publish();
	});

	const refreshAndPublish = () => {
		refreshState();
		publish();
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = ctx.mode === "tui";
		refreshState();
		publish();
	});
	pi.on("session_tree", async () => refreshAndPublish());
	pi.on("agent_start", async () => refreshAndPublish());
	pi.on("turn_start", async () => refreshAndPublish());
	pi.on("before_provider_request", async () => refreshAndPublish());
	pi.on("session_shutdown", async () => {
		removeSegments();
		sessionActive = false;
	});
}

/**
 * Load Zentui as AIO's final visual owner, then bridge AIO state into its
 * keyed Working-line protocol. An already-loaded standalone Zentui wins so we
 * never register duplicate commands, renderers, or ownership controllers.
 */
export function registerAioZentui(
	pi: ExtensionAPI,
	dependencies: ZentuiIntegrationDependencies = {},
): { bundled: boolean } {
	// Seed-once-if-absent: minimalist is AIO's only supported presentation. An
	// existing zentui.json is never touched (see seed.ts and AGENTS.md).
	(dependencies.seedZentuiConfig ?? (() => void seedZentuiConfig(configPath)))();

	const existing = probeZentuiWorkingLine(pi);
	const bundled = !existing.supported;
	if (bundled) {
		(dependencies.registerZentui ?? registerZentui)(pi);
	}

	registerWorkingLineBridge(pi, {
		...dependencies,
		getMode:
			dependencies.getMode ??
			(() => getPermissionModeAccess()?.getMode() ?? "default"),
		getEffort: dependencies.getEffort ?? (() => getEffectiveLevel()),
	});
	return { bundled };
}
