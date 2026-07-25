/**
 * Scrollable mutation-approval overlay.
 *
 * Replaces the old single-shot `ctx.ui.select(title, options)` approval prompt
 * for file mutations (edit / apply_patch / write). The legacy prompt rendered the
 * file path header + a 40-line-capped plain diff as one non-scrollable `Text`
 * block, so a diff taller than the editor region pushed the header off-screen and
 * the user could never scroll it back. This overlay keeps the file path header
 * and the Allow / Allow all / Block options pinned, and renders the full
 * (effectively uncapped) diff body in a scrollable region.
 *
 * Non-TUI hosts (RPC) do not implement `ctx.ui.custom`, so `showMutationApproval`
 * falls back to the original `ctx.ui.select` path there.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	buildMutationApprovalPrompt,
	formatMutationPreview,
} from "../diff-tools/core/mutation-preview.js";

/** Result of an approval interaction. `block` also covers cancel/escape. */
export type ApprovalDecision = "allow" | "allowAll" | "block";

/** Options shown in the sticky footer, in order. */
const OPTIONS = ["Allow", "Allow all (enable auto)", "Block"] as const;

/** Left/right content margin inside the overlay, mirroring Text paddingX. */
const PAD_X = 1;

/** Caps for the overlay preview — effectively uncapped for realistic diffs. */
const OVERLAY_MAX_LINES = 10_000;
const OVERLAY_MAX_CHARS = 200_000;

/** Minimal theme surface used by the dialog (avoids importing the full Theme). */
interface ApprovalTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Color role assigned to a wrapped diff row. */
type DiffRole = "add" | "del" | "context" | "meta";

function classifyLine(line: string): DiffRole {
	if (line.startsWith("--- ") && line.endsWith(" ---")) return "meta";
	if (line.startsWith("+++ ")) return "meta";
	if (line.startsWith("…") || line.startsWith("move ")) return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	return "context";
}

function roleColor(role: DiffRole): string {
	switch (role) {
		case "add":
			return "toolDiffAdded";
		case "del":
			return "toolDiffRemoved";
		case "meta":
			return "muted";
		default:
			return "toolDiffContext";
	}
}

/**
 * Show the mutation-approval UI. Uses the scrollable overlay in TUI mode and
 * falls back to `ctx.ui.select` everywhere else (RPC, JSON, print, or when the
 * host does not expose `ctx.ui.custom`).
 */
export async function showMutationApproval(
	ctx: ExtensionContext,
	params: { tool: string; input: Record<string, unknown>; path: string },
): Promise<ApprovalDecision> {
	const useOverlay = ctx.mode === "tui" && typeof ctx.ui.custom === "function";

	if (!useOverlay) {
		const preview = await formatMutationPreview(params.tool, params.input);
		const choice = await ctx.ui.select(
			buildMutationApprovalPrompt(params.tool, params.path, preview),
			[...OPTIONS],
		);
		if (choice === "Allow") return "allow";
		if (choice === "Allow all (enable auto)") return "allowAll";
		return "block";
	}

	const preview = await formatMutationPreview(params.tool, params.input, {
		maxLines: OVERLAY_MAX_LINES,
		maxChars: OVERLAY_MAX_CHARS,
	});
	const header = `Allow ${params.tool} on ${params.path}?`;

	const result = await ctx.ui.custom<ApprovalDecision | undefined>(
		(tui, theme, _kb, done) =>
			new ApprovalDialog({
				tui,
				theme: theme as unknown as ApprovalTheme,
				header,
				diff: preview,
				done,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 0, right: 0, bottom: 0 },
			},
		},
	);

	return result === "allow" || result === "allowAll" ? result : "block";
}

interface ApprovalDialogOptions {
	tui: TUI;
	theme: ApprovalTheme;
	header: string;
	diff: string | undefined;
	done: (result: ApprovalDecision) => void;
}

/**
 * TUI component rendered inside the `ctx.ui.custom` overlay.
 *
 * Layout (top → bottom):
 *   border · spacer · header · spacer · [scrollable diff body] · spacer ·
 *   option · option · option · spacer · hint · spacer · border
 *
 * The diff body is a scrollable window over the wrapped diff rows. When the body
 * overflows, the first/last visible row is replaced with an "↑ N above" / "↓ N
 * below" indicator (matching the ask-user-question overflow convention).
 */
export class ApprovalDialog implements Component {
	private readonly tui: TUI;
	private readonly theme: ApprovalTheme;
	private readonly header: string;
	private readonly diffLines: string[];
	private readonly done: (result: ApprovalDecision) => void;
	private selected = 0;
	private scrollOffset = 0;
	// Wrap cache (invalidated on width change).
	private cacheWidth = -1;
	private wrappedRows: { text: string; role: DiffRole }[] = [];

