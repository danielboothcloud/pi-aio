// Regenerate golden.json from the TypeScript browser-search feature (the
// reference):
//   npx tsx go/internal/browsersearch/testdata/gen-golden.ts [--check]
// It drives the real modules: config (the env constants and the
// aio.browserSearch settings merge and load), url-validation (with the DNS
// table in dns-stub.mjs), challenges, the SearXNG and Exa adapters and the
// Camofox client against a local scripted HTTP server, cloakFetch with
// browser-search/test-fixture-cloak-worker.mjs, fetchSingleUrl, and
// registerBrowserSearch through a harness (tool metadata, session_start
// registration, and tool executes with injected and real backends). Nothing
// leaves 127.0.0.1: the scripted server answers every backend call, and the
// CloakBrowser worker is the fixture (BROWSER_SEARCH_NODE_BINARY points at a
// wrapper that runs it). Server URLs are written with @@PORT@@, paths with
// @@ROOT@@ and @@REPO@@.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire, register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
const agentDir = join(root, "agent");
const home = join(root, "home");
for (const dir of [agentDir, home]) mkdirSync(dir, { recursive: true });
// Remove the fixture folder also when the generator fails.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function parseJSON<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`cannot parse ${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const clone = <T>(value: T): T => (value === undefined ? value : parseJSON<T>(JSON.stringify(value), "a cloned value"));

// ---------------------------------------------------------------------------
// Scripted local server: each case queues responses; every request is logged.
// ---------------------------------------------------------------------------

interface Reply {
	status?: number;
	body?: string;
	delayMs?: number;
	contentType?: string;
}
interface Logged {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}
let queue: Reply[] = [];
let log: Logged[] = [];
const require = createRequire(import.meta.url);
const readabilitySource = readFileSync(
	join(dirname(require.resolve("@mozilla/readability", { paths: [repo] })), "Readability.js"),
	"utf8",
);
const escapedSource = JSON.stringify(readabilitySource).slice(1, -1);

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const headers: Record<string, string> = {};
	for (const name of ["content-type", "x-api-key", "authorization"]) {
		const value = request.headers[name];
		if (typeof value === "string") headers[name] = value;
	}
	log.push({
		method: request.method ?? "",
		url: request.url ?? "",
		headers,
		body: Buffer.concat(chunks).toString("utf8").split(escapedSource).join("@@READABILITY@@"),
	});
	const reply = queue.shift() ?? { status: 404, body: JSON.stringify({ error: "unscripted" }) };
	if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
	response.statusCode = reply.status ?? 200;
	response.setHeader("content-type", reply.contentType ?? "application/json");
	response.end(reply.body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address !== "object") throw new Error("no server address");
const port = address.port;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Process environment for the module constants (read when config.ts loads).
// ---------------------------------------------------------------------------

for (const key of Object.keys(process.env)) {
	if (/^(BROWSER_SEARCH_|CAMOFOX_|SEARXNG_BASE$|EXA_API_KEY$|TEST_EXA)/.test(key)) delete process.env[key];
}
const wrapper = join(root, "node-wrapper.sh");
const fixtureWorker = join(repo, "browser-search", "test-fixture-cloak-worker.mjs");
writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fixtureWorker}"\n`);
chmodSync(wrapper, 0o755);
const ENV: Record<string, string> = {
	BROWSER_SEARCH_SEARXNG_BASE: `${base}/sx`,
	BROWSER_SEARCH_EXA_BASE: `${base}/exa/`,
	BROWSER_SEARCH_CAMOFOX_BASE: `${base}/cf`,
	CAMOFOX_API_KEY: "cf-key",
	BROWSER_SEARCH_SEARXNG_TIMEOUT_MS: "400",
	BROWSER_SEARCH_EXA_TIMEOUT_MS: "400",
	BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS: "400",
	BROWSER_SEARCH_MAX_INLINE_CONTENT: "3000",
	BROWSER_SEARCH_NODE_BINARY: wrapper,
	TEST_EXA_KEY: " exa-key ",
	PI_CODING_AGENT_DIR: agentDir,
	HOME: home,
};
Object.assign(process.env, ENV);

register(pathToFileURL(join(here, "hooks.mjs")).href);

// Exa's startPublishedDate reads the clock: pin it.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
Date.now = () => NOW;

// Camofox/abort sleeps (1000, 1500, 2000 ms) run at once and are recorded.
const realSetTimeout = globalThis.setTimeout;
let sleeps: number[] | null = null;
globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
	if (sleeps && (ms === 1000 || ms === 1500 || ms === 2000)) {
		sleeps.push(ms);
		return realSetTimeout(fn, 0, ...args);
	}
	return realSetTimeout(fn, ms, ...args);
}) as typeof setTimeout;

const mod = (name: string) => join(repo, "browser-search", name);
const config = await import(mod("config.ts"));
const urlValidation = await import(mod("url-validation.ts"));
const challenges = await import(mod("challenges.ts"));
const searxng = await import(mod("searxng.ts"));
const exa = await import(mod("exa.ts"));
const camofox = await import(mod("camofox.ts"));
const cloak = await import(mod("cloak.ts"));
const index = await import(mod("index.ts"));

function errorOf(error: unknown): { name: string; message: string } {
	if (error instanceof Error || (error && typeof error === "object" && "message" in error)) {
		const e = error as Error;
		return { name: e.name, message: e.message };
	}
	return { name: "", message: String(error) };
}

function placeholders<T>(value: T): T {
	if (value === undefined) return value;
	let text = JSON.stringify(value);
	text = text.split(root).join("@@ROOT@@").split(repo).join("@@REPO@@").split(`127.0.0.1:${port}`).join("127.0.0.1:@@PORT@@");
	text = text.replace(/Node [0-9.]+; Bun none/g, "Node @@NODE@@; Bun none");
	return parseJSON<T>(text, "a placeholder substitution");
}

async function scripted<T>(replies: Reply[], fn: () => Promise<T>) {
	queue = clone(replies);
	log = [];
	sleeps = [];
	const out: Record<string, unknown> = {};
	try {
		out.out = clone(await fn());
	} catch (error) {
		out.error = errorOf(error);
	}
	// A delayed reply may still log after a timeout; let it settle.
	await new Promise((resolve) => realSetTimeout(resolve, 20));
	out.requests = clone(log);
	out.sleeps = sleeps;
	sleeps = null;
	if (queue.length) out.unused = queue.length;
	return out;
}

const json = (value: unknown, status = 200, extra: Partial<Reply> = {}): Reply => ({ status, body: JSON.stringify(value), ...extra });

// ---------------------------------------------------------------------------
// config.ts: env constants (a fresh module instance per environment)
// ---------------------------------------------------------------------------

