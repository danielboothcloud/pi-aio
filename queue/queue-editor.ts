import type {
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { getEditorIntercepts, INTERCEPTED_ACTIONS } from "../ui/editor-intercepts.js";
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
 * pushes the next pending message at the agent. It also consults the shared
 * editor intercepts (ui/editor-intercepts.ts) for Escape, submitted text and
 * selected app actions before pi handles them. Everything else (bash hints,
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
		// Pi assigns its submit handler after construction. Wrap whatever it
		// assigns so intercepts see the submitted text first. Editor declares
		// onSubmit as an own field, so the accessor must live on the instance.
		let piSubmit: ((text: string) => void) | undefined;
		const intercepted = (text: string): void => {
			if (getEditorIntercepts().submit?.(text)) return;
			piSubmit?.(text);
		};
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => (piSubmit ? intercepted : undefined),
			set: (value: ((text: string) => void) | undefined) => {
				piSubmit = value;
			},
		});
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
		const intercepts = getEditorIntercepts();
		if (
			intercepts.escape &&
			this.queueKeybindings.matches(data, "app.interrupt") &&
			!this.isShowingAutocomplete() &&
			this.getText().trim() === "" &&
			intercepts.escape()
		) {
			return;
		}
		if (intercepts.action) {
			for (const action of INTERCEPTED_ACTIONS) {
				if (this.queueKeybindings.matches(data, action) && intercepts.action(action)) return;
			}
		}
		super.handleInput(data);
	}
}
