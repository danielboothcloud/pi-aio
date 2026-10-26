import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings, loadSettings, normalizeSettings, saveSettings, settingsPath } from "./settings.ts";

test("settings decoding rejects malformed values while preserving valid category overrides", () => {
	for (const value of [null, [], "on", 1]) assert.deepEqual(normalizeSettings(value), defaultSettings());
	const decoded = normalizeSettings({ enabled: "false", focusSkip: false, preview: true, minSeconds: Infinity, sound: "Bad;Script", categories: { core: false, critical: "yes", unknown: false } });
	assert.deepEqual(decoded, { ...defaultSettings(), focusSkip: false, preview: true, categories: { ...defaultSettings().categories, core: false } });
});

test("persistent settings use the explicit in-repository sandbox and tolerate broken files", () => {
	const directory = mkdtempSync(join(process.cwd(), ".notify-test-"));
	const previous = process.env.AIO_NOTIFY_SETTINGS_FILE;
	try {
		const file = join(directory, "nested", "settings.json");
		process.env.AIO_NOTIFY_SETTINGS_FILE = file;
		assert.equal(settingsPath(), file);
		assert.deepEqual(loadSettings(), defaultSettings());
		const settings = { ...defaultSettings(), enabled: false, sound: "Ping" };
		saveSettings(settings);
		assert.deepEqual(loadSettings(), settings);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		writeFileSync(file, "not JSON");
		assert.deepEqual(loadSettings(), defaultSettings());
	} finally {
		if (previous === undefined) delete process.env.AIO_NOTIFY_SETTINGS_FILE;
		else process.env.AIO_NOTIFY_SETTINGS_FILE = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
