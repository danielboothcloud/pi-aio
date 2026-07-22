import { describe, expect, it } from "vitest";

import {
	getEditOperations,
	normalizeEditParams,
	resolveApplyPatchChanges,
} from "./cursor-compat.js";

describe("getEditOperations", () => {
	it("accepts Cursor old_string/new_string at top level", () => {
		const operations = getEditOperations({
			path: "/tmp/file.ts",
			old_string: "const a = 1;",
			new_string: "const a = 2;",
		});

		expect(operations).toEqual([
			{ oldText: "const a = 1;", newText: "const a = 2;" },
		]);
	});

	it("accepts Cursor keys inside edits array", () => {
		const operations = getEditOperations({
			path: "/tmp/file.ts",
			edits: [{ old_string: "a", new_string: "b" }],
		});

		expect(operations).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("still accepts Pi-native oldText/newText", () => {
		const operations = getEditOperations({
			path: "/tmp/file.ts",
			oldText: "x",
			newText: "y",
		});

		expect(operations).toEqual([{ oldText: "x", newText: "y" }]);
	});

	it("returns empty when no replacement is present", () => {
		expect(getEditOperations({ path: "/tmp/file.ts" })).toEqual([]);
		expect(
			getEditOperations({ path: "/tmp/file.ts", old_string: "same", new_string: "same" }),
		).toEqual([]);
	});
});

describe("normalizeEditParams", () => {
	it("adds Pi-native edits from Cursor top-level keys", () => {
		const normalized = normalizeEditParams({
			path: "/tmp/file.ts",
			old_string: "before",
			new_string: "after",
		});

		expect(normalized.edits).toEqual([{ oldText: "before", newText: "after" }]);
		expect(normalized.oldText).toBe("before");
		expect(normalized.newText).toBe("after");
	});
});

describe("resolveApplyPatchChanges", () => {
	it("converts Cursor unified patch strings to update changes", () => {
		const patch = [
			"--- a/modules/fusion/main.tf",
			"+++ b/modules/fusion/main.tf",
			"@@ -1,3 +1,4 @@",
			" line1",
			"-line2",
			"+line2-updated",
			" line3",
		].join("\n");

		const changes = resolveApplyPatchChanges({ patch });

		expect(changes).toEqual([
			{
				path: "modules/fusion/main.tf",
				action: "update",
				oldText: "line1\nline2\nline3",
				newText: "line1\nline2-updated\nline3",
			},
		]);
	});

	it("normalizes old_string/new_string inside structured changes", () => {
		const changes = resolveApplyPatchChanges({
			changes: [
				{
					path: "/tmp/file.ts",
					action: "update",
					old_string: "a",
					new_string: "b",
				},
			],
		});

		expect(changes).toEqual([
			{
				path: "/tmp/file.ts",
				action: "update",
				oldText: "a",
				newText: "b",
			},
		]);
	});

	it("prefers structured changes when both patch and changes are present", () => {
		const changes = resolveApplyPatchChanges({
			patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
			changes: [
				{
					path: "/tmp/preferred.ts",
					action: "update",
					oldText: "1",
					newText: "2",
				},
			],
		});

		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe("/tmp/preferred.ts");
	});
});