const envKeys = [
	"BROWSER_SEARCH_SEARXNG_BASE",
	"SEARXNG_BASE",
	"BROWSER_SEARCH_EXA_BASE",
	"BROWSER_SEARCH_CAMOFOX_BASE",
	"CAMOFOX_BASE",
	"CAMOFOX_API_KEY",
	"CAMOFOX_USER_ID",
	"BROWSER_SEARCH_CAMOFOX_AUTO_RESTART",
	"BROWSER_SEARCH_CAMOFOX_RESTART_CMD",
	"BROWSER_SEARCH_DEBUG",
	"BROWSER_SEARCH_CLOAK_MAX_CHARS",
	"BROWSER_SEARCH_SEARXNG_TIMEOUT_MS",
	"BROWSER_SEARCH_EXA_TIMEOUT_MS",
	"BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS",
	"BROWSER_SEARCH_MAX_INLINE_CONTENT",
];
const envSets: Array<Record<string, string>> = [
	{},
	{ BROWSER_SEARCH_SEARXNG_BASE: " http://sx.example:8888/// ", SEARXNG_BASE: "http://ignored" },
	{ SEARXNG_BASE: "http://legacy/", CAMOFOX_BASE: "http://cf-legacy:1/" },
	{ BROWSER_SEARCH_SEARXNG_BASE: "", SEARXNG_BASE: "http://ignored", BROWSER_SEARCH_CAMOFOX_BASE: "   " },
	{ BROWSER_SEARCH_EXA_BASE: "https://exa.example/v1/", CAMOFOX_API_KEY: "k", CAMOFOX_USER_ID: "" },
	{ CAMOFOX_USER_ID: "someone", BROWSER_SEARCH_CAMOFOX_AUTO_RESTART: "TRUE", BROWSER_SEARCH_CAMOFOX_RESTART_CMD: "  podman restart cf  " },
	{ BROWSER_SEARCH_CAMOFOX_AUTO_RESTART: "yes ", BROWSER_SEARCH_DEBUG: "Yes" },
	{ BROWSER_SEARCH_CAMOFOX_AUTO_RESTART: "1", BROWSER_SEARCH_DEBUG: "true\n" },
	{ BROWSER_SEARCH_CAMOFOX_AUTO_RESTART: "on", BROWSER_SEARCH_DEBUG: "0" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "5000", BROWSER_SEARCH_MAX_INLINE_CONTENT: " 1234 " },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "", BROWSER_SEARCH_MAX_INLINE_CONTENT: "" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "0x10", BROWSER_SEARCH_MAX_INLINE_CONTENT: "0x10" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "1e3", BROWSER_SEARCH_MAX_INLINE_CONTENT: "2E2" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "12.0", BROWSER_SEARCH_MAX_INLINE_CONTENT: "12.5" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "-5", BROWSER_SEARCH_MAX_INLINE_CONTENT: "0" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "abc", BROWSER_SEARCH_MAX_INLINE_CONTENT: "1_000" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: "9007199254740993", BROWSER_SEARCH_MAX_INLINE_CONTENT: "9007199254740991" },
	{ BROWSER_SEARCH_SEARXNG_TIMEOUT_MS: "0o17", BROWSER_SEARCH_EXA_TIMEOUT_MS: "0b101", BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS: "Infinity" },
	{ BROWSER_SEARCH_SEARXNG_TIMEOUT_MS: "+15", BROWSER_SEARCH_EXA_TIMEOUT_MS: ".5e1", BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS: "5." },
	{ BROWSER_SEARCH_SEARXNG_TIMEOUT_MS: "-0x10", BROWSER_SEARCH_EXA_TIMEOUT_MS: "0x", BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS: "\u00a0 42\u3000" },
	{ BROWSER_SEARCH_CLOAK_MAX_CHARS: " 77 ", BROWSER_SEARCH_SEARXNG_TIMEOUT_MS: "1 2", BROWSER_SEARCH_EXA_TIMEOUT_MS: "inf", BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS: "0X1f" },
];
const savedEnv: Record<string, string | undefined> = {};
for (const key of envKeys) savedEnv[key] = process.env[key];
const envCases: Array<{ env: Record<string, string>; out: Record<string, unknown> }> = [];
for (const [i, set] of envSets.entries()) {
	for (const key of envKeys) delete process.env[key];
	Object.assign(process.env, set);
	const c = await import(`${pathToFileURL(mod("config.ts")).href}?env=${i}`);
	const s = await import(`${pathToFileURL(mod("cloak-settings.ts")).href}?env=${i}`);
	envCases.push({
		env: set,
		out: {
			searxngBase: c.SEARXNG_BASE,
			exaBase: c.EXA_BASE,
			camofoxBase: c.CAMOFOX_BASE,
			camofoxApiKey: c.CAMOFOX_API_KEY,
			camofoxUserId: c.CAMOFOX_USER_ID,
			camofoxAutoRestart: c.CAMOFOX_AUTO_RESTART,
			camofoxRestartCmd: c.CAMOFOX_RESTART_CMD,
			debug: s.BROWSER_SEARCH_DEBUG,
			cloakMaxChars: s.CLOAK_MAX_CHARS,
			searxngTimeoutMs: c.SEARXNG_REQUEST_TIMEOUT_MS,
			exaTimeoutMs: c.EXA_REQUEST_TIMEOUT_MS,
			camofoxTimeoutMs: c.CAMOFOX_REQUEST_TIMEOUT_MS,
			maxInlineContent: c.MAX_INLINE_CONTENT,
		},
	});
}
for (const key of envKeys) {
	if (savedEnv[key] === undefined) delete process.env[key];
	else process.env[key] = savedEnv[key];
}
const mainEnv = {
	searxngBase: config.SEARXNG_BASE,
	exaBase: config.EXA_BASE,
	camofoxBase: config.CAMOFOX_BASE,
	camofoxApiKey: config.CAMOFOX_API_KEY,
	camofoxUserId: config.CAMOFOX_USER_ID,
	camofoxAutoRestart: config.CAMOFOX_AUTO_RESTART,
	camofoxRestartCmd: config.CAMOFOX_RESTART_CMD,
	debug: config.BROWSER_SEARCH_DEBUG,
	cloakMaxChars: config.CLOAK_MAX_CHARS,
	searxngTimeoutMs: config.SEARXNG_REQUEST_TIMEOUT_MS,
	exaTimeoutMs: config.EXA_REQUEST_TIMEOUT_MS,
	camofoxTimeoutMs: config.CAMOFOX_REQUEST_TIMEOUT_MS,
	maxInlineContent: config.MAX_INLINE_CONTENT,
};

// ---------------------------------------------------------------------------
// config.ts: resolveBrowserSearchConfig and loadBrowserSearchConfig
// ---------------------------------------------------------------------------

const bs = (value: unknown) => ({ aio: { browserSearch: value } });
const resolvePairs: Array<[unknown, unknown?]> = [
	[{}],
	[bs({ provider: "exa", exa: { apiKeyEnv: "CUSTOM_EXA_KEY", searchType: "fast" } }), bs({ provider: "searxng", searxng: { baseUrl: "https://search.example.com/" } })],
	[bs({ provider: "automatic" })],
	[bs({ provider: "exa", exa: { apiKeyEnv: 42, searchType: "unsupported" }, searxng: "not-an-object" })],
	[bs({ provider: "searxng" }), bs({ provider: null })],
	[bs({ provider: "searxng" }), bs({ provider: "bogus" })],
	[bs({ provider: "searxng" }), bs({ provider: "" })],
	[bs({ provider: "EXA" })],
	[bs({ searxng: { baseUrl: "  http://a///  " }, exa: { baseUrl: "/", apiKeyEnv: "  KEY ", searchType: " deep " } })],
	[bs({ exa: { searchType: "deep-reasoning" } }), bs({ exa: { searchType: "neural", baseUrl: "   " } })],
	[bs({ searxng: { baseUrl: "http://global" } }), bs({ searxng: ["array"] })],
	[bs({ searxng: { baseUrl: "http://global" } }), bs({ searxng: { baseUrl: 7 } })],
	[{ aio: { browserSearch: [] } }],
	[{ aio: [] }],
	[{ aio: { browserSearch: null } }, { aio: null }],
	[bs({ provider: "exa" }), { aio: { other: true } }],
	[bs({ exa: { searchType: "auto" }, provider: "exa" }), bs({ exa: { searchType: "keyword" } })],
	[bs({ exa: { searchType: "hybrid" } }), bs({ exa: { searchType: "instant" } })],
	[bs({ exa: { searchType: "deep-lite" } })],
	[bs({ exa: { searchType: "deep" }, searxng: { baseUrl: "http://x/y/" } })],
];
const resolveCases = resolvePairs.map(([global, project]) => ({
	global,
	project: project ?? null,
	out: clone(project === undefined ? config.resolveBrowserSearchConfig(global) : config.resolveBrowserSearchConfig(global, project)),
}));

