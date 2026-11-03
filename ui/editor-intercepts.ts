// Editor key/submit interceptors that AIO features register and the AIO
// QueueEditor consults before pi's own handling. Pi exposes no hook for
// double-Escape, built-in `/resume`, or app actions, so the editor AIO
// installs is the single place these can be claimed. Absent an AIO editor
// (e.g. standalone Zentui owns it), pi's native behavior is untouched.

export interface EditorIntercepts {
	/** Escape on an empty editor with no autocomplete open; true consumes it. */
	escape?(): boolean;
	/** Submitted text (the editor is already cleared); true consumes it. */
	submit?(text: string): boolean;
	/** An app keybinding action such as "app.session.resume"; true consumes it. */
	action?(action: string): boolean;
}

/** App actions the editor checks before pi's own handlers run. */
export const INTERCEPTED_ACTIONS = ["app.session.resume"] as const;

let current: EditorIntercepts = {};

export function setEditorIntercepts(intercepts: EditorIntercepts | undefined): void {
	current = intercepts ?? {};
}

export function getEditorIntercepts(): EditorIntercepts {
	return current;
}
