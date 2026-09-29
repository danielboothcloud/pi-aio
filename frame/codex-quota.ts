/**
 * Codex (ChatGPT subscription) usage windows for the AIO frame — ported from
 * pi-zentui's codex-quota.ts (MIT, see UPSTREAM.md).
 *
 * Windows are 5-hour and weekly remaining-percent figures polled from
 * chatgpt.com's private usage endpoint using the routed `openai-codex` OAuth
 * token. No fallback to private storage or older credential APIs: when the
 * token or the native route is unavailable, the quota simply disappears.
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const INTERVAL = 60_000;
const TIMEOUT = 10_000;
const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

export type CodexQuota = {
	fiveHour?: number;
	week?: number;
	lastSuccess?: number;
	stale?: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Durations are seconds, not positions: unexpected windows must not inherit a label. */
export function parseCodexQuota(value: unknown): CodexQuota | undefined {
	const limits = record(record(value)?.rate_limit);
	if (!limits) return undefined;
	const result: CodexQuota = {};
	for (const raw of [limits.primary_window, limits.secondary_window]) {
		const window = record(raw);
		if (!window) continue;
		const used = window.used_percent;
		if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
		const key =
			window.limit_window_seconds === 18_000
				? "fiveHour"
				: window.limit_window_seconds === 604_800
					? "week"
					: undefined;
		if (key) result[key] = Math.round(100 - used);
	}
	return result.fiveHour !== undefined || result.week !== undefined ? result : undefined;
}

/** `5h 88% | week 97%` — the compact window label used in the frame border. */
export function codexQuotaText(quota: CodexQuota | undefined): string {
	if (!quota) return "";
	const percent = (value: number | undefined) =>
		value === undefined ? "--" : `${value}%`;
	return `5h ${percent(quota.fiveHour)} | week ${percent(quota.week)}${quota.stale ? " stale" : ""}`;
}

/** Remaining-percent tier so the frame can color an exhausted window. */
export function codexQuotaRole(quota: CodexQuota): "muted" | "warning" | "error" {
	const remaining = Math.min(quota.fiveHour ?? 100, quota.week ?? 100);
	if (remaining <= 20) return "error";
	if (quota.stale || remaining <= 50) return "warning";
	return "muted";
}

function isNativeCodexUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.origin === "https://chatgpt.com" && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Provider IDs survive models.json/extension proxy overrides; inspect public routing too. */
export function hasNativeCodexRoute(
	registry: ExtensionContext["modelRegistry"] | undefined,
	model: ExtensionContext["model"] | undefined,
): boolean {
	try {
		if (
			model?.provider !== "openai-codex" ||
			model.api !== "openai-codex-responses" ||
			!isNativeCodexUrl(model.baseUrl) ||
			typeof registry?.getProvider !== "function"
		) {
			return false;
		}
		const provider = registry.getProvider("openai-codex");
		return provider?.id === "openai-codex" && isNativeCodexUrl(provider.baseUrl);
	} catch {
		return false;
	}
}

/**
 * Resolve the routed Codex OAuth token. `getProviderAuth` is optional on the
 * host surface — when it is unavailable the quota stays hidden rather than
 * reaching into private credential storage.
 */
export async function resolveCodexToken(
	registry: ExtensionContext["modelRegistry"] | undefined,
	model: ExtensionContext["model"] | undefined,
): Promise<string | undefined> {
	const withAuth = registry as
		| (ExtensionContext["modelRegistry"] & {
				getProviderAuth?: (id: string) => Promise<
					{ auth?: { apiKey?: unknown; baseUrl?: unknown } } | undefined
				>;
		  })
		| undefined;
	if (!hasNativeCodexRoute(registry, model) || typeof withAuth?.getProviderAuth !== "function") {
		return undefined;
	}
	const result = await withAuth.getProviderAuth("openai-codex");
	// Auth can override both model and provider routing. Native OAuth omits this field.
	if (
		!hasNativeCodexRoute(registry, model) ||
		!result?.auth ||
		(result.auth.baseUrl !== undefined && !isNativeCodexUrl(result.auth.baseUrl))
	) {
		return undefined;
	}
	return typeof result.auth.apiKey === "string" && result.auth.apiKey
		? result.auth.apiKey
		: undefined;
}