// Fixture folders: global settings in agentDir, project settings in <cwd>/.pi.
const loadFolders: Array<{ name: string; global?: string; project?: string }> = [
	{ name: "none" },
	{ name: "global-only", global: JSON.stringify(bs({ provider: "exa" })) },
	{ name: "project-override", global: JSON.stringify(bs({ provider: "exa", exa: { apiKeyEnv: "K" } })), project: JSON.stringify(bs({ provider: "searxng", searxng: { baseUrl: "http://p/" } })) },
	{ name: "bad-global", global: "{not json", project: JSON.stringify(bs({ provider: "searxng" })) },
	{ name: "bad-project", global: JSON.stringify(bs({ provider: "exa" })), project: "[1,2" },
	{ name: "array-global", global: "[1,2,3]", project: JSON.stringify(bs({ provider: "exa" })) },
	{ name: "empty-file", global: "", project: "null" },
];
const loadCases: Array<Record<string, unknown>> = [];
for (const folder of loadFolders) {
	const dir = join(root, "load", folder.name);
	const cwd = join(dir, "work");
	const agent = join(dir, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	if (folder.global !== undefined) writeFileSync(join(agent, "settings.json"), folder.global);
	if (folder.project !== undefined) writeFileSync(join(cwd, ".pi", "settings.json"), folder.project);
	for (const trusted of [true, false]) {
		process.env.PI_CODING_AGENT_DIR = agent;
		const writes: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let out: unknown;
		try {
			out = clone(config.loadBrowserSearchConfig(cwd, trusted));
		} finally {
			process.stderr.write = realWrite;
		}
		loadCases.push({ folder: folder.name, global: folder.global ?? null, project: folder.project ?? null, trusted, out, stderr: writes });
	}
}
process.env.PI_CODING_AGENT_DIR = agentDir;

// ---------------------------------------------------------------------------
// url-validation.ts
// ---------------------------------------------------------------------------

const urlInputs = [
	"https://example.com/path",
	"http://8.8.8.8/",
	"HTTPS://Example.COM:443/x",
	"file:///etc/passwd",
	"ftp://example.com/file",
	"javascript:alert(1)",
	"data:text/html,hi",
	"mailto:someone@example.com",
	"ws://example.com/",
	"http://localhost/admin",
	"http://LOCALHOST./admin",
	"http://localhost:8080",
	"http://service.internal/admin",
	"http://router.local/admin",
	"http://printer.lan",
	"http://router.local./x",
	"http://127.0.0.1",
	"http://10.0.0.1",
	"http://172.16.0.1",
	"http://172.32.0.1",
	"http://192.168.1.1",
	"http://169.254.169.254",
	"http://2130706433",
	"http://0177.0.0.1",
	"http://0x7f.1",
	"http://0x7f000001/",
	"http://127.1",
	"http://1.2.3",
	"http://0",
	"http://100.64.0.1",
	"http://100.128.0.1",
	"http://192.0.0.5",
	"http://192.0.2.1",
	"http://198.51.100.7",
	"http://203.0.113.9",
	"http://224.0.0.1",
	"http://240.0.0.1",
	"http://255.255.255.255",
	"http://256.0.0.1",
	"http://1.2.3.4.5",
	"http://1.2.3.08",
	"http://08.1.1.1",
	"http://1.2.3.4.",
	"http://[::]",
	"http://[::1]",
	"http://[0:0:0:0:0:0:0:1]",
	"http://[fe80::1]",
	"http://[FE80::1%25eth0]",
	"http://[fc00::1]",
	"http://[fd00::1]",
	"http://[ff02::1]",
	"http://[::ffff:127.0.0.1]",
	"http://[::ffff:8.8.8.8]",
	"http://[::ffff:a00:1]",
	"http://[2001:db8::1]",
	"http://[2001:0db8:0000:0000:0000:0000:0000:0001]",
	"http://[1:0:0:2:0:0:0:3]",
	"http://[::1",
	"http://metadata.google.internal/computeMetadata/v1",
	"http://METADATA.GOOGLE.INTERNAL./x",
	"http://instance-data.pai.googleapis.com/",
	"not a url",
	"",
	"http://",
	"https:///nohost",
	"http:example.com/x",
	"http:\\\\example.com\\x",
	"  https://example.com/trim  ",
	"https://exa\tmple.com/",
	"https://user:pass@example.com:8443/",
	"https://user@127.0.0.1/",
	"http://example.com:99999/",
	"http://example.com:abc/",
	"http://exa mple.com/",
	"http://exa%20mple.com/",
	"http://%31%32%37.0.0.1/",
	"http://example.com%2F/",
	"http://xn--nxasmq6b.com/",
	"http://bücher.example/",
	"http://ＥＸＡＭＰＬＥ.com/",
	"http://１２７.０.０.１/",
	"http://127。0。0。1/",
	"http://a..b/",
	"http://.example.com/",
	"http://example.com./",
	"http://0x/",
	"http://0x1g/",
	"http://1.2.3.0x/",
	"http://foo.0x10/",
	"http://foo.09/",
	"http://example.123/",
	"http://example.1a/",
	"foo://bar baz",
	"foo://[::1]/",
	"https://example.com:/",
	"https://example.com:0080/",
	"http://example.com#frag",
	"http://example.com?q=1",
];
const urlCases = urlInputs.map((url) => ({ url, out: urlValidation.validateUrl(url) }));

const dnsTable = (await import(pathToFileURL(join(here, "dns-stub.mjs")).href)).TABLE;
const dnsInputs = [
	"https://public.test/a",
	"https://two.test/a",
	"https://rebind.test/",
	"https://loop6.test/",
	"https://mapped.test/",
	"https://ula.test/",
	"https://empty.test/",
	"https://missing.test/",
	"https://PUBLIC.TEST/",
	"http://8.8.8.8/",
	"http://127.0.0.1/",
	"http://[2001:db8::1]/",
	"not a url",
];
const dnsCases: Array<{ url: string; out: unknown }> = [];
for (const url of dnsInputs) dnsCases.push({ url, out: await urlValidation.validateUrlWithDns(url) });

// ---------------------------------------------------------------------------
// challenges.ts and isLikelyChallengeContent
// ---------------------------------------------------------------------------

const states: unknown[] = [
	{ url: "https://example.com/cdn-cgi/challenge", cookies: [{ name: "__cf_bm" }], html: "<title>Just a moment</title><script src='/cdn-cgi/challenge-platform/x.js'></script>" },
	{ url: "https://example.com", cookies: [{ name: "ak_bmsc" }], html: "Akamai challenge" },
	{ url: "https://example.com/article", html: "<article><h1>Normal page</h1><p>Readable text</p></article>" },
	{ url: "https://x/?__cf_chl_f_tk=1" },
	{ url: "https://x/", headers: { server: "CloudFlare" } },
	{ url: "https://x/", html: "Checking your browser ... Cloudflare" },
	{ url: "https://x/", html: "Just a moment" },
	{ url: "https://x/", html: "Attention Required! Cloudflare" },
	{ url: "https://x/", cookies: [{ name: "_abck" }] },
	{ url: "https://x/", headers: { "x-akamai-request-id": "1" } },
	{ url: "https://x/", html: "/akamai/ Akamai" },
	{ url: "https://x/", cookies: [{ name: "datadome" }] },
	{ url: "https://x/ddl_", html: "/datadome/ Datadome" },
	{ url: "https://x/x-craft-preview", html: "Datadome" },
	{ url: "https://x/", cookies: [{ name: "incap_ses_1" }] },
	{ url: "https://x/", cookies: [{ name: "visid_incap_1" }], headers: { "x-iinfo": "1" } },
	{ url: "https://x/", html: "Imperva /_Incapsula_Resource" },
	{ url: "https://x/", cookies: [{ name: "_px3" }] },
	{ url: "https://x/", html: "PerimeterX /px.js" },
	{ url: "https://x/", html: "/px.js" },
	{ url: "https://x/", cookies: [{ name: "__ddg1" }] },
	{ url: "https://x/", headers: { server: "ddos-guard" }, html: "DDoS-Guard" },
	{ url: "https://x/", cookies: [{ name: "__cfduid" }, { name: "ak_bmsc" }, { name: "_px" }], html: "/cdn-cgi/ PerimeterX" },
	{ url: "https://x/", cookies: [{ name: "datadome" }, { name: "__ddg" }] },
	{ url: "", html: "" },
	{ url: "https://x/", html: "Akamai" },
];
const challengeCases = states.map((state) => ({ state, out: challenges.detectChallenge(state) }));
const longText = "a".repeat(10_005);
const likelyInputs: Array<[string, string | null, string]> = [
	["https://example.com", "Just a moment", "Checking your browser before accessing the site"],
	["https://example.com", null, "Verify you are human"],
	["https://example.com", null, "ENABLE JAVASCRIPT AND COOKIES to continue"],
	["https://example.com", "Security check required", ""],
	["https://example.com", null, "Attention required"],
	["https://example.com", null, "A normal article about browsers."],
	["https://example.com", null, `${longText} just a moment`],
	["https://example.com", null, `${"b".repeat(9_990)} just a moment`],
	["https://example.com/cdn-cgi/x", null, "<script src='/cdn-cgi/x'></script>"],
	["https://example.com", "Title", `${longText}/cdn-cgi/`],
	["https://example.com", null, "Checkİng your browser"],
	["https://example.com", "JUST A MOMENT", "x"],
	["https://example.com", "", "😀".repeat(5_000) + " just a moment"],
];
const likelyCases = likelyInputs.map(([url, title, content]) => ({
	url,
	title,
	content,
	out: index.isLikelyChallengeContent(url, title, content),
}));

// ---------------------------------------------------------------------------
// searxng.ts
// ---------------------------------------------------------------------------

const sxHits = [
	{ title: "One", url: "https://example.com/1", content: "First", engine: "mock", category: "general" },
	{ title: "Two", url: "https://example.com/2", content: "Second", engine: "mock", category: "general", publishedDate: "2026-01-01" },
	{ title: "Missing URL" },
];
const searxngInputs: Array<{ name: string; query: string; opts?: Record<string, unknown>; replies: Reply[] }> = [
	{ name: "basic", query: "release notes", replies: [json({ query: "normalized query", results: sxHits })] },
	{ name: "options", query: "a b&c=d+e/f?é~*'()!", opts: { lang: "en", categories: "news", timeRange: "month", engines: "google,wikipedia", page: 2, numResults: 1 }, replies: [json({ results: sxHits })] },
	{ name: "empty-options", query: "q", opts: { lang: "", categories: "", timeRange: "", engines: "", page: 0, numResults: 0 }, replies: [json({ results: sxHits })] },
	{ name: "num-more", query: "q", opts: { numResults: 10 }, replies: [json({ results: sxHits })] },
	{ name: "base-url", query: "q", opts: { baseUrl: `${base}/other` }, replies: [json({ results: [] })] },
	{ name: "empty-base-url", query: "q", opts: { baseUrl: "" }, replies: [] },
	{ name: "http-500", query: "q", replies: [json({ error: "x" }, 500)] },
	{ name: "http-404", query: "q", replies: [{ status: 404, body: "nope", contentType: "text/plain" }] },
	{ name: "non-json", query: "q", replies: [{ body: "<html>not json</html>", contentType: "text/html" }] },
	{ name: "no-results", query: "q", replies: [json({ query: "q" })] },
	{ name: "null-body", query: "q", replies: [{ body: "null" }] },
	{ name: "number-body", query: "q", replies: [{ body: "42" }] },
	{ name: "results-object", query: "q", replies: [json({ results: { a: 1 } })] },
	{ name: "results-string", query: "q", replies: [json({ results: "abc" })] },
	{ name: "results-number", query: "q", replies: [json({ results: 5 })] },
	{ name: "odd-items", query: "q", replies: [json({ query: null, results: [null, 3, "x", [], { url: "" }, { url: null }, { url: "u", title: null, content: null }] })] },
	{ name: "string-body", query: "q", replies: [json("text")] },
	{ name: "timeout", query: "q", replies: [json({ results: [] }, 200, { delayMs: 900 })] },
	{ name: "unreachable", query: "q", opts: { baseUrl: "http://127.0.0.1:1" }, replies: [] },
];
const searxngCases: Array<Record<string, unknown>> = [];
for (const input of searxngInputs) {
	searxngCases.push({
		...clone(input),
		...(await scripted(input.replies, () => searxng.searxngSearch(input.query, input.opts))),
	});
}

// ---------------------------------------------------------------------------
// exa.ts
// ---------------------------------------------------------------------------

const exaHits = [
	{ title: "Exa result", url: "https://example.com/exa", publishedDate: "2026-01-01", highlights: ["First highlight", "", "Second highlight"] },
	{ title: "Missing URL" },
	{ url: "https://example.com/summary", summary: "  A summary  ", text: "ignored" },
	{ url: "https://example.com/text", text: `  ${"t".repeat(1_200)}  ` },
	{ url: "https://example.com/none", highlights: [], summary: "   ", text: "" },
	{ title: null, url: "https://example.com/hl-space", highlights: [" ", null, 0, "x"] },
];
const exaCfg = { baseUrl: `${base}/exa`, apiKeyEnv: "TEST_EXA_KEY" };
const exaInputs: Array<{ name: string; query: string; opts?: Record<string, unknown>; config?: Record<string, unknown>; replies: Reply[] }> = [
	{ name: "basic", query: "release notes", config: exaCfg, replies: [json({ results: exaHits })] },
	{ name: "filters", query: "q", opts: { numResults: 3, timeRange: "month", includeDomains: ["example.com"], excludeDomains: ["ads.example.com"] }, config: { ...exaCfg, searchType: "fast" }, replies: [json({ results: [] })] },
	{ name: "day", query: "q", opts: { timeRange: "day", includeDomains: [], excludeDomains: [] }, config: exaCfg, replies: [json({ results: [] })] },
	{ name: "week", query: "q", opts: { timeRange: "week" }, config: exaCfg, replies: [json({ results: [] })] },
	{ name: "year", query: "q", opts: { timeRange: "year" }, config: exaCfg, replies: [json({ results: [] })] },
	{ name: "bad-range", query: "q", opts: { timeRange: "decade" }, config: exaCfg, replies: [json({ results: [] })] },
	{ name: "missing-key", query: "q", config: { baseUrl: `${base}/exa`, apiKeyEnv: "MISSING_EXA_KEY" }, replies: [] },
	{ name: "default-key-env", query: "q", config: { baseUrl: `${base}/exa` }, replies: [] },
	{ name: "env-base", query: "q", config: { apiKeyEnv: "TEST_EXA_KEY" }, replies: [json({ results: [] })] },
	{ name: "opts-base", query: "q", opts: { baseUrl: `${base}/optbase` }, config: { apiKeyEnv: "TEST_EXA_KEY" }, replies: [json({ results: [] })] },
	{ name: "empty-base", query: "q", config: { baseUrl: "", apiKeyEnv: "TEST_EXA_KEY" }, replies: [] },
	{ name: "http-401", query: "q", config: exaCfg, replies: [json({ error: "x" }, 401)] },
	{ name: "non-json", query: "q", config: exaCfg, replies: [{ body: "oops", contentType: "text/plain" }] },
	{ name: "null-body", query: "q", config: exaCfg, replies: [{ body: "null" }] },
	{ name: "results-object", query: "q", config: exaCfg, replies: [json({ results: { a: 1 } })] },
	{ name: "null-item", query: "q", config: exaCfg, replies: [json({ results: [{ url: "https://a" }, null] })] },
	{ name: "results-string", query: "q", config: exaCfg, replies: [json({ results: "ab" })] },
	{ name: "results-null", query: "q", config: exaCfg, replies: [json({ results: null })] },
	{ name: "number-body", query: "q", config: exaCfg, replies: [{ body: "42" }] },
	{ name: "odd-items", query: "q", config: exaCfg, replies: [json({ results: [3, "x", [], { url: "" }, { url: "u", title: null, publishedDate: null, highlights: [true, 1.5, { a: 1 }, ["p", "q"], false] }] })] },
	{ name: "timeout", query: "q", config: exaCfg, replies: [json({ results: [] }, 200, { delayMs: 900 })] },
	{ name: "unreachable", query: "q", config: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "TEST_EXA_KEY" }, replies: [] },
];
const exaCases: Array<Record<string, unknown>> = [];
for (const input of exaInputs) {
	exaCases.push({
		...clone(input),
		...(await scripted(input.replies, () => exa.exaSearch(input.query, input.opts, undefined, input.config))),
	});
}

