import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ApprovalDialog, showMutationApproval } from "./approval-dialog.ts";

/** Passthrough theme so rendered lines carry no ANSI — easy to assert on. */
const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

interface FakeTui {
	terminal: { rows: number; columns: number };
}

function makeDialog(
	diff: string | undefined,
	opts: { rows?: number; columns?: number; header?: string } = {},
): { dialog: ApprovalDialog; doneCalls: string[] } {
	const doneCalls: string[] = [];
	const dialog = new ApprovalDialog({
		tui: {
			terminal: { rows: opts.rows ?? 20, columns: opts.columns ?? 80 },
		} as unknown as TUI,
		theme: passthroughTheme,
		header: opts.header ?? "Allow edit on src/example.ts?",
		diff,
		done: (result) => doneCalls.push(result),
	} as unknown as ConstructorParameters<typeof ApprovalDialog>[0]);
	return { dialog, doneCalls };
}

/** Strip trailing whitespace from each rendered line for stable assertions. */
function trim(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\s+$/, ""));
}

test("render pins the file-path header, options, and hint within terminal rows", () => {
	const { dialog } = makeDialog(
		"+ const a = 1;\n- const b = 2;\n  const c = 3;\n",
		{
			rows: 24,
		},
	);
	const lines = trim(dialog.render(80));
	assert.ok(
		lines.length <= 24,
		`rendered ${lines.length} rows for a 24-row terminal`,
	);
	assert.ok(
		lines.some((l) => l.includes("Allow edit on src/example.ts?")),
		"header visible",
	);
	assert.ok(
		lines.some((l) => l.includes("Allow")),
		"Allow option visible",
	);
	assert.ok(
		lines.some((l) => l.includes("Allow all (enable auto)")),
		"Allow-all option visible",
	);
	assert.ok(
		lines.some((l) => l.includes("Block")),
		"Block option visible",
	);
	assert.ok(
		lines.some((l) => l.includes("scroll") && l.includes("confirm")),
		"hint visible",
	);
	// Body shows the diff content (not truncated to a 40-line cap region).
	assert.ok(
		lines.some((l) => l.includes("+ const a = 1;")),
		"add line visible",
	);
	assert.ok(
		lines.some((l) => l.includes("- const b = 2;")),
		"del line visible",
	);
});

test("empty diff shows a muted note instead of an empty body", () => {
	const { dialog } = makeDialog(undefined, { rows: 24 });
	const lines = trim(dialog.render(80));
	assert.ok(lines.some((l) => l.includes("(no inline diff to review)")));
	assert.ok(lines.some((l) => l.includes("Allow edit on src/example.ts?")));
});

test("large diff shows a down-indicator and scrolls with up/down", () => {
	const big = Array.from({ length: 100 }, (_, i) => `+ line ${i}`).join("\n");
	const { dialog } = makeDialog(big, { rows: 20 });

	// At the top: no up-indicator, but a down-indicator is present.
	let lines = trim(dialog.render(80));
	assert.ok(
		!lines.some((l) => l.includes("above")),
		"no up-indicator at offset 0",
	);
	assert.ok(
		lines.some((l) => l.includes("below")),
		"down-indicator present at offset 0",
	);

	// Scroll down a few rows; both indicators should now appear.
	dialog.handleInput("\u001b[B"); // down
	dialog.handleInput("\u001b[B");
	dialog.handleInput("\u001b[B");
	lines = trim(dialog.render(80));
	assert.ok(
		lines.some((l) => l.includes("3 lines above")),
		"up-indicator after scrolling down",
	);
	assert.ok(
		lines.some((l) => l.includes("below")),
		"still more below",
	);
});

test("scroll clamps at the bottom and hides the down-indicator", () => {
	const big = Array.from({ length: 100 }, (_, i) => `+ line ${i}`).join("\n");
	const { dialog } = makeDialog(big, { rows: 20 });

	// Jump to the bottom via the End key.
	dialog.handleInput("\u001b[F");
	const lines = trim(dialog.render(80));
	assert.ok(
		!lines.some((l) => l.includes("below")),
		"no down-indicator at the bottom",
	);
	assert.ok(
		lines.some((l) => l.includes("above")),
		"up-indicator at the bottom",
	);
	// Scrolling further down does nothing (already clamped).
	dialog.handleInput("\u001b[B");
	const after = trim(dialog.render(80));
	assert.ok(
		!after.some((l) => l.includes("below")),
		"still clamped at the bottom",
	);
});

test("Home/End and page keys move the scroll offset", () => {
	const big = Array.from({ length: 100 }, (_, i) => `+ line ${i}`).join("\n");
	const { dialog } = makeDialog(big, { rows: 20 });

	dialog.handleInput("\u001b[F"); // End → bottom
	assert.ok(trim(dialog.render(80)).some((l) => l.includes("above")));
	dialog.handleInput("\u001b[H"); // Home → top
	assert.ok(
		!trim(dialog.render(80)).some((l) => l.includes("above")),
		"Home returns to top",
	);

	// PageDown moves by roughly the window size.
	dialog.handleInput("\u001b[6~"); // pageDown
	assert.ok(
		trim(dialog.render(80)).some((l) => l.includes("above")),
		"pageDown advanced offset",
	);
});