	constructor(opts: ApprovalDialogOptions) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.header = opts.header;
		this.done = opts.done;
		const trimmed = opts.diff ? opts.diff.replace(/\n+$/, "") : "";
		this.diffLines = trimmed ? trimmed.split("\n") : [];
	}

	invalidate(): void {
		this.cacheWidth = -1;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollByPage(-1);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollByPage(1);
			return;
		}
		if (data === "g" || data === "\u001b[H" || data === "\u001bOH") {
			this.scrollTo(0);
			return;
		}
		if (data === "G" || data === "\u001b[F" || data === "\u001bOF") {
			this.scrollTo(Number.MAX_SAFE_INTEGER);
			return;
		}
		if (data === "\t") {
			this.selected = (this.selected + 1) % OPTIONS.length;
			return;
		}
		if (data === "\u001b[Z") {
			// Shift+Tab (backtab) — cycle backwards.
			this.selected = (this.selected + OPTIONS.length - 1) % OPTIONS.length;
			return;
		}
		if (data === "1" || data === "2" || data === "3") {
			this.done(this.decisionFor(Number.parseInt(data, 10) - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.done(this.decisionFor(this.selected));
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done("block");
		}
	}

	render(width: number): string[] {
		const rows = this.ensureWrapped(width);
		const termRows = this.tui.terminal.rows;

		const topFixed = 4; // border + spacer + header + spacer
		const bottomFixed = 8; // spacer + 3 options + spacer + hint + spacer + border
		const available = Math.max(0, termRows - topFixed - bottomFixed);

		const totalRows = rows.length;
		const effectiveRows = Math.max(totalRows, 1);
		const windowRows = Math.min(available, effectiveRows);
		const maxStart = Math.max(0, totalRows - windowRows);
		if (this.scrollOffset > maxStart) this.scrollOffset = maxStart;
		const start = this.scrollOffset;

		const top = [
			this.borderLine(width),
			this.spacerLine(width),
			this.headerLine(width),
			this.spacerLine(width),
		];

		const body: string[] = [];
		if (totalRows === 0) {
			body.push(
				this.padLine(
					this.theme.fg("muted", "(no inline diff to review)"),
					width,
				),
			);
		} else {
			const slice = rows.slice(start, start + windowRows);
			for (const row of slice) {
				body.push(
					this.padLine(this.theme.fg(roleColor(row.role), row.text), width),
				);
			}
			if (body.length > 0) {
				if (start > 0) {
					body[0] = this.padLine(
						this.theme.fg(
							"muted",
							`↑ ${start} line${start === 1 ? "" : "s"} above`,
						),
						width,
					);
				}
				const remaining = totalRows - (start + windowRows);
				if (remaining > 0) {
					body[body.length - 1] = this.padLine(
						this.theme.fg(
							"muted",
							`↓ ${remaining} line${remaining === 1 ? "" : "s"} below`,
						),
						width,
					);
				}
			}
		}

		const bottom = [
			this.spacerLine(width),
			this.optionLine(0, width),
			this.optionLine(1, width),
			this.optionLine(2, width),
			this.spacerLine(width),
			this.hintLine(width),
			this.spacerLine(width),
			this.borderLine(width),
		];

		const result = [...top, ...body, ...bottom];
		// Safety: never exceed terminal rows (tiny-terminal edge case).
		return result.length > termRows ? result.slice(0, termRows) : result;
	}

	private decisionFor(index: number): ApprovalDecision {
		switch (index) {
			case 0:
				return "allow";
			case 1:
				return "allowAll";
			default:
				return "block";
		}
	}

	private ensureWrapped(width: number): { text: string; role: DiffRole }[] {
		if (this.cacheWidth === width) return this.wrappedRows;
		this.cacheWidth = width;
		const contentWidth = Math.max(1, width - PAD_X * 2);
		const rows: { text: string; role: DiffRole }[] = [];
		for (const line of this.diffLines) {
			const role = classifyLine(line);
			const wrapped = wrapTextWithAnsi(line, contentWidth);
			const parts = wrapped.length > 0 ? wrapped : [""];
			for (const part of parts) rows.push({ text: part, role });
		}
		this.wrappedRows = rows;
		return rows;
	}

	private windowRows(): number {
		const termRows = this.tui.terminal.rows;
		const available = Math.max(0, termRows - 4 - 8);
		return Math.min(available, Math.max(this.wrappedRows.length, 1));
	}

	private scrollBy(delta: number): void {
		this.ensureWrapped(
			this.cacheWidth < 0 ? this.tui.terminal.columns : this.cacheWidth,
		);
		const maxStart = Math.max(0, this.wrappedRows.length - this.windowRows());
		this.scrollOffset = Math.max(
			0,
			Math.min(maxStart, this.scrollOffset + delta),
		);
	}

	private scrollByPage(dir: -1 | 1): void {
		const page = Math.max(1, this.windowRows() - 1);
		this.scrollBy(dir * page);
	}

	private scrollTo(offset: number): void {
		this.ensureWrapped(
			this.cacheWidth < 0 ? this.tui.terminal.columns : this.cacheWidth,
		);
		const maxStart = Math.max(0, this.wrappedRows.length - this.windowRows());
		this.scrollOffset = Math.max(0, Math.min(maxStart, offset));
	}

	private padLine(colored: string, width: number): string {
		const left = " ".repeat(PAD_X);
		const line = left + colored;
		const pad = Math.max(0, width - PAD_X - visibleWidth(colored));
		return line + " ".repeat(pad);
	}

	private spacerLine(width: number): string {
		return " ".repeat(width);
	}

	private borderLine(width: number): string {
		return this.theme.fg("border", "─".repeat(Math.max(0, width)));
	}

	private headerLine(width: number): string {
		return this.padLine(
			this.theme.fg("accent", this.theme.bold(this.header)),
			width,
		);
	}

	private optionLine(index: number, width: number): string {
		const label = OPTIONS[index] ?? "";
		if (index === this.selected) {
			return this.padLine(
				this.theme.fg("accent", `→ ${this.theme.bold(label)}`),
				width,
			);
		}
		return this.padLine(`  ${this.theme.fg("text", label)}`, width);
	}

	private hintLine(width: number): string {
		return this.padLine(
			this.theme.fg(
				"muted",
				"↑↓ scroll  Tab option  1/2/3 quick-pick  Enter confirm  Esc cancel",
			),
			width,
		);
	}
}