// ---------------------------------------------------------------------------
// camofox.ts
// ---------------------------------------------------------------------------

const article = (fields: Record<string, unknown>) => json({ result: JSON.stringify(fields) });
const okHealth = json({ browserRunning: true });
const tab = json({ tabId: "tab-1", url: "x" });
const closed = json({ closed: true });
const okArticle = article({ title: "Mock article", text: "Readable body", excerpt: "Readable", length: 13 });
const nullArticle = article({ title: null, text: null, excerpt: null, length: 0 });
const camofoxInputs: Array<{ name: string; op: "readability" | "evaluate" | "health"; urls?: string[]; expression?: string; replies: Reply[] }> = [
	{ name: "readability-ok", op: "readability", urls: ["https://8.8.8.8/article"], replies: [okHealth, tab, okArticle, closed] },
	{ name: "lazy-launch", op: "readability", urls: ["https://8.8.8.8/lazy"], replies: [json({ browserRunning: false }), tab, okArticle, closed] },
	{ name: "recovering-503", op: "readability", urls: ["https://8.8.8.8/wedge"], replies: [json({ ok: false, recovering: true }, 503), json({ ok: true }), tab, okArticle, closed] },
	{ name: "recovering-start-fails", op: "readability", urls: ["https://8.8.8.8/wedge"], replies: [json({ recovering: true }, 503), json({ error: "x" }, 500), tab, okArticle, closed] },
	{ name: "health-500", op: "readability", urls: ["https://8.8.8.8/a"], replies: [json({ error: "boom" }, 500), tab, okArticle, closed] },
	{ name: "health-text", op: "readability", urls: ["https://8.8.8.8/a"], replies: [{ body: "fine", contentType: "text/plain" }, tab, okArticle, closed] },
	{ name: "snapshot-fallback", op: "readability", urls: ["https://8.8.8.8/spa"], replies: [okHealth, tab, nullArticle, nullArticle, json({ snapshot: "- heading \"Hi\"", refs: { e1: 1 } }), closed] },
	{ name: "second-attempt", op: "readability", urls: ["https://8.8.8.8/slow"], replies: [okHealth, tab, json({ result: "not json" }), okArticle, closed] },
	{ name: "result-number", op: "readability", urls: ["https://8.8.8.8/n"], replies: [okHealth, tab, json({ result: 5 }), json({}), json([1, 2]), closed] },
	{ name: "result-object", op: "readability", urls: ["https://8.8.8.8/o"], replies: [okHealth, tab, json({ result: { text: "x" } }), json({ result: "" }), { body: "plain snapshot", contentType: "text/plain" }, closed] },
	{ name: "sparse-article", op: "readability", urls: ["https://8.8.8.8/odd"], replies: [okHealth, tab, article({ text: "Only text" }), closed] },
	{ name: "tab-object-id", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, json({ tabId: { a: 1 } }), okArticle, closed] },
	{ name: "unsafe-tab-id", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, json({ tabId: "http://evil/x" })] },
	{ name: "tab-fails", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, json({ error: "no browser" }, 500)] },
	{ name: "tab-timeout", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, json({ tabId: "late" }, 200, { delayMs: 900 })] },
	{ name: "tab-text", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, { body: "weird", contentType: "text/plain" }, okArticle, closed] },
	{ name: "tab-null", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, { body: "null" }] },
	{ name: "tab-number-id", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, json({ tabId: 5 }), okArticle, closed] },
	{ name: "evaluate-fails", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, tab, json({ error: "eval" }, 500), json({}, 500)] },
	{ name: "close-fails", op: "readability", urls: ["https://8.8.8.8/a"], replies: [okHealth, tab, okArticle, json({ error: "gone" }, 404)] },
	{ name: "two-urls", op: "readability", urls: ["https://8.8.8.8/a", "https://8.8.8.8/b"], replies: [okHealth, tab, okArticle, closed, json({ error: "busy" }, 503)] },
	{ name: "health-only", op: "health", replies: [okHealth] },
	{ name: "evaluate-html", op: "evaluate", urls: ["https://8.8.8.8/page"], expression: "document.documentElement?.outerHTML || ''", replies: [okHealth, tab, json({ result: "<html><body>Hi</body></html>" }), closed] },
	{ name: "evaluate-no-result", op: "evaluate", urls: ["https://8.8.8.8/page"], expression: "1+1", replies: [okHealth, tab, json({ value: 2, ok: true }), closed] },
	{ name: "evaluate-null-result", op: "evaluate", urls: ["https://8.8.8.8/page"], expression: "null", replies: [okHealth, tab, json({ result: null }), closed] },
	{ name: "evaluate-error", op: "evaluate", urls: ["https://8.8.8.8/page"], expression: "x", replies: [okHealth, json({ error: "no tab" }, 500)] },
];
const camofoxCases: Array<Record<string, unknown>> = [];
for (const input of camofoxInputs) {
	const run = () => {
		if (input.op === "health") return camofox.health();
		if (input.op === "evaluate") return camofox.evaluateUrl(input.urls![0], input.expression!);
		return camofox.readability(input.urls!);
	};
	const result = await scripted(input.replies, run);
	camofoxCases.push({ ...clone(input), ...result });
}
// ---------------------------------------------------------------------------
// cloak.ts with the fixture worker
// ---------------------------------------------------------------------------

