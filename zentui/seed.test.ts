import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedZentuiConfig, ZENTUI_MINIMALIST_SEED } from "./seed.ts";

test("seedZentuiConfig writes minimalist defaults when the file is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-zentui-seed-"));
	const path = join(dir, "zentui.json");

	const result = seedZentuiConfig(path);

	assert.deepEqual(result, { seeded: true, path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ZENTUI_MINIMALIST_SEED);
});

test("seedZentuiConfig writes when the file exists but is empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-zentui-seed-"));
	const path = join(dir, "zentui.json");
	writeFileSync(path, "   \n", "utf8");

	const result = seedZentuiConfig(path);

	assert.equal(result.seeded, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ZENTUI_MINIMALIST_SEED);
});

test("seedZentuiConfig never normalizes an existing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-zentui-seed-"));
	const path = join(dir, "zentui.json");
	const existing = '{"components":{"editor":{"style":"opencode"}}}';
	writeFileSync(path, existing, "utf8");

	const result = seedZentuiConfig(path);

	assert.deepEqual(result, { seeded: false, path, reason: "existing" });
	assert.equal(readFileSync(path, "utf8"), existing);
});

test("seedZentuiConfig preserves unknown fields by refusing to touch existing files", () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-zentui-seed-"));
	const path = join(dir, "zentui.json");
	const existing = '{"future":{"key":true}}';
	writeFileSync(path, existing, "utf8");

	seedZentuiConfig(path);

	assert.equal(readFileSync(path, "utf8"), existing);
});
