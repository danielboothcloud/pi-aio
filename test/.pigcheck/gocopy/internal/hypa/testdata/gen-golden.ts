// Regenerate golden.json from the vendored TypeScript hypa (the reference):
//   npx tsx go/internal/hypa/testdata/gen-golden.ts [--check]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const policy = await import(join(repo, "hypa", "policy.ts"));
const timeout = await import(join(repo, "hypa", "execution-timeout.ts"));
const client = await import(join(repo, "hypa", "rewrite-client.ts"));
const tools = await import(join(repo, "hypa", "tools.ts"));
const index = await import(join(repo, "hypa", "index.ts"));
const home = homedir();
const ph = <T>(v: T): T => {
	const text = JSON.stringify(v).split(home).join("@@HOME@@");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`placeholder broke JSON: ${(error as Error).message}`);
	}
};

const numbers = ["", "5", " 7 ", "0", "-3", "2.5", "1e3", "0x10", "abc", "Infinity"].map((v) => ({ v, r: policy.parsePositiveInteger(v, 42) }));
const flags = ["1", "TRUE", " yes ", "on", "off", "", "2"].map((v) => ({ v, r: policy.parseBooleanFlag(v) }));

const tmp = mkdtempSync(join(tmpdir(), "aio-hypa-golden-"));
const files: Record<string, string> = {
	"full.json": JSON.stringify({ mode: "REPLACE", binary: " /opt/hypa ", rewriteTimeoutMs: 1500, askNonInteractive: "allow", mcpProxyEnabled: true, mcpProxyTimeoutMs: 2.5, piMcpConfigPath: " /m.json " }),
	"junk.json": JSON.stringify([1, 2]),
	"bad.json": "{nope",
	"partial.json": JSON.stringify({ binary: "  ", rewriteTimeoutMs: -1 }),
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text);
const envs: Array<Record<string, string>> = [{}, { HYPA_PI_MODE: "replace", HYPA_BIN: " x ", HYPA_PI_REWRITE_TIMEOUT_MS: "zz", HYPA_PI_ASK_NON_INTERACTIVE: "ALLOW", HYPA_PI_ENABLE_MCP: "yes", HYPA_PI_MCP_PROXY_TIMEOUT_MS: "300", HYPA_PI_MCP_CONFIG: "/c" },
	{ HYPA_PI_ENABLE_MCP_PROXY: "0", HYPA_PI_ENABLE_MCP: "1", HYPA_BIN: "" }];
const configs: unknown[] = [];
for (const file of [...Object.keys(files), "missing.json", ""]) {
	for (const env of envs) {
		try {
			configs.push({ file, env, config: policy.loadConfig(env, file ? join(tmp, file) : undefined) });
		} catch (error) {
			configs.push({ file, env, error: (error as Error).message.replace(/ \/.*$/s, "") });
		}
	}
}
const configPaths = [{}, { HYPA_PI_CONFIG: " none " }, { HYPA_PI_CONFIG: "" }, { HYPA_PI_CONFIG: "/x.json" }].map((env) => ({ env, r: policy.resolveConfigFilePath(env) ?? "" }));
rmSync(tmp, { recursive: true, force: true });

const rewrites = ['{"input":"ls","outcome":"Rewritten","command":"hypa -c ls"}', '{"input":"ls","outcome":"GenericWrapper","command":"hypa x"}', '{"input":"ls","outcome":"Passthrough","command":"ls"}',
	'{"input":"rm -rf /","outcome":"Deny","command":""}', '{"input":"git push","outcome":"Ask","command":""}', '{"input":"a","outcome":"Ask","command":"hypa a"}',
	'{"input":"a","outcome":"Weird","command":"x"}', '{"outcome":"Passthrough","command":"x"}', '{"input":"a","outcome":"Passthrough"}', "not json", '{"input":"a","outcome":[1,2],"command":"x"}']
	.map((stdout) => {
		try {
			const status = policy.mapRewriteResult(policy.parseRewriteJson(stdout));
			return { stdout, status, formatted: policy.formatStatus(status) };
		} catch (error) {
			const message = (error as Error).message;
			return { stdout, error: message.startsWith("hypa rewrite produced invalid JSON") ? "hypa rewrite produced invalid JSON" : message };
		}
	});
const outcomeCases = [{ stdout: "", stderr: "boom", code: 2, killed: false }, { stdout: "  ", stderr: "", code: 3, killed: false }, { stdout: "x", stderr: "", code: 0, killed: true }]
	.map((c) => ({ ...c, formatted: policy.formatStatus(c.killed ? { kind: "error", input: "i", error: "hypa rewrite timed out after 5000ms" } : { kind: "error", input: "i", error: `hypa rewrite produced no JSON (${c.stderr.trim() || `exit code ${c.code}`})` }) }));

