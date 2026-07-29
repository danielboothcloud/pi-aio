/**
 * Native CloakBrowser stealth wrapper.
 *
 * Ports `browser-search/scripts/cloak/cloak-fetch.mjs` (itself adapted from
 * opencode-cloak-fetch, MIT) to TypeScript, driving the `cloakbrowser` npm
 * package directly instead of spawning `node scripts/cloak/cloak-fetch.mjs`.
 *
 * CloakBrowser is an *optional* peer dependency: when it isn't installed,
 * {@link cloakFetch} throws a clear "unavailable" error and callers should fall
 * back to the Camofox tier. All cloakbrowser imports are dynamic so the module
 * still loads without the package present.
 *
 * What this preserves vs the upstream script:
 *  - SSRF guard (via the ported `url-validation.ts`) before any navigation.
 *  - Per-origin persistent sessions (`--session`), reusing the upstream
 *    `~/.browser-search/cloak-sessions/<origin-hash>/` layout + PID lockfile.
 *  - Anti-bot challenge detection + resolution polling (via `challenges.ts`).
 *  - Format modes: text (body innerText), html (page.content), markdown
 *    (html → turndown via the module's readability helper).
 *  - Lazy-load scroll, configurable timeout/wait/retry, geoip, proxy, seed,
 *    platform, brand, webrtc spoofing — passed straight through to launch().
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { abortable, abortError, sleep, throwIfAborted } from "./abort.js";
import { waitForChallenge, type ChallengePage } from "./challenges.js";
import { CLOAK_MAX_CHARS } from "./config.js";
import { extractMarkdownFromHtml, textFromHtml } from "./readability.js";
import type { FetchResult } from "./types.js";
import { validateUrlWithDns } from "./url-validation.js";

class CloakError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CloakError";
	}
}

export interface CloakFetchOptions {
	url: string;
	format?: "text" | "markdown" | "html";
	maxChars?: number;
	scroll?: boolean;
	wait?: number; // ms after load
	timeout?: number; // ms navigation
	retry?: number;
	humanize?: boolean;
	proxy?: string;
	geoip?: boolean;
	seed?: number | string;
	platform?: string;
	brand?: string;
	timezone?: string;
	locale?: string;
	/** Per-origin persistent session (cookies survive restarts). */
	session?: boolean;
	persistentDir?: string;
	webrtcAuto?: boolean;
	/** Skip SSRF validation (UNSAFE — for trusted internal targets only). */
	unsafe?: boolean;
	signal?: AbortSignal;
}

// ---------- per-origin sessions (ported from lib/session.mjs) ----------

const SESSIONS_DIR = join(homedir(), ".browser-search", "cloak-sessions");

function hashOrigin(origin: string): string {
	return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

function lockPath(originHash: string): string {
	return join(SESSIONS_DIR, originHash, ".lock");
}

function isLockStale(path: string, ttl = 30_000): boolean {
	try {
		const data = existsSync(path) ? readFileSync(path, "utf-8") : null;
		if (!data) return true;
		const { pid, timestamp } = JSON.parse(data) as {
			pid: number;
			timestamp: number;
		};
		if (Date.now() - timestamp > ttl) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	} catch {
		return true;
	}
}

function acquireLock(originHash: string): void {
	const dir = join(SESSIONS_DIR, originHash);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lp = lockPath(originHash);
	if (existsSync(lp)) {
		if (!isLockStale(lp)) {
			throw new CloakError(
				`Session lock held by another process (${lp}). Use a different origin or wait.`,
			);
		}
		try {
			unlinkSync(lp);
		} catch {
			// ignore
		}
	}
	writeFileSync(
		lp,
		JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
		{ mode: 0o600 },
	);
}

function releaseLock(originHash: string): void {
	const lp = lockPath(originHash);
	try {
		const data = JSON.parse(readFileSync(lp, "utf-8")) as { pid: number };
		if (data.pid === process.pid) unlinkSync(lp);
	} catch {
		// ignore
	}
}

function heartbeatLock(originHash: string): void {
	const lp = lockPath(originHash);
	try {
		writeFileSync(
			lp,
			JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
			{ mode: 0o600 },
		);
	} catch {
		// ignore
	}
}

interface AcquiredSession {
	origin: string;
	userDataDir: string;
	release: () => void;
}

async function acquireSession(url: string): Promise<AcquiredSession> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new CloakError(`Invalid URL: ${url}`);
	}
	const origin = parsed.origin;
	const originHash = hashOrigin(origin);
	acquireLock(originHash);
	const heartbeat = setInterval(() => heartbeatLock(originHash), 10_000);
	return {
		origin,
		userDataDir: join(SESSIONS_DIR, originHash),
		release: () => {
			clearInterval(heartbeat);
			releaseLock(originHash);
		},
	};
}

