import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const STATUS_LINE_SEGMENTS = [
	"mode",
	"path",
	"git",
	"context",
	"effort",
	"statuses",
	"cursor",
	"model",
	"tokens",
	"cost",
] as const;

export type StatusLineSegment = (typeof STATUS_LINE_SEGMENTS)[number];
export type PathDisplay = "basename" | "abbreviated" | "full";
export type WorkingMessageMode = "minimal" | "verbose" | "off";

export interface StatusLineConfig {
	enabled: boolean;
	segments: StatusLineSegment[];
	path: PathDisplay;
	workingMessage: WorkingMessageMode;
	statusKeys?: string[];
}

export const DEFAULT_STATUS_LINE_CONFIG: StatusLineConfig = {
	enabled: true,
	segments: ["mode", "path", "git", "context", "effort", "statuses", "cursor", "model"],
	path: "basename",
	workingMessage: "minimal",
};

const VALID_SEGMENTS = new Set<string>(STATUS_LINE_SEGMENTS);
const VALID_PATH = new Set<string>(["basename", "abbreviated", "full"]);
const VALID_WORKING = new Set<string>(["minimal", "verbose", "off"]);

function normalizeSegments(value: unknown): StatusLineSegment[] {
	if (!Array.isArray(value)) return DEFAULT_STATUS_LINE_CONFIG.segments;
	const segments = value.filter(
		(item): item is StatusLineSegment =>
			typeof item === "string" && VALID_SEGMENTS.has(item),
	);
	return segments.length > 0 ? segments : DEFAULT_STATUS_LINE_CONFIG.segments;
}

function readSettingsFile(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseStatusLineBlock(raw: unknown): Partial<StatusLineConfig> {
	if (typeof raw !== "object" || raw === null) return {};
	const block = raw as Record<string, unknown>;
	const next: Partial<StatusLineConfig> = {};

	if (typeof block.enabled === "boolean") next.enabled = block.enabled;
	if (Array.isArray(block.segments)) next.segments = normalizeSegments(block.segments);
	if (typeof block.path === "string" && VALID_PATH.has(block.path)) {
		next.path = block.path as PathDisplay;
	}
	if (
		typeof block.workingMessage === "string" &&
		VALID_WORKING.has(block.workingMessage)
	) {
		next.workingMessage = block.workingMessage as WorkingMessageMode;
	}
	if (Array.isArray(block.statusKeys)) {
		next.statusKeys = block.statusKeys.filter(
			(key): key is string => typeof key === "string" && key.length > 0,
		);
	}
	return next;
}

/** Load aio.statusLine from project then global Pi settings. */
export function loadStatusLineConfig(cwd?: string): StatusLineConfig {
	const paths = cwd
		? [join(cwd, CONFIG_DIR_NAME, "settings.json")]
		: [
				join(process.cwd(), CONFIG_DIR_NAME, "settings.json"),
				join(getAgentDir(), "settings.json"),
			];

	let merged: Partial<StatusLineConfig> = {};
	for (const path of paths) {
		const settings = readSettingsFile(path);
		const aio = settings?.aio;
		if (typeof aio !== "object" || aio === null) continue;
		const statusLine = (aio as Record<string, unknown>).statusLine;
		merged = { ...merged, ...parseStatusLineBlock(statusLine) };
	}

	return { ...DEFAULT_STATUS_LINE_CONFIG, ...merged };
}
