import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloakFetchOptions, CloakbrowserModule } from "./cloak-runtime.ts";

// Set before import so the module-level env override is covered by this file.
process.env.BROWSER_SEARCH_CLOAK_TIMEOUT_MS = "71234";
const { cloakFetch } = await import("./cloak-runtime.ts");

interface Visit {
	url: string;
	waitUntil?: string;
	timeout?: number;
}

interface FakePageOptions {
	gotoImpl?: (visit: Visit, index: number) => Promise<unknown>;
	html?: string;
	text?: string;
	readyState?: string;
	chars?: number;
	cookies?: Array<{ name: string }>;
}

function fakeCloakPage(options: FakePageOptions = {}) {
	const {
		gotoImpl,
		html = "<html><head></head><body><article><h1>Fixture</h1><p>Readable body.</p></article></body></html>",
		text = "Readable body.",
		readyState = "complete",
		chars = 14,
		cookies = [],
	} = options;
	const visits: Visit[] = [];
	const page = {
		url: () => "https://8.8.8.8/a",
		goto: async (
			target: string,
			gotoOpts?: { waitUntil?: string; timeout?: number },
		) => {
			const visit: Visit = {
				url: target,
				waitUntil: gotoOpts?.waitUntil,
				timeout: gotoOpts?.timeout,
			};
			visits.push(visit);
			return gotoImpl ? gotoImpl(visit, visits.length) : null;
		},
		title: async () => "Fixture",
		content: async () => html,
		evaluate: async (fn: unknown) => {
			const source = String(fn);
			if (source.includes("readyState")) return { readyState, chars };
			if (source.includes("documentElement")) return html;
			if (source.includes("innerText")) return text;
			if (source.includes("scrollTo")) return 0;
			throw new Error("unexpected evaluate call");
		},
		context: () => ({ cookies: async () => cookies }),
		close: async () => {},
	};
	return { page, visits };
}

function fakeCloakModule(
	page: unknown,
	cookies: Array<{ name: string }>,
	onLaunch: (opts: Record<string, unknown>) => void = () => {},
): CloakbrowserModule {
	const context = {
		pages: () => [] as unknown[],
		newPage: async () => page,
		cookies: async () => cookies,
		close: async () => {},
	};
	return {
		launch: async (opts: Record<string, unknown> = {}) => {
			onLaunch(opts);
			return {
				newContext: async () => context,
				close: async () => {},
			};
		},
		launchPersistentContext: async () => {
			throw new Error("persistent contexts are not used here");
		},
	} as unknown as CloakbrowserModule;
}

test("navigation uses domcontentloaded first with humanize off by default", async () => {
	const { page, visits } = fakeCloakPage();
	let launchOpts: Record<string, unknown> = {};
	const cloak = fakeCloakModule(page, [], (opts) => {
		launchOpts = opts;
	});
	const result = await cloakFetch(
		{ url: "https://8.8.8.8/a", format: "text", wait: 0 } as CloakFetchOptions,
		cloak,
	);
	assert.deepEqual(
		visits.map((visit) => visit.waitUntil),
		["domcontentloaded"],
	);
	assert.equal(visits[0]?.timeout, 71_234); // env-configured default
	assert.equal(launchOpts.headless, true);
	assert.ok(!("humanize" in launchOpts));
	assert.equal(result.tier, "cloak");
	assert.match(result.content, /Readable body\./);
});

test("a stalled domcontentloaded falls back to commit and readiness polling", async () => {
	const { page, visits } = fakeCloakPage({
		gotoImpl: async (visit, index) => {
			if (index === 1) throw new Error("page.goto: Timeout 30000ms exceeded.");
			return null;
		},
	});
	const cloak = fakeCloakModule(page, []);
	const result = await cloakFetch(
		{
			url: "https://8.8.8.8/a",
			format: "text",
			wait: 0,
			timeout: 5_000,
		} as CloakFetchOptions,
		cloak,
	);
	assert.deepEqual(
		visits.map((visit) => visit.waitUntil),
		["domcontentloaded", "commit"],
	);
	assert.equal(visits[0]?.timeout, 5_000); // explicit opts override the env default
	assert.equal(visits[1]?.timeout, Math.min(5_000, 15_000));
	assert.equal(result.tier, "cloak");
	assert.match(result.content, /Readable body\./);
});

test("a page that never produces content fails explicitly", async () => {
	const { page } = fakeCloakPage({
		gotoImpl: async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		},
		html: "",
		text: "",
		readyState: "loading",
		chars: 0,
	});
	const cloak = fakeCloakModule(page, []);
	await assert.rejects(
		cloakFetch(
			{
				url: "https://8.8.8.8/a",
				format: "text",
				wait: 0,
				timeout: 800,
			} as CloakFetchOptions,
			cloak,
		),
		/navigation stalled/,
	);
});

test("humanize is passed through only when explicitly requested", async () => {
	const { page } = fakeCloakPage();
	const launches: Array<Record<string, unknown>> = [];
	const cloak = fakeCloakModule(page, [], (opts) => launches.push(opts));
	await cloakFetch(
		{
			url: "https://8.8.8.8/a",
			format: "text",
			wait: 0,
			humanize: true,
		} as CloakFetchOptions,
		cloak,
	);
	assert.equal(launches[0]?.humanize, true);
});
