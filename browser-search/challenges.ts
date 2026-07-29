/**
 * Anti-bot challenge detection.
 *
 * Ported from `browser-search/scripts/cloak/challenges.mjs` (derived from
 * opencode-cloak-fetch, MIT). Detects Cloudflare, Akamai, DataDome, Imperva,
 * PerimeterX, and DDoS-Guard challenges from page cookies + HTML, then polls
 * until the challenge resolves (or the timeout elapses).
 *
 * The detector runs over a loosely-typed page state collected from the
 * cloakbrowser Playwright page; it never imports playwright-core directly so
 * the module stays loadable without the optional peer installed.
 */

import { abortable, sleep, throwIfAborted } from "./abort.js";

export interface ChallengeState {
	url: string;
	resourceUrls?: string[];
	cookies?: Array<{ name: string }>;
	headers?: Record<string, string>;
	html?: string;
}

export interface DetectedChallenge {
	name: string;
	score: number;
}

interface Detector {
	name: string;
	weight: number;
	test: (state: ChallengeState) => number;
}

const DETECTORS: Detector[] = [
	{
		name: "cloudflare",
		weight: 2,
		test: ({ url, cookies = [], headers = {}, html = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name.startsWith("__cf"))) score += 2;
			if (headers["server"]?.toLowerCase().includes("cloudflare")) score += 2;
			if ((url || "").includes("__cf_chl_f_tk")) score += 2;
			if (html.includes("/cdn-cgi/")) score += 3;
			if (html.includes("Checking your browser") && html.includes("Cloudflare"))
				score += 2;
			if (html.includes("Just a moment")) score += 1;
			if (html.includes("Attention Required! Cloudflare")) score += 3;
			return score;
		},
	},
	{
		name: "akamai",
		weight: 2,
		test: ({ cookies = [], headers = {}, html = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name === "ak_bmsc")) score += 3;
			if (cookies.some((c) => c.name.startsWith("_abck"))) score += 2;
			if (headers["x-akamai-transformed"] || headers["x-akamai-request-id"])
				score += 2;
			if (html.includes("Akamai")) score += 1;
			if (html.includes("/akamai/")) score += 2;
			return score;
		},
	},
	{
		name: "datadome",
		weight: 2,
		test: ({ cookies = [], html = "", url = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name.startsWith("datadome"))) score += 3;
			if (html.includes("Datadome")) score += 1;
			if (html.includes("/datadome/")) score += 2;
			if (url.includes("x-craft-preview") || url.includes("ddl_")) score += 1;
			return score;
		},
	},
	{
		name: "imperva",
		weight: 2,
		test: ({ cookies = [], headers = {}, html = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name.startsWith("incap_ses_"))) score += 3;
			if (cookies.some((c) => c.name.startsWith("visid_incap_"))) score += 2;
			if (headers["x-iinfo"]) score += 1;
			if (html.includes("Imperva")) score += 1;
			if (html.includes("/_Incapsula_Resource")) score += 2;
			return score;
		},
	},
	{
		name: "perimeterx",
		weight: 2,
		test: ({ cookies = [], html = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name.startsWith("_px"))) score += 3;
			if (html.includes("PerimeterX")) score += 1;
			if (html.includes("/px.js")) score += 2;
			return score;
		},
	},
	{
		name: "ddos-guard",
		weight: 2,
		test: ({ cookies = [], headers = {}, html = "" }) => {
			let score = 0;
			if (cookies.some((c) => c.name.startsWith("__ddg"))) score += 3;
			if (headers["server"]?.toLowerCase().includes("ddos-guard")) score += 2;
			if (html.includes("DDoS-Guard")) score += 1;
			return score;
		},
	},
];

/** Returns the highest-scoring detected challenge, or null. */
export function detectChallenge(
	state: ChallengeState,
): DetectedChallenge | null {
	const results: DetectedChallenge[] = [];
	for (const detector of DETECTORS) {
		const score = detector.test(state);
		if (score >= (detector.weight || 1)) {
			results.push({ name: detector.name, score });
		}
	}
	results.sort((a, b) => b.score - a.score);
	return results.length > 0 ? results[0] : null;
}

/**
 * Minimal page interface — the subset of a Playwright `Page` we touch. Kept
 * structural so the cloakbrowser optional peer is never imported at module load.
 */
export interface ChallengePage {
	url: () => string;
	evaluate: <T = string>(fn: string | (() => T)) => Promise<T>;
	context: () => { cookies: () => Promise<Array<{ name: string }>> };
}

export interface ChallengeWaitOutcome {
	detected: boolean;
	resolved: boolean;
	strategy: string | null;
}

/** Poll the page until any detected challenge resolves or timeout. */
export async function waitForChallenge(
	page: ChallengePage,
	timeoutMs = 20_000,
	signal?: AbortSignal,
): Promise<ChallengeWaitOutcome> {
	throwIfAborted(signal);
	const start = Date.now();
	let detected = false;
	let strategy: string | null = null;

	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const cookies = await abortable(
			page
				.context()
				.cookies()
				.catch(() => []),
			signal,
		);
		const url = page.url();
		const html = await abortable(
			page
				.evaluate(() => document.documentElement?.outerHTML || "")
				.catch(() => ""),
			signal,
		);

		const challenge = detectChallenge({
			url,
			cookies,
			html: html ?? "",
		});

		if (challenge) {
			detected = true;
			strategy = challenge.name;
			const stillChallenging =
				Boolean(html) &&
				(html.includes("Checking your browser") ||
					html.includes("Just a moment") ||
					html.includes("Attention Required") ||
					url.includes("/cdn-cgi/") ||
					cookies.some(
						(c) => c.name.startsWith("__cf") && c.name.includes("bm"),
					));
			if (!stillChallenging) {
				return { detected: true, resolved: true, strategy };
			}
		} else {
			// No challenge now: either never appeared, or appeared-then-cleared.
			return { detected, resolved: detected, strategy };
		}

		await sleep(1000, signal);
	}

	return { detected, resolved: false, strategy };
}
