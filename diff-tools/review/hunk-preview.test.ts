import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { parseDiff } from "../core/diff.js";
import { renderSplit, resolveDiffColors } from "./hunk-preview.js";

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI_RE, "");

const OLD = [
	"function unused() {",
	"\treturn 1;",
	"}",
	"export const VALUE = 42;",
	...Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`),
	"export function tail(items: string[]) {",
	"\treturn items.filter(Boolean);",
	"}",
	"",
].join("\n");
const NEW = OLD.replace(/function unused\(\) \{\n\treturn 1;\n\}\n/, "")
	.replace("VALUE = 42", "VALUE = 43")
	.replace("items: string[]", "items: readonly string[]")
	.replace("}\n", "}\nexport const ADDED_ONE = 1;\nexport const ADDED_TWO = 2;\n");

async function render(width: number): Promise<string[]> {
	const diff = parseDiff(OLD, NEW, 2);
	const output = await renderSplit(
		diff,
		undefined,
		200,
		resolveDiffColors(),
		width,
		{ compactGutter: true },
	);
	return output.split("\n");
}

describe("renderSplit", () => {
	it("keeps every row exactly at the supplied width", async () => {
		for (const width of [60, 120, 160, 200]) {
			for (const line of await render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("aligns an edited line with its original and hatches empty cells", async () => {
		const rows = (await render(160)).map(plain);
		const unused = rows.find((row) => row.includes("function unused()"));
		expect(unused).toMatch(/╱{20,}$/);
		const value = rows.find((row) => row.includes("VALUE = 42"));
		expect(value).toContain("VALUE = 43");
	});

	it("draws one full-width separator with the hidden line count", async () => {
		const rows = (await render(160)).map(plain);
		const separator = rows.find((row) => row.includes("unchanged lines"));
		expect(separator).toMatch(/^── \d+ unchanged lines ─+$/);
		expect(separator).toHaveLength(160);
	});

	it("wraps long lines at word boundaries", async () => {
		const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
		const diff = parseDiff("a\n", `a\n${words}\n`);
		const output = await renderSplit(diff, undefined, 50, resolveDiffColors(), 130);
		const rows = output.split("\n").map(plain).filter((row) => row.includes("word"));
		expect(rows.length).toBe(2);
		const lastOfFirst = Number(rows[0].trimEnd().match(/word(\d+)$/)?.[1]);
		const firstOfSecond = Number(rows[1].match(/^[▌\s]*word(\d+) /)?.[1]);
		expect(firstOfSecond).toBe(lastOfFirst + 1);
	});

	it("uses unified view below the split width", async () => {
		const rows = (await render(120)).map(plain);
		expect(rows.some((row) => row.includes("╱"))).toBe(false);
		expect(rows.some((row) => row.includes("VALUE = 42") && row.includes("VALUE = 43"))).toBe(false);
	});
});