test("Tab cycles option selection and renders the marker on the selected option", () => {
	const { dialog } = makeDialog("+ a\n- b", { rows: 24 });
	const selectedLabel = (lines: string[]): string | undefined => {
		const trimmed = trim(lines).map((l) => l.trim());
		return trimmed.find((l) => l.startsWith("→ "));
	};
	let lines = dialog.render(80);
	assert.equal(selectedLabel(lines), "→ Allow", "Allow selected by default");

	dialog.handleInput("\t"); // Tab → Allow all
	lines = dialog.render(80);
	assert.equal(
		selectedLabel(lines),
		"→ Allow all (enable auto)",
		"Allow all selected after Tab",
	);

	dialog.handleInput("\u001b[Z"); // Shift+Tab → back to Allow
	lines = dialog.render(80);
	assert.equal(
		selectedLabel(lines),
		"→ Allow",
		"Allow selected after back-Tab",
	);
});

test("Enter confirms the selected option; Esc cancels to block", () => {
	const { dialog, doneCalls } = makeDialog("+ a\n- b", { rows: 24 });
	dialog.handleInput("\n"); // Enter on default Allow
	assert.deepEqual(doneCalls, ["allow"]);

	const { dialog: d2, doneCalls: c2 } = makeDialog("+ a\n- b", { rows: 24 });
	d2.handleInput("\u001b"); // Esc
	assert.deepEqual(c2, ["block"], "Esc resolves to block");
});

test("number keys 1/2/3 quick-pick the matching option", () => {
	const { dialog: d1, doneCalls: c1 } = makeDialog("+ a", { rows: 24 });
	d1.handleInput("2"); // Allow all
	assert.deepEqual(c1, ["allowAll"]);

	const { dialog: d2, doneCalls: c2 } = makeDialog("+ a", { rows: 24 });
	d2.handleInput("3"); // Block
	assert.deepEqual(c2, ["block"]);
});

test("render never exceeds terminal rows on a tiny terminal", () => {
	const big = Array.from({ length: 50 }, (_, i) => `+ line ${i}`).join("\n");
	const { dialog } = makeDialog(big, { rows: 8 });
	const lines = dialog.render(80);
	assert.ok(
		lines.length <= 8,
		`rendered ${lines.length} rows for an 8-row terminal`,
	);
});

test("showMutationApproval falls back to ctx.ui.select outside TUI mode", async () => {
	const selectArgs: { prompt: string; options: string[] }[] = [];
	const selections: (string | undefined)[] = [];
	const ctx = {
		mode: "rpc",
		ui: {
			select: async (prompt: string, options: string[]) => {
				selectArgs.push({ prompt, options });
				return selections.shift();
			},
		},
	} as unknown as ExtensionContext;

	selections.push("Allow");
	const r1 = await showMutationApproval(ctx, {
		tool: "edit",
		input: {},
		path: "src/x.ts",
	});
	assert.equal(r1, "allow");
	assert.equal(selectArgs.length, 1);
	assert.equal(selectArgs[0].options[0], "Allow");

	selections.push("Allow all (enable auto)");
	const r2 = await showMutationApproval(ctx, {
		tool: "edit",
		input: {},
		path: "src/x.ts",
	});
	assert.equal(r2, "allowAll");

	selections.push(undefined); // cancel
	const r3 = await showMutationApproval(ctx, {
		tool: "edit",
		input: {},
		path: "src/x.ts",
	});
	assert.equal(r3, "block");
});

test("showMutationApproval uses the scrollable overlay in TUI mode and maps results", async () => {
	let factory: (
		tui: unknown,
		theme: unknown,
		kb: unknown,
		done: (r: string) => void,
	) => unknown;
	const customCalls: { overlay: boolean }[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (
				f: typeof factory,
				opts: { overlay: boolean },
			): Promise<string | undefined> => {
				factory = f;
				customCalls.push({ overlay: opts.overlay });
				// Simulate the host: build the component, drive it, then resolve.
				return new Promise<string | undefined>((resolve) => {
					const component = f(
						{ terminal: { rows: 24, columns: 80 } },
						passthroughTheme,
						undefined,
						(result) => resolve(result),
					) as { handleInput(data: string): void };
					// Confirm on Allow (default selected option).
					component.handleInput("\n");
				});
			},
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;

	const r = await showMutationApproval(ctx, {
		tool: "edit",
		input: { path: "src/x.ts" },
		path: "src/x.ts",
	});
	assert.equal(r, "allow");
	assert.equal(customCalls.length, 1);
	assert.equal(customCalls[0].overlay, true);
});
