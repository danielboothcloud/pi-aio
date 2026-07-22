import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { syncBashHint } from "./bash-hint.js";
import { ensureBashSpacing, parseBashInput } from "./parse-bash-input.js";

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 1;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap >
			width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(
			rightText,
			Math.max(0, visibleWidth(rightText) - 1),
			"",
		);
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap >
			width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(
			leftText,
			Math.max(0, visibleWidth(leftText) - 1),
			"",
		);
	}

	const gapWidth = Math.max(
		0,
		width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
	);
	return `${border("─")}${leftText}${border("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

export class BashHintEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
		syncBashHint(ctx, this.getText());
	}

	setPaddingX(padding: number): void {
		// Pi copies default editor padding (0) onto custom editors after creation.
		super.setPaddingX(Math.max(1, padding));
	}

	handleInput(data: string): void {
		super.handleInput(data);
		const spaced = ensureBashSpacing(this.getText());
		if (spaced !== null) {
			this.setText(spaced);
		}
		syncBashHint(this.ctx, this.getText());
	}

	setText(text: string): void {
		super.setText(text);
		syncBashHint(this.ctx, text);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const state = parseBashInput(this.getText());
		if (!state.active || lines.length < 2) return lines;

		const theme = this.ctx.ui.theme;
		const modeLabel = state.hidden
			? theme.fg("muted", " !! hidden ")
			: theme.fg("bashMode", " ! bash ");
		const hint = theme.fg("dim", " Enter to run ");
		const borderColor = (text: string) => this.borderColor(text);

		lines[0] = fitBorder(modeLabel, hint, width, borderColor);
		return lines;
	}
}
