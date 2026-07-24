import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_STATUS_LINE_CONFIG,
	loadStatusLineConfig,
} from "./config.ts";
import {
	formatWorkingMessage,
	renderStatusLine,
	type StatusLineRenderInput,
} from "./render.ts";

const theme = {
	fg: (_name: string, text: string) => text,
};

function baseInput(
	overrides: Partial<StatusLineRenderInput> = {},
): StatusLineRenderInput {
	return {
		width: 120,
		theme,
		config: DEFAULT_STATUS_LINE_CONFIG,
		cwd: "/Users/me/projects/pi-aio",
		model: { provider: "cursor", id: "composer-2.5" },
		mode: "plan",
		gitBranch: "main",
		contextPercent: 42,
		extensionStatuses: new Map([["rtk", "rtk✓"]]),
		usageStats: { input: 1200, output: 340, cost: 0.012 },
		...overrides,
	};
}

test("renderStatusLine joins default segments with separators", () => {
	const [line] = renderStatusLine(baseInput());
	assert.match(line, /Plan/);
	assert.match(line, /pi-aio/);
	assert.match(line, /main/);
	assert.match(line, /42%/);
	assert.match(line, /rtk✓/);
	assert.match(line, /cursor\/composer-2\.5/);
	assert.match(line, / · /);
});

test("renderStatusLine omits empty git segment", () => {
	const [line] = renderStatusLine(baseInput({ gitBranch: null }));
	assert.doesNotMatch(line, /\bmain\b/);
	assert.match(line, /Plan/);
});

test("renderStatusLine truncates to width", () => {
	const [line] = renderStatusLine(
		baseInput({
			width: 24,
			config: {
				...DEFAULT_STATUS_LINE_CONFIG,
				segments: ["mode", "path", "git", "context", "statuses", "model"],
			},
		}),
	);
	assert.ok(visibleWidth(line) <= 24);
});

test("renderStatusLine uses abbreviated path display", () => {
	const [line] = renderStatusLine(
		baseInput({
			config: {
				...DEFAULT_STATUS_LINE_CONFIG,
				path: "abbreviated",
			},
		}),
	);
	assert.match(line, /…\/projects\/pi-aio/);
});

test("formatWorkingMessage respects mode", () => {
	const stats = {
		input: 100,
		output: 50,
		cost: 0.01,
		contextPercent: 10,
		elapsedSec: 1.2,
		tps: 4.5,
	};
	assert.equal(formatWorkingMessage("minimal", stats), "Working…");
	assert.equal(formatWorkingMessage("off", stats), undefined);
	assert.match(formatWorkingMessage("verbose", stats)!, /Working \(1\.2s/);
});

test("loadStatusLineConfig merges project and global aio.statusLine settings", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						enabled: false,
						workingMessage: "verbose",
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(tmpDir);
		assert.equal(config.enabled, false);
		assert.equal(config.workingMessage, "verbose");
		assert.deepEqual(config.segments, DEFAULT_STATUS_LINE_CONFIG.segments);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
