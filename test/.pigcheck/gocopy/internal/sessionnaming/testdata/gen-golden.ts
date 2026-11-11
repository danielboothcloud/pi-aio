// Regenerate golden.json from the TypeScript session-naming (the reference):
//   npx tsx go/internal/sessionnaming/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const naming = await import(join(repo, "session-naming", "index.ts"));

const titles = ["Fix the login bug", "  \n\nTitle: \"Refactor parser\"\nmore", "# Add **tests**", "\x1b[1mBold\x1b[0m title", "\x1b]8;;u\x07Link\x1b]8;;\x07 text",
	"Zero\u200bwidth\u0007bell", "'quoted'", "`code`", "TITLE:   x", "x".repeat(100), "😀".repeat(90), "\r\n\r\nSecond", "", "\x1b[2;3Hmove", "\x1b[unterminated"]
	.map((text) => ({ text, title: naming.cleanSessionTitle(text) }));

// Drive the real handlers: eligibility at session_start, then the request at agent_end.
type Entry = Record<string, unknown>;
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): Entry => ({ type: "message", message: { role, content, ...extra } });
const cases: Array<{ name: string; reason: string; named?: boolean; header?: Record<string, unknown>; startEntries: Entry[]; branch: Entry[] }> = [
	{ name: "fresh", reason: "startup", startEntries: [], branch: [msg("user", "Fix <b>x</b> & y\u2028z"), msg("assistant", [{ type: "text", text: "Done" }, { type: "thinking", thinking: "t" }], { stopReason: "stop" })] },
	{ name: "new", reason: "new", startEntries: [{ type: "custom" }, msg("system", "s")], branch: [msg("user", [{ type: "text", text: "a" }, { type: "text", text: "b" }]), msg("assistant", "ok", { stopReason: "stop" })] },
	{ name: "resume", reason: "resume", startEntries: [], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "named", reason: "startup", named: true, startEntries: [], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "forked", reason: "startup", header: { parentSession: "/p.jsonl" }, startEntries: [], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "hasMessages", reason: "startup", startEntries: [msg("user", "old")], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "compacted", reason: "startup", startEntries: [{ type: "compaction" }], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "errored", reason: "startup", startEntries: [], branch: [msg("user", "x"), msg("assistant", "y", { stopReason: "error" })] },
	{ name: "blankUser", reason: "startup", startEntries: [], branch: [msg("user", "   "), msg("assistant", "y", { stopReason: "stop" })] },
	{ name: "long", reason: "startup", startEntries: [], branch: [msg("user", "u".repeat(5000)), msg("assistant", "a".repeat(100)), msg("user", "second"), msg("assistant", "😀".repeat(1500), { stopReason: "stop" })] },
];
const flows: unknown[] = [];
const savedChild = process.env.AIO_SUBAGENT_CHILD;
delete process.env.AIO_SUBAGENT_CHILD;
for (const c of cases) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const requests: unknown[] = [];
	const pi = { on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, fn), getSessionName: () => (c.named ? "Named" : undefined), setSessionName: () => {} };
	naming.registerSessionNaming(pi as never, { timeoutMs: 50 });
	let entries = c.startEntries;
	const ctx = {
		model: { provider: "p", id: "m" },
		sessionManager: { getHeader: () => c.header ?? {}, getEntries: () => entries, getBranch: () => entries, getSessionId: () => "s" },
		modelRegistry: { streamSimple: (_model: unknown, request: { messages: Array<{ content: string }>; systemPrompt: string }) => { requests.push(request.messages[0].content); return { result: async () => ({ stopReason: "stop", content: [] }) }; } },
	};
	await handlers.get("session_start")!({ reason: c.reason }, ctx);
	entries = c.branch;
	await handlers.get("agent_end")!({}, ctx);
	await new Promise((r) => setTimeout(r, 0));
	flows.push({ ...c, prompt: requests[0] ?? null });
}
if (savedChild !== undefined) process.env.AIO_SUBAGENT_CHILD = savedChild;

const output = `${JSON.stringify({ titles, flows }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("session-naming golden.json is stale: run npx tsx go/internal/sessionnaming/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`session-naming golden.json is current (${flows.length} flows)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`session-naming golden.json: ${titles.length} titles, ${flows.length} flows`);
}