const timeouts = [["hypa -c ls", 5], ["  hypa -c ls", 1.5], ["'/opt/my hypa' -c x", 2], ['"C:\\\\bin\\\\HYPA.EXE" -c x', 1], ["ls -la", 5], ["hypa -c ls", 0], ["hypa -c ls", -1], ["hypa -c ls", 0.0005],
	["hypa", 3], ["hypa -c ls", "5"], ["hypa -c ls", null], ["'unterminated -c", 1], ["hypa\t-c x", 2], ["hypa -c ls", 3000000]]
	.map(([command, t]) => ({ command, t, r: timeout.injectExecutionTimeout(command as string, t) }));
const qualifies = [["hypa -c ls", "/opt/hypa"], ["hypa", "/opt/my hypa"], ["hypa -c ls", "hypa"], ["hypa -c ls", ""], ["ls", "/opt/hypa"], ["hypa -c ls", "/x/bin.js"], ["hypa -c ls", "/x/hypa.cmd"], ["hypax", "/opt/hypa"]]
	.map(([command, resolved]) => ({ command, resolved, r: client.qualifyRewrittenHypaCommand(command, resolved, "/usr/bin/node") }));

// Binary resolution with fake files.
const resolutions: unknown[] = [];
for (const [name, existing, path, binary] of [
	["path-native", ["/usr/bin/hypa", "/nm/@hypabolic/hypa-darwin-arm64/bin/hypa"], "/usr/bin:/bin", "hypa"],
	["bundled-native", ["/nm/@hypabolic/hypa-darwin-arm64/bin/hypa", "/nm/@hypabolic/hypa/bin.js"], "/usr/bin", "hypa"],
	["path-js", ["/usr/bin/hypa.js", "/nm/@hypabolic/hypa/bin.js"], "/usr/bin", "hypa.js"],
	["bin-js", ["/nm/@hypabolic/hypa/bin.js"], "/usr/bin", "hypa"],
	["bare", [], "", "hypa"], ["explicit", [], "/usr/bin", "./my/hypa"], ["custom-name", ["/nm/@hypabolic/hypa/bin.js"], "", "hypa2"],
] as const) {
	const exists = (p: string) => (existing as readonly string[]).includes(p);
	const requireResolve = (id: string) => `/nm/${id}`;
	resolutions.push({ name, existing, path, binary, r: client.resolveHypaBinary(binary, { PATH: path }, "darwin", exists, requireResolve as never) });
}
const execArgs = [["/opt/hypa", ["-c", "ls"]], ["/x/bin.JS", ["rewrite"]]].map(([b, a]) => ({ binary: b, args: a, r: client.getExecArgs(b as string, a as string[], "darwin", "/usr/bin/node") }));

const quotes = ["", "plain_./:=@,+%^-", "a b", "it's", "*.ts", "~x"].map((v) => ({ v, r: tools.shellQuote(v, "darwin") }));
const reads = [["src/a.ts"], ["@~/x.ts"], ["~"], ["-weird"], ["a.ts", 3], ["a.ts", 0.5, 2.7], ["a.ts", undefined, 0], ["-x.ts", 2, 3], ["a b.ts", 10, 5]]
	.map(([p, o, l]) => ({ path: p, offset: o ?? null, limit: l ?? null, r: tools.buildReadCommand(p as string, o as number | undefined, l as number | undefined) }));
const greps = [{ pattern: "foo" }, { pattern: "-x", path: "@src", glob: "*.ts", ignoreCase: true, literal: true, context: 2.7, limit: 0 }, { pattern: "a b", path: "", glob: "", context: -1, limit: 5.9 }, { pattern: "it's", path: "~/x" }]
	.map((p) => ({ p, r: tools.buildGrepCommand(p) }));
const finds = [{}, { pattern: "*.go", path: "~" }, { pattern: "", path: "" }].map((p) => ({ p, r: tools.buildFindCommand(p) }));
const lss = [{}, { path: "src", all: true }, { long: false }, { long: false, all: true, path: "@x y" }, { path: "" }].map((p) => ({ p, r: tools.buildLsCommand(p) }));
const limits = [["a\nb\n\nc\n", 2], ["a\r\nb", 0.5], ["", 3], ["a\nb", undefined], ["\n\n", 1]].map(([s, l]) => ({ s, l: l ?? null, r: tools.limitStdoutLines(s as string, l as number | undefined) }));
const raws = ["ls -la src", "  git   status  ", "echo $HOME", "a|b", "", "x 'y'", "a\nb", "ls (x)"].map((c) => {
	try {
		return { c, r: tools.splitRawCommand(c) };
	} catch (error) {
		return { c, error: (error as Error).message };
	}
});
const big = Array.from({ length: 2600 }, (_, i) => `line ${i} ${"x".repeat(i % 50)}`).join("\n");
const wide = "日本語".repeat(30000);
const replaceCases = [[["read", "bash", "hypa_shell", "hypa_read", "ls"], "replace"], [["read", "bash", "hypa_shell"], "additive"], [["grep", "find", "hypa_grep"], "replace"]]
	.map(([list, mode]) => ({ list, mode, r: index.applyReplaceModeFilter(list as string[], mode as string) }));