const cloakInputs: Array<{ name: string; url: string; format?: string; maxOutputBytes?: number; timeoutMs?: number }> = [
	{ name: "ok-markdown", url: "https://8.8.8.8/ok", format: "markdown" },
	{ name: "ok-default-format", url: "https://8.8.8.8/ok" },
	{ name: "ok-html", url: "https://8.8.8.8/ok", format: "html" },
	{ name: "worker-error", url: "https://8.8.8.8/error" },
	{ name: "malformed", url: "https://8.8.8.8/malformed" },
	{ name: "shape", url: "https://8.8.8.8/shape" },
	{ name: "oversize", url: "https://8.8.8.8/oversize", maxOutputBytes: 1024 },
	{ name: "hang-timeout", url: "https://8.8.8.8/hang", timeoutMs: 500 },
	{ name: "exited-descendant", url: "https://8.8.8.8/exited-descendant" },
	{ name: "blocked", url: "http://127.0.0.1/private" },
	{ name: "blocked-dns", url: "https://rebind.test/x" },
	{ name: "missing-node", url: "https://8.8.8.8/ok" },
];
const cloakCases: Array<Record<string, unknown>> = [];
for (const input of cloakInputs) {
	const deps = {
		nodeBinary: input.name === "missing-node" ? "/nonexistent/aio-node" : process.execPath,
		workerPath: fixtureWorker,
		timeoutMs: input.timeoutMs ?? 5_000,
		killGraceMs: 50,
		...(input.maxOutputBytes ? { maxOutputBytes: input.maxOutputBytes } : {}),
	};
	const opts: Record<string, unknown> = { url: input.url };
	if (input.format) opts.format = input.format;
	const entry: Record<string, unknown> = { ...input };
	try {
		entry.out = clone(await cloak.cloakFetch(opts, deps));
	} catch (error) {
		entry.error = errorOf(error);
	}
	cloakCases.push(entry);
}