function accountId(token: string): string | undefined {
	try {
		// Unverified JWT decoding is used only for routing/cache isolation, never authorization.
		const payload = record(
			JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
		);
		const id = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		return typeof id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

function retryDelay(value: string | null): number {
	if (!value) return INTERVAL;
	const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
	const delay = seconds === undefined ? Date.parse(value) - Date.now() : seconds * 1000;
	return Number.isFinite(delay) ? Math.max(INTERVAL, delay) : INTERVAL;
}

/** One session-scoped poller, with demand rechecked before every refresh. */
export class CodexQuotaCollector {
	private active = false;
	private timer?: ReturnType<typeof setTimeout>;
	private request?: AbortController;
	private generation = 0;
	private identity?: string;
	private value: CodexQuota = {};
	private nextRefresh = 0;

	constructor(
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly changed: () => void,
		private readonly fetchUsage: typeof fetch = fetch,
	) {}

	private context(): ExtensionContext | undefined {
		const ctx = this.getContext();
		return ctx && hasNativeCodexRoute(ctx.modelRegistry, ctx.model) ? ctx : undefined;
	}

	get(): CodexQuota | undefined {
		if (!this.context()) this.stop();
		if (!this.active) return undefined;
		return {
			...this.value,
			stale:
				this.value.stale ||
				(this.value.lastSuccess !== undefined &&
					Date.now() - this.value.lastSuccess >= 2 * INTERVAL),
		};
	}

	reconcile(): void {
		if (!this.context()) {
			this.stop();
			return;
		}
		if (this.active) return;
		this.active = true;
		void this.refresh();
	}

	stop(): void {
		this.active = false;
		this.generation++;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.request?.abort();
		this.request = undefined;
		this.identity = undefined;
		this.value = {};
		this.nextRefresh = 0;
	}

	private async refresh(): Promise<void> {
		const ctx = this.context();
		if (!this.active || !ctx) {
			this.stop();
			return;
		}
		if (this.request) return;
		const generation = this.generation;
		const controller = new AbortController();
		this.request = controller;
		const current = () =>
			this.active && generation === this.generation && !controller.signal.aborted;
		let delay = INTERVAL;
		let authResolved = false;
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, TIMEOUT);
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("canceled")), {
				once: true,
			});
		});
		try {
			this.changed();
			await Promise.race([
				aborted,
				(async () => {
					const token = await resolveCodexToken(ctx.modelRegistry, ctx.model);
					if (!current()) return;
					authResolved = true;
					if (!token) {
						this.identity = undefined;
						this.value = {};
						return;
					}
					const account = accountId(token);
					const identity = account
						? `account:${account}`
						: `token:${createHash("sha256").update(token).digest("hex")}`;
					if (identity !== this.identity) {
						this.identity = identity;
						this.value = {};
						this.changed();
					}
					const response = await this.fetchUsage(ENDPOINT, {
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/json",
							originator: "pi",
							...(account ? { "ChatGPT-Account-Id": account } : {}),
						},
						redirect: "error",
						signal: controller.signal,
					});
					if (!current()) return;
					if (!response.ok) void response.body?.cancel().catch(() => {});
					if (response.status === 401 || response.status === 403) {
						this.identity = undefined;
						this.value = {};
						return;
					}
					if (response.status === 429) delay = retryDelay(response.headers.get("retry-after"));
					if (!response.ok) throw new Error("Quota unavailable");
					const parsed = parseCodexQuota(await response.json());
					if (!current()) return;
					if (!parsed) throw new Error("Invalid quota response");
					this.value = { ...parsed, lastSuccess: Date.now(), stale: false };
				})(),
			]);
		} catch {
			if (generation !== this.generation) return;
			// A deadline is transient, not evidence of invalid or missing authentication.
			if (!authResolved && !timedOut) {
				this.identity = undefined;
				this.value = {};
			} else {
				this.value = { ...this.value, stale: this.value.lastSuccess !== undefined };
			}
		} finally {
			clearTimeout(timeout);
			if (generation === this.generation) {
				this.request = undefined;
				if (!this.context()) this.stop();
				else {
					this.changed();
					this.nextRefresh = Date.now() + delay;
					this.schedule();
				}
			}
		}
	}

	private schedule(): void {
		this.timer = setTimeout(
			() => {
				if (!this.context()) {
					this.stop();
					return;
				}
				this.changed();
				if (Date.now() >= this.nextRefresh) void this.refresh();
				else this.schedule();
			},
			Math.min(INTERVAL, Math.max(0, this.nextRefresh - Date.now())),
		);
		this.timer.unref?.();
	}
}