// ---------- minimal cloakbrowser/playwright structural types ----------

interface CloakContext {
	pages: () => unknown[];
	newPage: () => Promise<CloakPage>;
	close: () => Promise<void>;
	cookies: () => Promise<Array<{ name: string }>>;
}
interface CloakBrowser {
	newContext: () => Promise<CloakContext>;
	close: () => Promise<void>;
}
interface CloakPage {
	url: () => string;
	goto: (
		url: string,
		opts?: { waitUntil?: string; timeout?: number },
	) => Promise<unknown>;
	title: () => Promise<string>;
	content: () => Promise<string>;
	evaluate: <T = unknown>(fn: string | (() => T)) => Promise<T>;
	close: () => Promise<void>;
	context: () => CloakContext;
}
interface CloakPersistentContext extends CloakContext {
	close: () => Promise<void>;
}
interface CloakbrowserModule {
	launch: (opts?: Record<string, unknown>) => Promise<CloakBrowser>;
	launchPersistentContext: (opts: {
		userDataDir: string;
		[key: string]: unknown;
	}) => Promise<CloakPersistentContext>;
}

function pageToChallengePage(page: CloakPage): ChallengePage {
	return {
		url: () => page.url(),
		evaluate: (fn) => page.evaluate<string>(fn as string),
		context: () => ({
			cookies: () => page.context().cookies(),
		}),
	};
}

function buildLaunchOpts(opts: CloakFetchOptions): Record<string, unknown> {
	const launchOpts: Record<string, unknown> = { headless: true };
	if (opts.humanize !== false) {
		launchOpts.humanize = true;
	}
	if (opts.proxy) launchOpts.proxy = opts.proxy;
	if (opts.geoip) launchOpts.geoip = true;
	if (opts.timezone) launchOpts.timezone = opts.timezone;
	if (opts.locale) launchOpts.locale = opts.locale;

	const args: string[] = [];
	if (opts.seed !== undefined) args.push(`--fingerprint=${opts.seed}`);
	if (opts.platform) args.push(`--fingerprint-platform=${opts.platform}`);
	if (opts.brand) args.push(`--fingerprint-brand=${opts.brand}`);
	if (opts.webrtcAuto) args.push("--fingerprint-webrtc-ip=auto");
	if (args.length > 0) launchOpts.args = args;
	return launchOpts;
}

async function openPersistentPage(
	cloak: CloakbrowserModule,
	userDataDir: string,
	launchOpts: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ context: CloakPersistentContext; page: CloakPage }> {
	const context = await abortable(
		cloak.launchPersistentContext({ userDataDir, ...launchOpts }),
		signal,
	);
	const page =
		(context.pages()[0] as CloakPage) ||
		(await abortable(context.newPage(), signal));
	return { context, page };
}