// ---------------------------------------------------------------------------
// index.ts fetchSingleUrl: Camofox, then the CloakBrowser fixture worker
// ---------------------------------------------------------------------------

const snapshotObj = json({ snapshot: "- heading \"Docs\"", refs: { e1: "link" }, count: 2, nested: [1.5, null, true] });
const challengeArticle = article({ title: "Just a moment...", text: "Checking your browser before accessing", excerpt: null, length: 30 });
const fetchInputs: Array<{ name: string; url: string; format: string; replies: Reply[] }> = [
	{ name: "blocked-ip", url: "http://127.0.0.1/private", format: "markdown", replies: [] },
	{ name: "blocked-scheme", url: "file:///etc/passwd", format: "markdown", replies: [] },
	{ name: "blocked-dns", url: "https://rebind.test/x", format: "markdown", replies: [] },
	{ name: "markdown", url: "https://8.8.8.8/article", format: "markdown", replies: [okHealth, tab, okArticle, closed] },
	{ name: "text", url: "https://public.test/article", format: "text", replies: [okHealth, tab, okArticle, closed] },
	{ name: "no-title", url: "https://8.8.8.8/a", format: "markdown", replies: [okHealth, tab, article({ title: null, text: "Body only", excerpt: null, length: 9 }), closed] },
	{ name: "no-title-text", url: "https://8.8.8.8/a", format: "text", replies: [okHealth, tab, article({ title: "", text: "Body only", length: 9 }), closed] },
	{ name: "challenge-cloak", url: "https://8.8.8.8/challenge", format: "markdown", replies: [okHealth, tab, challengeArticle, closed] },
	{ name: "challenge-cloak-error", url: "https://8.8.8.8/error", format: "text", replies: [okHealth, tab, challengeArticle, closed] },
	{ name: "snapshot", url: "https://8.8.8.8/spa", format: "markdown", replies: [okHealth, tab, nullArticle, nullArticle, snapshotObj, closed] },
	{ name: "snapshot-string", url: "https://8.8.8.8/spa", format: "text", replies: [okHealth, tab, nullArticle, nullArticle, { body: "  page text  ", contentType: "text/plain" }, closed] },
	{ name: "snapshot-blank", url: "https://8.8.8.8/shape", format: "markdown", replies: [okHealth, tab, nullArticle, nullArticle, { body: "   ", contentType: "text/plain" }, closed] },
	{ name: "snapshot-empty", url: "https://8.8.8.8/malformed", format: "markdown", replies: [okHealth, tab, nullArticle, nullArticle, { body: "", contentType: "text/plain" }, closed] },
	{ name: "snapshot-challenge", url: "https://8.8.8.8/ok", format: "markdown", replies: [okHealth, tab, nullArticle, nullArticle, json({ html: "<script src='/cdn-cgi/x'></script>" }), closed] },
	{ name: "tab-error", url: "https://8.8.8.8/error", format: "markdown", replies: [okHealth, json({ error: "no browser" }, 500)] },
	{ name: "html", url: "https://8.8.8.8/page", format: "html", replies: [okHealth, tab, json({ result: "<html><body><p>Hello</p></body></html>" }), closed] },
	{ name: "html-object", url: "https://8.8.8.8/page", format: "html", replies: [okHealth, tab, json({ other: "<b>x</b>" }), closed] },
	{ name: "html-null", url: "https://8.8.8.8/ok", format: "html", replies: [okHealth, tab, json({ result: null }), closed] },
	{ name: "html-empty", url: "https://8.8.8.8/ok", format: "html", replies: [okHealth, tab, json({ result: "   " }), closed] },
	{ name: "html-challenge", url: "https://8.8.8.8/ok", format: "html", replies: [okHealth, tab, json({ result: "<p>Attention Required! Cloudflare</p>" }), closed] },
	{ name: "html-error", url: "https://8.8.8.8/shape", format: "html", replies: [okHealth, json({}, 500)] },
];
const fetchCases: Array<Record<string, unknown>> = [];
for (const input of fetchInputs) {
	const result = await scripted(input.replies, () => index.fetchSingleUrl(input.url, input.format));
	fetchCases.push({ ...clone(input), ...result });
}

// ---------------------------------------------------------------------------
// index.ts registerBrowserSearch through a harness
// ---------------------------------------------------------------------------

interface TestTool {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (u: unknown) => void) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
}
function harness(dependencies: Record<string, unknown>) {
	const tools = new Map<string, TestTool>();
	const order: string[] = [];
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		registerTool(tool: TestTool) {
			order.push(tool.name);
			tools.set(tool.name, tool);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "session_start") sessionStart = handler;
		},
	};
	index.registerBrowserSearch(pi, dependencies);
	return { tools, order, start: (cwd: string, trusted: boolean) => sessionStart?.({}, { cwd, isProjectTrusted: () => trusted }), hasStart: () => sessionStart !== undefined };
}
const meta = (tool: TestTool) => ({
	name: tool.name,
	label: tool.label,
	description: tool.description,
	promptSnippet: tool.promptSnippet,
	promptGuidelines: tool.promptGuidelines,
	parameters: clone(tool.parameters),
});
const registrations = (["searxng", "exa"] as const).map((provider) => {
	const h = harness({ provider, search: async () => ({}) });
	return { provider, order: h.order, tools: h.order.map((name) => meta(h.tools.get(name)!)) };
});

