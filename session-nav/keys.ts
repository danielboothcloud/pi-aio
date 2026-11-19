// Vim-style list keys shared by the session pickers: normal mode navigates
// with hjkl/g/G, `/` enters search mode where printable keys edit the filter.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { printableInput } from "./frame.js";

export type ListMode = "normal" | "search";

export interface ListKeyState {
	mode: ListMode;
	query: string;
}

export type ListKeyAction =
	| { type: "move"; delta: number }
	| { type: "left" }
	| { type: "right" }
	| { type: "enter" }
	/** Esc in normal mode with no filter: the view's own close/back. */
	| { type: "escape" }
	| { type: "query" }
	| { type: "mode" }
	| { type: "none" };

export interface ListKeyResult {
	state: ListKeyState;
	action: ListKeyAction;
}

/** Pure reducer: `page` is the PageUp/PageDown step for the current view. */
export function listKey(state: ListKeyState, data: string, page: number): ListKeyResult {
	const keep = (action: ListKeyAction): ListKeyResult => ({ state, action });
	if (matchesKey(data, Key.escape)) {
		if (state.mode === "search") return { state: { ...state, mode: "normal" }, action: { type: "mode" } };
		if (state.query) return { state: { ...state, query: "" }, action: { type: "query" } };
		return keep({ type: "escape" });
	}
	if (matchesKey(data, Key.up)) return keep({ type: "move", delta: -1 });
	if (matchesKey(data, Key.down)) return keep({ type: "move", delta: 1 });
	if (matchesKey(data, Key.pageUp)) return keep({ type: "move", delta: -page });
	if (matchesKey(data, Key.pageDown)) return keep({ type: "move", delta: page });
	if (matchesKey(data, Key.home)) return keep({ type: "move", delta: -Infinity });
	if (matchesKey(data, Key.end)) return keep({ type: "move", delta: Infinity });
	if (matchesKey(data, Key.left)) return keep({ type: "left" });
	if (matchesKey(data, Key.right)) return keep({ type: "right" });
	if (matchesKey(data, Key.enter)) return keep({ type: "enter" });

	if (state.mode === "search") {
		if (matchesKey(data, Key.backspace)) {
			return { state: { ...state, query: state.query.slice(0, -1) }, action: { type: "query" } };
		}
		const char = printableInput(data);
		if (char === undefined) return keep({ type: "none" });
		return { state: { ...state, query: state.query + char }, action: { type: "query" } };
	}

	switch (printableInput(data)) {
		case "j":
			return keep({ type: "move", delta: 1 });
		case "k":
			return keep({ type: "move", delta: -1 });
		case "g":
			return keep({ type: "move", delta: -Infinity });
		case "G":
			return keep({ type: "move", delta: Infinity });
		case "h":
			return keep({ type: "left" });
		case "l":
			return keep({ type: "right" });
		case "/":
			return { state: { ...state, mode: "search" }, action: { type: "mode" } };
		default:
			return keep({ type: "none" });
	}
}

/** The filter row: `/query▏` while searching, `/query` once back in normal mode. */
export function searchLabel(
	theme: { fg(role: string, text: string): string },
	state: ListKeyState,
	placeholder: string,
): string {
	if (state.mode === "search") return `${theme.fg("accent", "/")}${state.query}${theme.fg("accent", "▏")}`;
	if (state.query) return `${theme.fg("accent", "/")}${state.query}`;
	return theme.fg("dim", placeholder);
}