async function fetchPageOnce(
	opts: CloakFetchOptions,
	cloak: CloakbrowserModule,
): Promise<FetchResult> {
	throwIfAborted(opts.signal);
	const launchOpts = buildLaunchOpts(opts);
	let session: AcquiredSession | null = null;
	let browser: CloakBrowser | null = null;
	let context: CloakContext | null = null;
	let page: CloakPage | null = null;

	try {
		if (opts.persistentDir) {
			({ context, page } = await openPersistentPage(
				cloak,
				opts.persistentDir,
				launchOpts,
				opts.signal,
			));
		} else if (opts.session) {
			session = await abortable(acquireSession(opts.url), opts.signal);
			process.stderr.write(
				`${JSON.stringify({
					session: "acquired",
					origin: session.origin,
					userDataDir: session.userDataDir,
				})}\n`,
			);
			({ context, page } = await openPersistentPage(
				cloak,
				session.userDataDir,
				launchOpts,
				opts.signal,
			));
		} else {
			browser = await abortable(cloak.launch(launchOpts), opts.signal);
			context = await abortable(browser.newContext(), opts.signal);
			page = await abortable(context.newPage(), opts.signal);
		}

		const timeout = opts.timeout ?? 30_000;
		try {
			await abortable(
				page.goto(opts.url, { waitUntil: "networkidle", timeout }),
				opts.signal,
			);
		} catch (err) {
			if (opts.signal?.aborted) throw abortError(opts.signal);
			await abortable(
				page.goto(opts.url, { waitUntil: "domcontentloaded", timeout }),
				opts.signal,
			);
		}

		const challenge = await waitForChallenge(
			pageToChallengePage(page),
			20_000,
			opts.signal,
		);

		const wait = opts.wait ?? 1000;
		if (wait > 0) await sleep(wait, opts.signal);

		if (opts.scroll) {
			let prev = 0;
			for (let i = 0; i < 5; i++) {
				const h = await page.evaluate<number>(() => {
					window.scrollTo(0, document.body.scrollHeight);
					return document.body.scrollHeight;
				});
				if (h === prev) break;
				prev = h;
				await sleep(1500, opts.signal);
			}
			await page.evaluate(() => window.scrollTo(0, 0));
		}

		if (!page) throw new CloakError("CloakBrowser returned no page");

		const finalUrl = page.url();
		const title = await page.title().catch(() => "");
		const format = opts.format ?? "text";
		const maxChars = opts.maxChars ?? CLOAK_MAX_CHARS;

		let raw: string;
		if (format === "html") {
			raw = await page.content();
		} else if (format === "markdown") {
			const html = await abortable(page.content(), opts.signal);
			raw = extractMarkdownFromHtml(html).content;
		} else {
			raw = await page
				.evaluate<string>(() => document.body?.innerText || "")
				.catch(async () => textFromHtml(await page.content()));
		}

		const truncated = raw.length > maxChars;
		const content = truncated
			? `${raw.slice(0, maxChars)}\n\n[truncated]`
			: raw;

		return {
			url: opts.url,
			finalUrl,
			title,
			content,
			format,
			chars: raw.length,
			truncated,
			tier: "cloak",
			challengeStrategy: challenge.detected ? challenge.strategy : null,
			challengeResolved: challenge.detected ? challenge.resolved : undefined,
		};
	} finally {
		if (page && !opts.persistentDir && !session) {
			await page.close().catch(() => {});
		}
		if (context) await context.close().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		if (session) session.release();
	}
}

/**
 * Fetch a URL through CloakBrowser stealth Chromium. Lazily imports the
 * `cloakbrowser` package; throws CloakError if it isn't installed.
 */
export async function cloakFetch(
	opts: CloakFetchOptions,
): Promise<FetchResult> {
	throwIfAborted(opts.signal);
	if (!opts.unsafe) {
		const check = await validateUrlWithDns(opts.url);
		throwIfAborted(opts.signal);
		if (!check.valid) throw new CloakError(`URL blocked: ${check.reason}`);
	}

	const cloak = (await importCloak()) as CloakbrowserModule | null;
	throwIfAborted(opts.signal);
	if (!cloak) {
		throw new CloakError(
			"cloakbrowser is not installed. `npm install cloakbrowser playwright-core` to enable the stealth tier.",
		);
	}

	const maxRetries = Math.max(0, opts.retry ?? 0);
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		throwIfAborted(opts.signal);
		if (attempt > 0) await sleep(2000 * attempt, opts.signal);
		try {
			return await fetchPageOnce(opts, cloak);
		} catch (err) {
			if (opts.signal?.aborted) throw abortError(opts.signal);
			lastErr = err;
			if (attempt < maxRetries) continue;
		}
	}
	const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
	throw new CloakError(`cloak fetch failed: ${message}`);
}

async function importCloak(): Promise<unknown | null> {
	try {
		return await import("cloakbrowser");
	} catch {
		return null;
	}
}