// session_start: settings folders decide whether web_search registers.
const sessionFolders: Array<{ name: string; global?: unknown; project?: unknown; trusted: boolean; starts?: number }> = [
	{ name: "unset", trusted: true },
	{ name: "exa-global", global: bs({ provider: "exa" }), trusted: true },
	{ name: "searxng-project", global: bs({ provider: "exa" }), project: bs({ provider: "searxng" }), trusted: true },
	{ name: "searxng-untrusted", global: bs({ provider: "exa" }), project: bs({ provider: "searxng" }), trusted: false },
	{ name: "project-only-untrusted", project: bs({ provider: "searxng" }), trusted: false },
	{ name: "invalid-provider", global: bs({ provider: "google" }), trusted: true },
	{ name: "twice", global: bs({ provider: "searxng" }), trusted: true, starts: 2 },
];
const sessionCases: Array<Record<string, unknown>> = [];
for (const folder of sessionFolders) {
	const dir = join(root, "session", folder.name);
	const agent = join(dir, "agent");
	const cwd = join(dir, "work");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (folder.global) writeFileSync(join(agent, "settings.json"), JSON.stringify(folder.global));
	if (folder.project) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(folder.project));
	process.env.PI_CODING_AGENT_DIR = agent;
	const h = harness({});
	const before = [...h.order];
	for (let i = 0; i < (folder.starts ?? 1); i++) h.start(cwd, folder.trusted);
	const search = h.tools.get("web_search");
	sessionCases.push({
		...folder,
		before,
		after: h.order,
		description: search?.description ?? null,
	});
}
process.env.PI_CODING_AGENT_DIR = agentDir;
const dependencyCases = [
	{ name: "config-empty", deps: { config: {} } },
	{ name: "config-exa", deps: { config: { provider: "exa" } } },
	{ name: "search-only", deps: { search: true } },
	{ name: "provider-and-config", deps: { provider: "searxng", config: { provider: "exa" } } },
].map(({ name, deps }) => {
	const real: Record<string, unknown> = { ...deps };
	if (deps.search) real.search = async () => ({});
	const h = harness(real);
	return { name, deps, order: h.order, sessionStart: h.hasStart(), description: h.tools.get("web_search")?.description ?? null };
});

// Tool executes. Injected backends answer from tables; real backends use the
// scripted server.
type Outcome = { resultCount?: number; results: Array<Record<string, unknown>>; query?: string };
const hit = (i: number, url: string, extra: Record<string, unknown> = {}) => ({
	title: `Result ${i}`,
	url,
	snippet: `Snippet ${i}`,
	engine: "mock",
	category: "general",
	publishedDate: null,
	...extra,
});
const outcome = (results: Array<Record<string, unknown>>, resultCount = results.length): Outcome => ({ resultCount, results });
const page = (url: string, extra: Record<string, unknown> = {}) => ({
	url,
	title: `Page ${url.slice(-1)}`,
	content: `Body for ${url}`,
	format: "markdown",
	chars: `Body for ${url}`.length,
	truncated: false,
	tier: "camofox",
	...extra,
});
const failedPage = (url: string, error: string) => ({ url, content: "", format: "markdown", chars: 0, truncated: false, tier: "none", error });
const bigText = (n: number, ch = "x") => ch.repeat(n);

