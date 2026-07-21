import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeApplyPatch } from "./apply-patch.js";

describe("executeApplyPatch source-safe updates", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
		filePath = join(tempDir, "source.ts");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves the source indentation when matching an unambiguous shifted block", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n    second();\n}\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n  second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n    secondUpdated();\n}\n");
	});

	it("rejects a stale block instead of replacing everything between loose anchors", async () => {
		const source = "function f() {\n  keep1();\n  keep2();\n  keep3();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "function f() {\n  keep1();\n  invented();\n}",
				newText: "REPLACED",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("does not apply earlier changes when a later change is invalid", async () => {
		const otherPath = join(tempDir, "other.ts");
		writeFileSync(filePath, "const first = 1;\n");
		writeFileSync(otherPath, "const second = 2;\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "const first = 1;", newText: "const first = 10;" },
			{ path: otherPath, action: "update", oldText: "missing", newText: "const second = 20;" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("const first = 1;\n");
		expect(readFileSync(otherPath, "utf8")).toBe("const second = 2;\n");
	});

	it("does not overwrite existing files for add or move", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "move-destination.ts");
		writeFileSync(filePath, "original add target\n");
		writeFileSync(sourcePath, "source\n");
		writeFileSync(destinationPath, "destination\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "add", content: "replacement" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("original add target\n");
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(readFileSync(destinationPath, "utf8")).toBe("destination\n");
	});

	it("preserves CRLF when applying an indentation-adjusted single-line update", async () => {
		writeFileSync(filePath, "function f() {\r\n    first();\r\n}\r\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first(); ",
				newText: "  firstUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\r\n    firstUpdated();\r\n}\r\n");
	});

	it("rejects a partial-indentation exact match that would alter source indentation", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first();", newText: "firstUpdated();" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("does not duplicate a trailing newline for an indentation-adjusted match", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n}\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first(); \n", newText: "  firstUpdated();\n" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n}\n");
	});

	it("rejects a mid-indent exact match that inserts multiple lines", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();",
				newText: "  firstUpdated();\n  inserted();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects a multi-line exact match that starts inside source indentation", async () => {
		const source = "function f() {\n    first();\n    second();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n    second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects batches whose operations would target the same path", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "new-target.ts");
		writeFileSync(sourcePath, "source\n");

		const result = await executeApplyPatch([
			{ path: destinationPath, action: "add", content: "new file" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(() => lstatSync(destinationPath)).toThrow();
	});

	it("preserves executable modes and refuses to replace symlinks", async () => {
		writeFileSync(filePath, "run\n");
		chmodSync(filePath, 0o755);
		const executableResult = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "run", newText: "run updated" },
		]);
		expect(executableResult.ok).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o755);

		const targetPath = join(tempDir, "target.ts");
		const linkPath = join(tempDir, "link.ts");
		writeFileSync(targetPath, "target\n");
		symlinkSync(targetPath, linkPath);
		const linkResult = await executeApplyPatch([
			{ path: linkPath, action: "update", oldText: "target", newText: "changed" },
		]);
		expect(linkResult.ok).toBe(false);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(targetPath, "utf8")).toBe("target\n");
	});
});