// Image sniffing on synthetic buffers.
const png = (chunks: string[]) => {
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
	for (const type of chunks) {
		const len = type === "IHDR" ? 13 : 4;
		const head = Buffer.alloc(8);
		head.writeUInt32BE(len, 0);
		head.write(type, 4, "ascii");
		parts.push(head, Buffer.alloc(len), Buffer.alloc(4));
	}
	return Buffer.concat(parts);
};
const buffers: Record<string, Buffer> = {
	jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), jpegls: Buffer.from([0xff, 0xd8, 0xff, 0xf7]), png: png(["IHDR", "IDAT"]), apng: png(["IHDR", "acTL", "IDAT"]),
	pngShort: png([]), pngBadIhdr: Buffer.concat([png([]), Buffer.from([0, 0, 0, 5, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0])]),
	gif: Buffer.from("GIF89a..."), webp: Buffer.from("RIFF\0\0\0\0WEBPVP8 "), text: Buffer.from("hello world"), binary: Buffer.from([1, 2, 0, 3]), empty: Buffer.alloc(0),
};
const images = Object.entries(buffers).map(([name, b]) => ({ name, hex: b.toString("hex"), mime: tools.detectSupportedImageMimeType(b) ?? "", opaque: tools.looksLikeOpaqueBinary(b) }));

// The tool result text: drive the real hypa_shell/find tools with a fake exec.
const toolRuns: unknown[] = [];
for (const [name, params, result] of [
	["shell-ok", { command: "ls" }, { stdout: "a\nb\n", stderr: "", code: 0 }],
	["shell-both", { command: "x", timeoutMs: 1500.7 }, { stdout: "out", stderr: "err", code: 1 }],
	["shell-empty", { command: "x" }, { stdout: "", stderr: "", code: 3 }],
	["shell-killed", { command: "x" }, { stdout: "partial", stderr: "", code: 0, killed: true }],
	["shell-raw", { command: "git status", raw: true }, { stdout: "ok", stderr: "", code: 0 }],
	["find-limit", { pattern: "*.ts", limit: 2 }, { stdout: "a.ts\nb.ts\nc.ts\n", stderr: "", code: 0 }],
	["grep", { pattern: "x", path: "src" }, { stdout: "src/a.ts\n1:x\n", stderr: "", code: 0 }],
	["ls", { path: "@d", all: true }, { stdout: "f\n", stderr: "", code: 0 }],
	["shell-big", { command: "x" }, { stdout: big, stderr: "", code: 0 }],
	["read-big", { path: "src/a.ts" }, { stdout: big, stderr: "", code: 0 }],
	["shell-wide", { command: "x" }, { stdout: wide, stderr: "", code: 0 }],
	["read-wide", { path: "w.txt", offset: 2 }, { stdout: wide, stderr: "tail", code: 0 }],
] as const) {
	const calls: unknown[] = [];
	const registered = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }> }>();
	tools.registerHypaTools({ exec: async (bin: string, args: string[], opts: unknown) => { calls.push({ bin, args, opts }); return result; }, registerTool: (d: { name: string; execute: never }) => registered.set(d.name, d) } as never,
		{ mode: "additive", binary: "/opt/hypa", rewriteTimeoutMs: 5000, askNonInteractive: "deny", mcpProxyEnabled: false, mcpProxyTimeoutMs: 10000 });
	const tool = name.startsWith("find") ? "hypa_find" : name.startsWith("grep") ? "hypa_grep" : name.startsWith("ls") ? "hypa_ls" : name.startsWith("read") ? "hypa_read" : "hypa_shell";
	const out = await registered.get(tool)!.execute("t", params, undefined, undefined, undefined);
	toolRuns.push({ name, tool, params, result, calls, text: out.content[0].text.replace(/Full output saved to: \S+\]/, "Full output saved to: @@PATH@@]") });
}

const doc = `${JSON.stringify(ph({ numbers, flags, files, envs, configs, configPaths, rewrites, outcomeCases, timeouts, qualifies, resolutions, execArgs, quotes, reads, greps, finds, lss, limits, raws, replaceCases, images, toolRuns }), null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== doc) {
		console.error("hypa golden.json is stale: run npx tsx go/internal/hypa/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`hypa golden.json is current (${toolRuns.length} tool runs)`);
} else {
	writeFileSync(goldenPath, doc);
	console.log(`hypa golden.json: ${configs.length} configs, ${timeouts.length} timeouts, ${toolRuns.length} tool runs`);
}
