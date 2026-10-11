import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionAnswer } from "../tool/types.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

const NOTES_ACTIVATE_KEY = "n";
const SPACE_KEY = " ";
const VIM_UP = "k";
const VIM_DOWN = "j";
const VIM_TAB_BACK = "h";
const VIM_TAB_FORWARD = "l";

function matchesSelectUp(data: string, kb: QuestionnaireKeybindings): boolean {
	return kb.matches(data, KEYBIND_UP) || data === VIM_UP;
}

function matchesSelectDown(
	data: string,
	kb: QuestionnaireKeybindings,
): boolean {
	return kb.matches(data, KEYBIND_DOWN) || data === VIM_DOWN;
}

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
	| { kind: "toggle"; index: number }
	| { kind: "multi_confirm"; selected: string[]; autoAdvanceTab?: number }
	| { kind: "cancel" }
	| { kind: "notes_enter" }
	| { kind: "notes_exit" }
	| { kind: "submit" }
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	| { kind: "notes_forward"; data: string }
	/**
	 * Leave the inline-input ("Type something.") box and return focus to the option
	 * list so navigation keybindings (j/k, arrows) work again. Emitted by Escape
	 * while `state.inputMode` — Escape does NOT cancel the whole questionnaire from
	 * the typing box (press Escape again from the option list to cancel). Vim nav
	 * keys (j/k) and arrows are deliberately NOT intercepted in inputMode, so they
	 * flow through to `ignore` → `handleIgnoreInline` and get typed as letters.
	 */
	| { kind: "exit_input_mode" }
	/** Flip `state.collapsed`. Always available, regardless of inner mode (see top intercept in `routeKey`). */
	| { kind: "toggle_collapsed" }
	| { kind: "ignore" };

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): boolean {
	if (runtime.questions.length === 0) return false;
	for (let i = 0; i < runtime.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
	return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): number | undefined {
	if (!runtime.isMulti) return undefined;
	if (state.currentTab < runtime.questions.length - 1)
		return state.currentTab + 1;
	return runtime.questions.length;
}

function buildSingleSelectAnswer(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionAnswer | null {
	const q = runtime.questions[state.currentTab];
	if (!q) return null;

	const item = runtime.currentItem;

	if (state.inputMode) {
		const label = runtime.inputBuffer;
		return {
			questionIndex: state.currentTab,
			question: q.question,
			kind: "custom",
			answer: label.length > 0 ? label : null,
		};
	}
	if (!item) return null;
	if (item.kind === "other") {
		return null;
	}
	if (item.kind === "next") {
		return null;
	}
	return {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: item.label,
	};
}

function buildMultiSelected(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): string[] {
	const q = runtime.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function tabSwitchAction(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
	if (!runtime.isMulti) return null;
	const total = totalTabs(runtime);
	if (
		matchesKey(data, Key.tab) ||
		matchesKey(data, Key.right) ||
		data === VIM_TAB_FORWARD
	) {
		return {
			kind: "tab_switch",
			nextTab: wrapTab(state.currentTab + 1, total),
		};
	}
	if (
		matchesKey(data, Key.shift("tab")) ||
		matchesKey(data, Key.left) ||
		data === VIM_TAB_BACK
	) {
		return {
			kind: "tab_switch",
			nextTab: wrapTab(state.currentTab - 1, total),
		};
	}
	return null;
}

// DOWN at the last item wraps to the first (cycle through [option0, …, optionLast]).
function nextNavOnDown(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(
			state.optionIndex + 1,
			Math.max(1, runtime.items.length),
		),
	};
}

// UP at the first item wraps to the last (symmetric with nextNavOnDown).
function prevNavOnUp(
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(
			state.optionIndex - 1,
			Math.max(1, runtime.items.length),
		),
	};
}

export function routeKey(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	const kb = runtime.keybindings;

	// Collapse/expand toggle is a UI-level affordance — intercepted at the top so it
	// works from every inner state (notes, inputMode, submit tab, multi-select)
	// without reaching any branch that would otherwise consume the keystroke. The
	// questionnaire overlay is fully hidden via `OverlayHandle.setHidden(true)` while
	// collapsed; pi-tui's overlay stack updates accordingly, so overlay-aware consumers
	// (e.g. `pi-station`) see no visible modal and chat scroll resumes. The toggle key is
	// also captured at the raw terminal level via `ctx.ui.onTerminalInput` so it still
	// routes here when the overlay is hidden (pi-tui does not deliver input to a hidden
	// overlay's `component.handleInput`).
	//
	// The default `ctrl+]` is free in every mainstream macOS terminal (Terminal.app,
	// iTerm2, Warp), every multiplexer (tmux, zellij, screen — none use it as a prefix),
	// and the legacy telnet/ssh escape role doesn't apply because our overlay runs
	// in-process. It is, however, awkward on keyboard layouts where `]` is on the
	// shifted layer (Latin American `es-AR`/`es-MX` require `Ctrl+Shift+}` for `Ctrl+]`)
	// — use the `collapseKey` config field to override.
	if (
		runtime.collapseKey !== "off" &&
		matchesKey(data, runtime.collapseKey as Parameters<typeof matchesKey>[1])
	) {
		return { kind: "toggle_collapsed" };
	}

	// Collapsed-mode lockout: while collapsed, swallow every keystroke except cancel so
	// the user can read the now-uncovered transcript without accidentally mutating
	// answers or notes. The collapse toggle itself is already handled above.
	if (state.collapsed) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	if (state.notesVisible) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "notes_exit" };
		if (kb.matches(data, KEYBIND_CONFIRM)) return { kind: "notes_exit" };
		return { kind: "notes_forward", data };
	}

	if (state.inputMode) {
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			const answer = buildSingleSelectAnswer(state, runtime);
			if (!answer) return { kind: "ignore" };
			return {
				kind: "confirm",
				answer,
				autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
			};
		}
		// Escape leaves the typing box and re-enables vim navigation. It does NOT cancel
		// the questionnaire from here — press Escape again from the option list to cancel.
		// Previously Escape cancelled the whole dialog even mid-typing, which was destructive.
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "exit_input_mode" };
		// Arrow Up/Down (the configured `tui.select.up/down` keybindings) still navigate
		// off the typing row so multi-select list traversal (Down through options → Next)
		// keeps working without forcing Escape. The vim nav LETTERS (j/k) are deliberately
		// NOT matched here — `matchesSelectUp/Down` would also catch them and steal them
		// from the buffer. Instead j/k fall through to `ignore` and get typed as letters,
		// which is the whole point: a vim user typing "j" or "k" expects the character, not
		// to be yanked off the input box.
		if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
		if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);
		return { kind: "ignore" };
	}

	if (runtime.isMulti && state.currentTab === runtime.questions.length) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		const tab = tabSwitchAction(data, state, runtime);
		if (tab) return tab;
		if (matchesSelectUp(data, kb) || matchesSelectDown(data, kb)) {
			const delta = matchesSelectDown(data, kb) ? 1 : -1;
			const next = wrapTab(state.submitChoiceIndex + delta, 2);
			return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// D1 (revised): Submit always submits; Cancel always cancels. The warning header
			// is informational only — `allAnswered(state)` no longer gates submission. Partial
			// answers flow through `orderedAnswers()` in the host.
			return state.submitChoiceIndex === 1
				? { kind: "cancel" }
				: { kind: "submit" };
		}
		return { kind: "ignore" };
	}

	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;

	const q = runtime.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	if (
		data === NOTES_ACTIVATE_KEY &&
		!q.multiSelect &&
		state.focusedOptionHasPreview
	) {
		return { kind: "notes_enter" };
	}

	if (matchesSelectUp(data, kb)) {
		return prevNavOnUp(state, runtime);
	}
	if (matchesSelectDown(data, kb)) {
		return nextNavOnDown(state, runtime);
	}

	if (q.multiSelect) {
		const focusedKind = runtime.currentItem?.kind;
		const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
		// Space toggles the focused row's checkbox. Suppressed on rows whose META declares
		// `blocksMultiToggle` (the Next sentinel) or `activatesInputMode` (the "Type
		// something." row — it is an inline input, not a checkable option).
		if (data === SPACE_KEY) {
			if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			return { kind: "toggle", index: state.optionIndex };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// Enter on the "Type something." row is handled by the inputMode block above
			// (→ confirm kind:"custom"). Defensive: never enter the toggle/multi_confirm
			// path for an inputMode-activating row.
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			// Enter on a regular row toggles (matching Space) — committing the question is now
			// gated behind explicit focus on a row whose META declares `autoSubmitsInMulti`
			// (the Next sentinel), so Enter on options is a no-cost way to flip checkboxes
			// without leaving the keyboard home row.
			if (!focusedMeta?.autoSubmitsInMulti)
				return { kind: "toggle", index: state.optionIndex };
			// Enter on Next: carry autoAdvanceTab so the host can advance to the next tab in
			// multi-question mode, OR submit the dialog in single-question mode
			// (autoAdvanceTab === undefined when !isMulti). Without this, a single multi-select
			// question would have no way to commit at all.
			return {
				kind: "multi_confirm",
				selected: buildMultiSelected(state, runtime),
				autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
			};
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	if (kb.matches(data, KEYBIND_CONFIRM)) {
		const answer = buildSingleSelectAnswer(state, runtime);
		if (!answer) return { kind: "ignore" };
		return {
			kind: "confirm",
			answer,
			autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
		};
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	return { kind: "ignore" };
}
