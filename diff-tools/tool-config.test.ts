import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidatePiDiffConfig } from "./core/config.js";
import diffRendererExtension from "./index.js";

describe("disabledTools configuration", () => {
	let tempDir: string;
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-diff-tools-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		invalidatePiDiffConfig();
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		invalidatePiDiffConfig();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not register apply_patch when it is disabled", async () => {
		writeFileSync(join(tempDir, "pi-diff.json"), JSON.stringify({ disabledTools: ["apply_patch"] }));
		const registeredTools: string[] = [];

		await diffRendererExtension({
			on: () => {},
			registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
		} as never);

		expect(registeredTools).toContain("write");
		expect(registeredTools).toContain("edit");
		expect(registeredTools).not.toContain("apply_patch");
	});
});
