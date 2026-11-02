import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ResumePicker, type ResumeScope } from "./resume-view.ts";
import { groupFor, readLastExchange, type SessionLike, sessionTitle } from "./sessions.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const NOW = new Date(2026, 10, 2, 15, 0, 0).getTime(); // local 15:00
const HOUR = 3600_000;

function session(id: string, hoursAgo: number, extra: Partial<SessionLike> = {}): SessionLike {
	return {
		path: `/s/${id}.jsonl`,
		id,
		cwd: "/home/me/projects/seeker",
		created: new Date(NOW - hoursAgo * HOUR),
		modified: new Date(NOW - hoursAgo * HOUR),
		messageCount: 10,
		firstMessage: `prompt ${id}`,
		allMessagesText: `prompt ${id}`,
		...extra,
	};
}

const folder = [
	session("a", 0.1, { firstMessage: '<skill name="bmad-code-review" location="/x">body</skill>\n\nreview 2.2', messageCount: 111 }),
	session("b", 4, { name: "Spec story 2.2 priorities", messageCount: 217 }),
	session("c", 19, { messageCount: 1 }),
	session("d", 24 * 10),
];
const everywhere = [...folder, session("e", 2, { cwd: "/home/me/projects/pi-aio", firstMessage: "debug the hang" })];

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function picker(maxRows = 30) {
	const results: (string | undefined)[] = [];
	const loads: ResumeScope[] = [];
	const view = new ResumePicker({
		theme,
		cwd: "/home/me/projects/seeker",
		currentPath: "/s/a.jsonl",
		homeDir: "/home/me",
		loadSessions: async (scope) => {
			loads.push(scope);
			return scope === "folder" ? folder : everywhere;
		},
		loadPreview: async (path) => ({ lastReply: `reply in ${path}` }),
		maxRows: () => maxRows,
		done: (path) => results.push(path),
		requestRender: () => {},
		now: () => NOW,
	});
	return { view, results, loads };
}

test("titles prefer names, then clean first prompts", () => {
	assert.equal(sessionTitle(folder[0]!), "skill: bmad-code-review — review 2.2");
	assert.equal(sessionTitle(folder[1]!), "Spec story 2.2 priorities");
	assert.equal(sessionTitle(session("x", 1, { firstMessage: "" })), "(empty session)");
});

test("day groups use the local calendar", () => {
	assert.equal(groupFor(NOW - HOUR, NOW), "today");
	assert.equal(groupFor(NOW - 19 * HOUR, NOW), "yesterday");
	assert.equal(groupFor(NOW - 72 * HOUR, NOW), "this week");
	assert.equal(groupFor(NOW - 240 * HOUR, NOW), "earlier");
});

test("picker groups sessions, labels counts, previews lazily", async () => {
	const { view } = picker();
	assert.match(view.render(100).join("\n"), /Loading sessions/);
	await flush();
	let text = view.render(100).join("\n");
	assert.match(text, /RESUME · seeker/);
	assert.match(text, /◉ this folder/);
	assert.match(text, /today[\s\S]*skill: bmad-code-review[\s\S]*yesterday[\s\S]*earlier/);
	assert.match(text, /open now · 6m · 111 msgs/);
	assert.match(text, /1 msg\b/);
	await flush();
	text = view.render(100).join("\n");
	assert.match(text, /started  skill: bmad-code-review/);
	assert.match(text, /last     reply in \/s\/a.jsonl/);
});

test("tab switches to all folders, enter returns the selected path", async () => {
	const { view, results, loads } = picker();
	await flush();
	view.handleInput("\t");
	await flush();
	assert.deepEqual(loads, ["folder", "all"]);
	const text = view.render(100).join("\n");
	assert.match(text, /◉ all/);
	assert.match(text, /debug the hang\s+pi-aio · 2h · 10 msgs/);
	for (const char of "hang") view.handleInput(char);
	view.handleInput("\r");
	assert.deepEqual(results, ["/s/e.jsonl"]);
});

test("search filters; esc clears it before closing", async () => {
	const { view, results } = picker();
	await flush();
	for (const char of "spec") view.handleInput(char);
	assert.equal(view.selected()?.id, "b");
	assert.doesNotMatch(view.render(100).join("\n"), /bmad/);
	view.handleInput("\x1b");
	assert.equal(view.query, "");
	view.handleInput("\x1b");
	assert.deepEqual(results, [undefined]);
});

test("every line fits the width; rows respect maxRows", async () => {
	for (const width of [8, 24, 60, 120]) {
		const { view } = picker(12);
		await flush();
		await flush();
		const lines = view.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		assert.ok(lines.length <= 14, `${width}: ${lines.length} rows`);
	}
});

test("readLastExchange reads only the tail and finds the latest prompt/reply", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-session-nav-"));
	try {
		const file = join(dir, "s.jsonl");
		const filler = Array.from({ length: 2000 }, (_, i) =>
			JSON.stringify({ type: "message", message: { role: "user", content: `old ${i} ${"x".repeat(200)}` } }));
		const tail = [
			JSON.stringify({ type: "message", message: { role: "user", content: "latest prompt" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } }),
			JSON.stringify({ type: "custom", data: {} }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest reply" }] } }),
		];
		writeFileSync(file, `${[...filler, ...tail].join("\n")}\n`);
		assert.deepEqual(await readLastExchange(file, 4096), { lastReply: "latest reply", lastPrompt: "latest prompt" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
