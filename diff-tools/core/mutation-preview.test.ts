import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMutationApprovalPrompt,
	formatMutationPreview,
	formatParsedDiffPlain,
} from "./mutation-preview.js";
import { parseDiff } from "./diff.js";

describe("formatParsedDiffPlain", () => {
	it("renders unified +/- lines", () => {
		const diff = parseDiff("alpha\nbeta\n", "alpha\nBETA\n");
		expect(formatParsedDiffPlain(diff)).toMatch(/^- beta/m);
		expect(formatParsedDiffPlain(diff)).toMatch(/^\+ BETA/m);
	});
});

describe("formatMutationPreview", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mutation-preview-"));
		filePath = join(tempDir, "example.ts");
		writeFileSync(filePath, "const value = 1;\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("previews edit changes before execution", async () => {
		const preview = await formatMutationPreview("edit", {
			path: filePath,
			oldText: "const value = 1;",
			newText: "const value = 2;",
		});

		expect(preview).toMatch(/- const value = 1;/);
		expect(preview).toMatch(/\+ const value = 2;/);
		expect(readFileSync(filePath, "utf8")).toBe("const value = 1;\n");
	});

	it("previews Cursor old_string/new_string edit args", async () => {
		const preview = await formatMutationPreview("edit", {
			path: filePath,
			old_string: "const value = 1;",
			new_string: "const value = 2;",
		});

		expect(preview).toMatch(/- const value = 1;/);
		expect(preview).toMatch(/\+ const value = 2;/);
	});

	it("previews apply_patch updates before execution", async () => {
		const preview = await formatMutationPreview("apply_patch", {
			changes: [
				{
					path: filePath,
					action: "update",
					oldText: "const value = 1;",
					newText: "const value = 42;",
				},
			],
		});

		expect(preview).toMatch(/--- example.ts ---/);
		expect(preview).toMatch(/- const value = 1;/);
		expect(preview).toMatch(/\+ const value = 42;/);
		expect(readFileSync(filePath, "utf8")).toBe("const value = 1;\n");
	});
});

describe("buildMutationApprovalPrompt", () => {
	it("includes the diff preview in the approval prompt", () => {
		const prompt = buildMutationApprovalPrompt(
			"edit",
			"src/example.ts",
			"- old\n+ new",
		);
		expect(prompt).toBe("Allow edit on src/example.ts?\n\n- old\n+ new");
	});
});
