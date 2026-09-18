import type { ProviderUsageEndpointConfig } from "./config.js";

export interface ProviderUsage {
	provider: string;
	label: string;
	used?: number;
	limit?: number;
	remaining?: number;
	remainingPercent?: number;
	renewsAt?: string;
	text?: string;
}

function readScalarPath(
	value: unknown,
	path: string,
): string | number | undefined {
	let current = value;
	for (const part of path.split(".")) {
		if (
			!part ||
			part === "__proto__" ||
			part === "prototype" ||
			part === "constructor" ||
			typeof current !== "object" ||
			current === null
		) {
			return undefined;
		}
		const descriptor = Object.getOwnPropertyDescriptor(current, part);
		if (!descriptor) return undefined;
		current = descriptor.value;
	}
	return typeof current === "string" || typeof current === "number"
		? current
		: undefined;
}

function finiteNumber(value: string | number | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function stringValue(value: string | number | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve $VAR and ${VAR} references without supporting command execution. */
export function resolveEnvironmentTemplate(value: string): string | undefined {
	let missing = false;
	const resolved = value.replace(
		/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, braced: string | undefined, bare: string | undefined) => {
			if (match === "$$") return "$";
			const envValue = process.env[braced ?? bare ?? ""];
			if (envValue === undefined) {
				missing = true;
				return "";
			}
			return envValue;
		},
	);
	return missing ? undefined : resolved;
}

export function mapProviderUsage(
	provider: string,
	config: ProviderUsageEndpointConfig,
	payload: unknown,
): ProviderUsage | undefined {
	const { mapping } = config;
	const used = mapping.used
		? finiteNumber(readScalarPath(payload, mapping.used))
		: undefined;
	const limit = mapping.limit
		? finiteNumber(readScalarPath(payload, mapping.limit))
		: undefined;
	let remaining = mapping.remaining
		? finiteNumber(readScalarPath(payload, mapping.remaining))
		: undefined;
	if (remaining === undefined && limit !== undefined && used !== undefined) {
		remaining = limit - used;
	}
	const text = mapping.text
		? stringValue(readScalarPath(payload, mapping.text))
		: undefined;
	const renewsAt = mapping.renewsAt
		? stringValue(readScalarPath(payload, mapping.renewsAt))
		: undefined;
	if (
		used === undefined &&
		limit === undefined &&
		remaining === undefined &&
		text === undefined
	) {
		return undefined;
	}

	const remainingPercent =
		remaining !== undefined && limit !== undefined && limit > 0
			? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)))
			: undefined;
	return {
		provider,
		label: config.label ?? provider,
		used,
		limit,
		remaining,
		remainingPercent,
		renewsAt,
		text,
	};
}

export async function fetchProviderUsage(
	provider: string,
	config: ProviderUsageEndpointConfig,
	timeoutMs: number,
	request: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ProviderUsage | undefined> {
	const headers: Record<string, string> = {};
	for (const [name, template] of Object.entries(config.headers)) {
		const value = resolveEnvironmentTemplate(template);
		if (value === undefined) {
			throw new Error(
				`Missing environment variable for provider usage header ${name}`,
			);
		}
		headers[name] = value;
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, timeoutMs);
	try {
		const response = await request(config.endpoint, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`Provider usage request failed with HTTP ${response.status}`,
			);
		}
		return mapProviderUsage(provider, config, await response.json());
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function sanitizeDisplayText(value: string): string {
	let sanitized = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		sanitized += code < 32 || (code >= 127 && code <= 159) ? " " : character;
	}
	return sanitized.replace(/\s+/g, " ").trim();
}

function formatReset(
	renewsAt: string | undefined,
	now: number,
): string | undefined {
	if (!renewsAt) return undefined;
	const timestamp = Date.parse(renewsAt);
	if (!Number.isFinite(timestamp)) return undefined;
	const remainingMs = timestamp - now;
	if (remainingMs <= 0) return "reset due";
	const minutes = Math.ceil(remainingMs / 60_000);
	if (minutes < 60) return `resets ${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 48) return `resets ${hours}h`;
	return `resets ${Math.ceil(hours / 24)}d`;
}

export function formatProviderUsage(
	usage: ProviderUsage,
	now = Date.now(),
): string {
	let value: string;
	if (usage.text) value = sanitizeDisplayText(usage.text);
	else if (usage.remainingPercent !== undefined)
		value = `${usage.remainingPercent}% left`;
	else if (usage.remaining !== undefined) value = `${usage.remaining} left`;
	else if (usage.used !== undefined && usage.limit !== undefined) {
		value = `${usage.used}/${usage.limit} used`;
	} else if (usage.used === undefined) value = `limit ${usage.limit}`;
	else value = `${usage.used} used`;

	const reset = formatReset(usage.renewsAt, now);
	return `${sanitizeDisplayText(usage.label)} ${value}${reset ? `, ${reset}` : ""}`;
}
