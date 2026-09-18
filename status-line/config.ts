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
	"quota",
	"model",
	"tokens",
	"cost",
] as const;

export type StatusLineSegment = (typeof STATUS_LINE_SEGMENTS)[number];
export type PathDisplay = "basename" | "abbreviated" | "full";
export type WorkingMessageMode = "minimal" | "verbose" | "off";

export interface ProviderUsageMapping {
	used?: string;
	limit?: string;
	remaining?: string;
	renewsAt?: string;
	text?: string;
}

export interface ProviderUsageEndpointConfig {
	endpoint: string;
	label?: string;
	headers: Record<string, string>;
	mapping: ProviderUsageMapping;
}

export interface ProviderUsageConfig {
	refreshIntervalMs: number;
	timeoutMs: number;
	providers: Record<string, ProviderUsageEndpointConfig>;
}

interface ParsedProviderUsageConfig {
	refreshIntervalMs?: number;
	timeoutMs?: number;
	providers: Record<string, ProviderUsageEndpointConfig>;
}

type ParsedStatusLineConfig = Omit<
	Partial<StatusLineConfig>,
	"providerUsage"
> & {
	providerUsage?: ParsedProviderUsageConfig;
};

export interface StatusLineConfig {
	enabled: boolean;
	segments: StatusLineSegment[];
	path: PathDisplay;
	workingMessage: WorkingMessageMode;
	statusKeys?: string[];
	providerUsage?: ProviderUsageConfig;
}

export const DEFAULT_STATUS_LINE_CONFIG: StatusLineConfig = {
	enabled: true,
	segments: [
		"mode",
		"path",
		"git",
		"context",
		"effort",
		"statuses",
		"cursor",
		"quota",
		"model",
	],
	path: "basename",
	workingMessage: "minimal",
};

const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5_000;

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

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function boundedNumber(
	value: unknown,
	minimum: number,
	maximum: number,
): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(maximum, Math.max(minimum, Math.round(value)))
		: undefined;
}

function parseProviderUsage(
	raw: unknown,
): ParsedProviderUsageConfig | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const block = raw as Record<string, unknown>;
	if (typeof block.providers !== "object" || block.providers === null) {
		return undefined;
	}

	const providers = Object.create(null) as Record<
		string,
		ProviderUsageEndpointConfig
	>;
	for (const [provider, rawProvider] of Object.entries(block.providers)) {
		const providerId = provider.trim();
		if (!providerId || typeof rawProvider !== "object" || rawProvider === null)
			continue;
		const entry = rawProvider as Record<string, unknown>;
		const endpoint = nonEmptyString(entry.endpoint);
		if (!endpoint) continue;
		try {
			const parsed = new URL(endpoint);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
		} catch {
			continue;
		}

		if (typeof entry.mapping !== "object" || entry.mapping === null) continue;
		const rawMapping = entry.mapping as Record<string, unknown>;
		const mapping: ProviderUsageMapping = {};
		for (const key of [
			"used",
			"limit",
			"remaining",
			"renewsAt",
			"text",
		] as const) {
			const path = nonEmptyString(rawMapping[key]);
			if (path) mapping[key] = path;
		}
		if (Object.keys(mapping).length === 0) continue;

		const headers = Object.create(null) as Record<string, string>;
		if (typeof entry.headers === "object" && entry.headers !== null) {
			for (const [name, value] of Object.entries(entry.headers)) {
				const headerName = name.trim();
				const header = nonEmptyString(value);
				if (headerName && header) headers[headerName] = header;
			}
		}

		providers[providerId] = {
			endpoint,
			label: nonEmptyString(entry.label),
			headers,
			mapping,
		};
	}

	const parsed: ParsedProviderUsageConfig = { providers };
	const refreshIntervalMs = boundedNumber(
		block.refreshIntervalMs,
		5_000,
		86_400_000,
	);
	if (refreshIntervalMs !== undefined)
		parsed.refreshIntervalMs = refreshIntervalMs;
	const timeoutMs = boundedNumber(block.timeoutMs, 500, 30_000);
	if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
	return parsed;
}

function parseStatusLineBlock(raw: unknown): ParsedStatusLineConfig {
	if (typeof raw !== "object" || raw === null) return {};
	const block = raw as Record<string, unknown>;
	const next: ParsedStatusLineConfig = {};

	if (typeof block.enabled === "boolean") next.enabled = block.enabled;
	if (Array.isArray(block.segments))
		next.segments = normalizeSegments(block.segments);
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
	const providerUsage = parseProviderUsage(block.providerUsage);
	if (providerUsage) next.providerUsage = providerUsage;
	return next;
}

/** Load aio.statusLine from global settings, then trusted project settings. */
export function loadStatusLineConfig(
	cwd?: string,
	options: {
		includeGlobal?: boolean;
		includeProject?: boolean;
		globalDir?: string;
	} = {},
): StatusLineConfig {
	const paths: string[] = [];
	if (options.includeGlobal !== false) {
		paths.push(join(options.globalDir ?? getAgentDir(), "settings.json"));
	}
	if (cwd && options.includeProject !== false) {
		paths.push(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	}

	let merged: ParsedStatusLineConfig = {};
	for (const path of paths) {
		const settings = readSettingsFile(path);
		const aio = settings?.aio;
		if (typeof aio !== "object" || aio === null) continue;
		const statusLine = (aio as Record<string, unknown>).statusLine;
		const next = parseStatusLineBlock(statusLine);
		const providerUsage = next.providerUsage
			? {
					...merged.providerUsage,
					...next.providerUsage,
					providers: {
						...(merged.providerUsage?.providers ?? {}),
						...next.providerUsage.providers,
					},
				}
			: merged.providerUsage;
		merged = { ...merged, ...next, providerUsage };
	}

	const { providerUsage, ...statusLine } = merged;
	return {
		...DEFAULT_STATUS_LINE_CONFIG,
		...statusLine,
		...(providerUsage
			? {
					providerUsage: {
						refreshIntervalMs:
							providerUsage.refreshIntervalMs ?? DEFAULT_USAGE_REFRESH_INTERVAL_MS,
						timeoutMs: providerUsage.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
						providers: providerUsage.providers,
					},
				}
			: {}),
	};
}
