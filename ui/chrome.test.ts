import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	chromeDivider,
	chromeFrameRow,
	chromeFrameRule,
	chromeHeader,
	chromeHint,
	chromeItem,
	fitLine,
	plural,
} from "./chrome.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_role: string, text: string) => text,
};

test("chrome primitives stay within narrow widths", () => {
	for (const width of [0, 1, 4, 5, 8, 12, 24]) {
		const lines = [
			chromeHeader(theme, { title: "Subagents", meta: "12 active" }, width),
			chromeItem(theme, { label: "long selected item", active: true }, width),
			chromeHint(theme, "Enter confirm · Esc cancel", width),
			chromeDivider(theme, width, "preview"),
			chromeFrameRule(theme, width, "top"),
			chromeFrameRule(theme, width, "divider", "界 preview"),
			chromeFrameRule(theme, width, "bottom"),
			chromeFrameRow(theme, "\x1b[32m界 selected\x1b[0m", width),
			fitLine("very long line", width),
		];
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
});

test("chrome header and item expose a stable visual hierarchy", () => {
	assert.match(chromeHeader(theme, { title: "queue", meta: "2 pending" }, 80), /^▎ QUEUE · 2 pending$/);
	assert.match(chromeItem(theme, { label: "Allow", active: true }, 80), /^ › Allow/);
});

test("frame primitives match the rounded editor geometry and muted role", () => {
	const roles: string[] = [];
	const capturingTheme = { fg: (role: string, text: string) => { roles.push(role); return text; } };
	assert.equal(chromeFrameRule(capturingTheme, 10, "top"), "╭────────╮");
	assert.equal(chromeFrameRule(capturingTheme, 10, "bottom"), "╰────────╯");
	assert.equal(chromeFrameRow(capturingTheme, "hello", 10), "│ hello  │");
	assert.ok(roles.every((role) => role === "borderMuted"));
});

test("plural handles singular and plural labels", () => {
	assert.equal(plural(1, "line"), "1 line");
	assert.equal(plural(2, "line"), "2 lines");
});
