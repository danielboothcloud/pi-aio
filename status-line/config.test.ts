import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_STATUS_LINE_CONFIG, loadStatusLineConfig } from "./config.ts";

test("loadStatusLineConfig returns defaults when settings are absent", () => {
	assert.deepEqual(loadStatusLineConfig("/does/not/exist"), DEFAULT_STATUS_LINE_CONFIG);
});

test("loadStatusLineConfig ignores invalid segment names", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-config-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						segments: ["mode", "invalid", "model"],
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(tmpDir);
		assert.deepEqual(config.segments, ["mode", "model"]);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
