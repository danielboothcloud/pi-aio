import type {
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { BashHintEditor } from "../user-bash/bash-hint-editor.js";

export interface QueueEditorHooks {
	/**
	 * Called when the submit key is pressed while the editor is empty.
	 * Return true to consume the key (default empty submit is a no-op anyway).
	 */
	onEmptySubmit(): boolean;
}

/**
 * BashHintEditor with one addition: pressing the submit key on an empty
 * editor delegates to the queue controller, which aborts the current run and
 * pushes the next pending message at the agent. Everything else (bash hints,
 * app keybindings, autocomplete) is untouched.
 */
export class QueueEditor extends BashHintEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private queueKeybindings: KeybindingsManager,
		ctx: ExtensionContext,
		private hooks: QueueEditorHooks,
		options?: EditorOptions,
	) {
		super(tui, theme, queueKeybindings, ctx, options);
	}

	handleInput(data: string): void {
		if (
			this.queueKeybindings.matches(data, "tui.input.submit") &&
			this.getText().trim() === "" &&
			!this.isShowingAutocomplete() &&
			this.hooks.onEmptySubmit()
		) {
			return;
		}
		super.handleInput(data);
	}
}
