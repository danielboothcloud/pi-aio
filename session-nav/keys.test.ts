import assert from "node:assert/strict";
import { test } from "node:test";
import { type ListKeyState, listKey, searchLabel } from "./keys.ts";

const normal: ListKeyState = { mode: "normal", query: "" };
const theme = { fg: (_role: string, text: string) => text };

function type(state: ListKeyState, keys: string[]): ListKeyState {
	return keys.reduce((current, key) => listKey(current, key, 5).state, state);
}

test("normal mode: hjkl, g/G and arrows navigate", () => {
	assert.deepEqual(listKey(normal, "j", 5).action, { type: "move", delta: 1 });
	assert.deepEqual(listKey(normal, "k", 5).action, { type: "move", delta: -1 });
	assert.deepEqual(listKey(normal, "g", 5).action, { type: "move", delta: -Infinity });
	assert.deepEqual(listKey(normal, "G", 5).action, { type: "move", delta: Infinity });
	assert.deepEqual(listKey(normal, "h", 5).action, { type: "left" });
	assert.deepEqual(listKey(normal, "l", 5).action, { type: "right" });
	assert.deepEqual(listKey(normal, "\x1b[A", 5).action, { type: "move", delta: -1 });
	assert.deepEqual(listKey(normal, "\x1b[B", 5).action, { type: "move", delta: 1 });
	assert.deepEqual(listKey(normal, "\x1b[5~", 5).action, { type: "move", delta: -5 });
	assert.deepEqual(listKey(normal, "\x1b[6~", 5).action, { type: "move", delta: 5 });
	assert.deepEqual(listKey(normal, "\x1b[H", 5).action, { type: "move", delta: -Infinity });
	assert.deepEqual(listKey(normal, "\x1b[F", 5).action, { type: "move", delta: Infinity });
	assert.deepEqual(listKey(normal, "\x1b[D", 5).action, { type: "left" });
	assert.deepEqual(listKey(normal, "\x1b[C", 5).action, { type: "right" });
	assert.deepEqual(listKey(normal, "\r", 5).action, { type: "enter" });
	// Other letters never edit the filter in normal mode.
	assert.deepEqual(listKey(normal, "x", 5), { state: normal, action: { type: "none" } });
});

test("/ enters search, where every printable key edits the filter", () => {
	const searching = listKey(normal, "/", 5);
	assert.deepEqual(searching, { state: { mode: "search", query: "" }, action: { type: "mode" } });
	const state = type(searching.state, ["h", "j", "k", "l", "/", "g", "G"]);
	assert.deepEqual(state, { mode: "search", query: "hjkl/gG" });
	assert.deepEqual(listKey(state, "\x7f", 5).state.query, "hjkl/g");
	// Arrows and enter still navigate while searching.
	assert.deepEqual(listKey(state, "\x1b[B", 5).action, { type: "move", delta: 1 });
	assert.deepEqual(listKey(state, "\r", 5).action, { type: "enter" });
});

test("esc: search → normal keeps the filter, then clears it, then escapes", () => {
	const searching = type(normal, ["/", "a", "b"]);
	const back = listKey(searching, "\x1b", 5);
	assert.deepEqual(back, { state: { mode: "normal", query: "ab" }, action: { type: "mode" } });
	assert.deepEqual(listKey(back.state, "j", 5).action, { type: "move", delta: 1 });
	const cleared = listKey(back.state, "\x1b", 5);
	assert.deepEqual(cleared, { state: normal, action: { type: "query" } });
	assert.deepEqual(listKey(cleared.state, "\x1b", 5), { state: normal, action: { type: "escape" } });
});

test("ctrl+c is left to the view", () => {
	assert.deepEqual(listKey(normal, "\x03", 5).action, { type: "none" });
	assert.deepEqual(listKey({ mode: "search", query: "" }, "\x03", 5).action, { type: "none" });
});

test("search label shows the mode", () => {
	assert.equal(searchLabel(theme, { mode: "search", query: "ab" }, "hint"), "/ab▏");
	assert.equal(searchLabel(theme, { mode: "normal", query: "ab" }, "hint"), "/ab");
	assert.equal(searchLabel(theme, normal, "hint"), "hint");
});