interface ExecCase {
	name: string;
	tool: "web_search" | "fetch_content";
	provider?: "searxng" | "exa";
	params: Record<string, unknown>;
	search?: Record<string, Outcome | { throw: string }>;
	fetch?: Record<string, Record<string, unknown> | { throw: string }>;
	real?: { config: Record<string, unknown> };
	replies?: Reply[];
}
const execInputs: ExecCase[] = [
	{ name: "search-basic", tool: "web_search", params: { query: "release notes" }, search: { "release notes": outcome([hit(1, "https://8.8.8.8/a"), hit(2, "https://8.8.8.8/b", { snippet: null, engine: null, publishedDate: "2026-01-01", title: null })]) } },
	{ name: "search-no-query", tool: "web_search", params: { query: "   ", queries: [] }, search: {} },
	{ name: "search-queries-dedupe", tool: "web_search", params: { queries: [" a ", "b", "a", 3, ""], query: "ignored" }, search: { a: outcome([]), b: outcome([hit(1, "https://8.8.8.8/b")], 7) } },
	{ name: "search-filters-content", tool: "web_search", params: { query: "release notes", domainFilter: ["example.com", "-ads.example.com", " ", "example.com", "-", 5], recencyFilter: "month", timeRange: "day", provider: "brave", includeContent: true, lang: "en", categories: "news", engines: "g", page: 2, numResults: 3, workflow: "none" }, search: { "release notes site:example.com -site:ads.example.com -site:": outcome([hit(1, "https://8.8.8.8/a"), hit(2, "https://8.8.8.8/b")]) }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { finalUrl: "https://8.8.8.8/a2" }), "https://8.8.8.8/b": { throw: "browsers down" } } },
	{ name: "search-exa-filters", tool: "web_search", provider: "exa", params: { query: "release notes", domainFilter: ["example.com", "-ads.example.com", "- spaced.example "], timeRange: "week" }, search: { "release notes": outcome([hit(1, "https://8.8.8.8/a")]) } },
	{ name: "search-partial-failure", tool: "web_search", params: { queries: ["good", "bad"] }, search: { good: outcome([hit(1, "https://8.8.8.8/a")]), bad: { throw: "searx unavailable" } } },
	{ name: "search-all-fail", tool: "web_search", params: { queries: ["x", "y"] }, search: { x: { throw: "first down" }, y: { throw: "second down" } } },
	{ name: "search-all-fail-exa", tool: "web_search", provider: "exa", params: { query: "x" }, search: { x: { throw: "Exa API key is missing." } } },
	{ name: "search-truncated", tool: "web_search", params: { query: "big" }, search: { big: outcome([hit(1, "https://8.8.8.8/a", { snippet: bigText(3500) })]) } },
	{ name: "search-content-sources", tool: "web_search", params: { query: "q", includeContent: true }, search: { q: outcome([hit(1, "https://8.8.8.8/a"), hit(2, "https://8.8.8.8/b"), hit(3, "https://8.8.8.8/c")]) }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { content: bigText(2500, "a"), title: undefined }), "https://8.8.8.8/b": failedPage("https://8.8.8.8/b", "blocked"), "https://8.8.8.8/c": page("https://8.8.8.8/c", { content: "", error: "" }) } },
	{ name: "search-content-empty-hits", tool: "web_search", params: { query: "q", includeContent: true }, search: { q: outcome([]) } },
	{ name: "search-include-false", tool: "web_search", params: { query: "q", includeContent: "yes" }, search: { q: outcome([hit(1, "https://8.8.8.8/a")]) } },
	{ name: "fetch-single", tool: "fetch_content", params: { url: " https://8.8.8.8/a ", prompt: "ignored" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { finalUrl: "https://8.8.8.8/final", challengeStrategy: null, challengeResolved: false }) } },
	{ name: "fetch-single-same-final", tool: "fetch_content", params: { url: "https://8.8.8.8/a", format: "text" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { finalUrl: "https://8.8.8.8/a", title: "" }) } },
	{ name: "fetch-single-truncated", tool: "fetch_content", params: { url: "https://8.8.8.8/a" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { content: bigText(3200, "é"), title: undefined, truncated: false }) } },
	{ name: "fetch-single-whitespace", tool: "fetch_content", params: { url: "https://8.8.8.8/a" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { truncated: true }) } },
	{ name: "fetch-no-url", tool: "fetch_content", params: { urls: [" "], url: "" }, fetch: {} },
	{ name: "fetch-video", tool: "fetch_content", params: { url: "https://8.8.8.8/a", frames: 2 }, fetch: {} },
	{ name: "fetch-clone", tool: "fetch_content", params: { url: "https://8.8.8.8/a", forceClone: true }, fetch: {} },
	{ name: "fetch-clone-false", tool: "fetch_content", params: { url: "https://8.8.8.8/a", forceClone: false }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a") } },
	{ name: "fetch-model", tool: "fetch_content", params: { url: "https://8.8.8.8/a", model: "x", timestamp: "1:00" }, fetch: {} },
	{ name: "fetch-many", tool: "fetch_content", params: { urls: ["https://8.8.8.8/a", "https://8.8.8.8/b"], url: "https://8.8.8.8/ignored" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a"), "https://8.8.8.8/b": page("https://8.8.8.8/b", { finalUrl: "https://8.8.8.8/b2", challengeStrategy: "cloudflare", challengeResolved: true, tier: "cloak" }) } },
	{ name: "fetch-many-partial", tool: "fetch_content", params: { urls: ["https://8.8.8.8/a", "https://8.8.8.8/b", "https://8.8.8.8/c"] }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { content: bigText(2500, "a") }), "https://8.8.8.8/b": failedPage("https://8.8.8.8/b", "blocked"), "https://8.8.8.8/c": { throw: "exploded" } } },
	{ name: "fetch-many-big", tool: "fetch_content", params: { urls: ["https://8.8.8.8/a", "https://8.8.8.8/b"] }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { content: bigText(1600, "a") }), "https://8.8.8.8/b": page("https://8.8.8.8/b", { content: bigText(1600, "b"), truncated: true }) } },
	{ name: "fetch-all-fail", tool: "fetch_content", params: { urls: ["https://8.8.8.8/a", "https://8.8.8.8/b"] }, fetch: { "https://8.8.8.8/a": failedPage("https://8.8.8.8/a", "down"), "https://8.8.8.8/b": { throw: "boom" } } },
	{ name: "fetch-empty-content", tool: "fetch_content", params: { url: "https://8.8.8.8/a" }, fetch: { "https://8.8.8.8/a": page("https://8.8.8.8/a", { content: "" }) } },
	// Real backends against the scripted server.
	{ name: "real-searxng", tool: "web_search", provider: "searxng", params: { query: "release notes", domainFilter: ["example.com"], recencyFilter: "year", numResults: 1 }, real: { config: { provider: "searxng", searxng: { baseUrl: `${base}/sx2` } } }, replies: [json({ results: sxHits })] },
	{ name: "real-searxng-default-base", tool: "web_search", provider: "searxng", params: { query: "q", includeContent: true }, real: { config: { provider: "searxng" } }, replies: [json({ results: [sxHits[0]] }), okHealth, tab, okArticle, closed] },
	{ name: "real-exa", tool: "web_search", provider: "exa", params: { query: "q", domainFilter: ["a.com", "-b.com"], recencyFilter: "day" }, real: { config: { provider: "exa", exa: { baseUrl: `${base}/exa`, apiKeyEnv: "TEST_EXA_KEY", searchType: "neural" } } }, replies: [json({ results: exaHits.slice(0, 1) })] },
	{ name: "real-exa-missing-key", tool: "web_search", provider: "exa", params: { query: "q" }, real: { config: { provider: "exa", exa: { apiKeyEnv: "NOPE_KEY" } } }, replies: [] },
	{ name: "real-searxng-error", tool: "web_search", provider: "searxng", params: { queries: ["q1", "q2"] }, real: { config: { provider: "searxng" } }, replies: [json({}, 502), { body: "x", contentType: "text/plain" }] },
	{ name: "real-fetch", tool: "fetch_content", params: { url: "https://8.8.8.8/article" }, real: { config: {} }, replies: [okHealth, tab, okArticle, closed] },
	{ name: "real-fetch-many", tool: "fetch_content", params: { urls: ["https://8.8.8.8/article", "http://127.0.0.1/x", "https://8.8.8.8/error"], format: "text" }, real: { config: {} }, replies: [okHealth, tab, okArticle, closed, okHealth, json({}, 500)] },
	{ name: "real-fetch-html", tool: "fetch_content", params: { url: "https://8.8.8.8/page", format: "html" }, real: { config: {} }, replies: [okHealth, tab, json({ result: "<p>Hi</p>" }), closed] },
	{ name: "real-fetch-cloak", tool: "fetch_content", params: { url: "https://8.8.8.8/challenge" }, real: { config: {} }, replies: [okHealth, tab, challengeArticle, closed] },
	{ name: "real-fetch-blocked", tool: "fetch_content", params: { url: "http://localhost/x" }, real: { config: {} }, replies: [] },
];
const execCases: Array<Record<string, unknown>> = [];
for (const input of execInputs) {
	const searchCalls: unknown[] = [];
	const fetchCalls: unknown[] = [];
	const deps: Record<string, unknown> = {};
	if (input.real) {
		deps.config = input.real.config;
		if (input.provider) deps.provider = input.provider;
	} else {
		deps.provider = input.provider ?? "searxng";
		deps.search = async (query: string, options: unknown) => {
			searchCalls.push(clone({ query, options }));
			const entry = input.search?.[query];
			if (!entry) throw new Error(`no scripted search for ${query}`);
			if ("throw" in entry) throw new Error(entry.throw as string);
			return { ok: true, query, parameters: {}, ...entry };
		};
		deps.fetchUrl = async (url: string, format: string) => {
			fetchCalls.push({ url, format });
			const entry = input.fetch?.[url];
			if (!entry) throw new Error(`no scripted fetch for ${url}`);
			if ("throw" in entry) throw new Error(entry.throw as string);
			return entry;
		};
	}
	const h = harness(deps);
	const tool = h.tools.get(input.tool)!;
	const updates: unknown[] = [];
	const result = await scripted(input.replies ?? [], async () => {
		const r = await tool.execute("call-1", clone(input.params), undefined, (u) => updates.push(clone(u)));
		return { text: r.content[0].text, details: r.details };
	});
	execCases.push({ ...clone(input), ...result, updates, searchCalls, fetchCalls });
}

server.close();
rmSync(root, { recursive: true, force: true });

const golden = {
	readability: {
		sha256: createHash("sha256").update(readabilitySource).digest("hex"),
		length: readabilitySource.length,
	},
	env: placeholders(ENV),
	mainEnv: placeholders(mainEnv),
	now: NOW,
	dnsTable,
	envCases,
	resolveCases,
	loadCases: placeholders(loadCases),
	urlCases,
	dnsCases,
	challengeCases,
	likelyCases,
	searxngCases: placeholders(searxngCases),
	exaCases: placeholders(exaCases),
	camofoxCases: placeholders(camofoxCases),
	cloakCases: placeholders(cloakCases),
	fetchCases: placeholders(fetchCases),
	registrations,
	sessionCases: placeholders(sessionCases),
	dependencyCases,
	execCases: placeholders(execCases),
};

const output = `${JSON.stringify(golden, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("browsersearch golden.json is stale: run npx tsx go/internal/browsersearch/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	const counts = Object.entries(golden)
		.filter(([, v]) => Array.isArray(v))
		.map(([k, v]) => `${k}=${(v as unknown[]).length}`)
		.join(" ");
	console.log(`wrote ${counts}`);
}
process.exit(0);
