// Regenerate golden.json from the TypeScript ask-user-question feature (the
// reference for the Go port):
//   npx tsx go/internal/askuserquestion/testdata/gen-golden.ts [--check]
// It drives the real modules: the tool registration (metadata and schema),
// sanitize/validate/format/envelope helpers, resolveCollapseKey, pi-tui's
// Input with the default keybindings, the layout and box helpers, the
// QuestionnaireSession component (key sequences, rendered at several
// terminal sizes with a deterministic theme and Markdown theme), the RPC
// dialog fallback, the reconciler, and the tool's execute through a mock
// host (custom overlay, terminal-input listener, events, notify). The config
// file is read from a fixture HOME in testdata/.fixture-<pid>, removed
// afterwards.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.HOME = root;
delete process.env.XDG_CONFIG_HOME;
register(pathToFileURL(join(here, "hooks.mjs")).href);

const shim = await import(join(here, "pi-shim.mjs"));
const aq = join(repo, "ask-user-question");
const tool = await import(join(aq, "ask-user-question.ts"));
const config = await import(join(aq, "config.ts"));
const sanitize = await import(join(aq, "tool", "sanitize-questionnaire.ts"));
const validate = await import(join(aq, "tool", "validate-questionnaire.ts"));
const envelope = await import(join(aq, "tool", "response-envelope.ts"));
const types = await import(join(aq, "tool", "types.ts"));
const sessionMod = await import(join(aq, "state", "questionnaire-session.ts"));
const reducer = await import(join(aq, "state", "state-reducer.ts"));
const keyRouter = await import(join(aq, "state", "key-router.ts"));
const rpc = await import(join(aq, "rpc-fallback.ts"));
const reconcile = await import(join(aq, "reconcile.ts"));
const layout = await import(join(aq, "view", "components", "preview", "preview-layout-decider.ts"));
const box = await import(join(aq, "view", "components", "preview", "preview-box-renderer.ts"));
const tui = await import("@earendil-works/pi-tui");
tui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });

function parseJSON<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`cannot parse ${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const ROLE_CODES = parseJSON<{ roleCodes: Record<string, number> }>(
	readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8"),
	"chrome golden",
).roleCodes;
const code = (role: string) => ROLE_CODES[role] ?? 37;
const theme = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${code(role) + 10}m${text}\x1b[49m`,
};

// ---------------------------------------------------------------------------
// Keys: the key table every Go test uses (bindings from getKeybindings()).
// ---------------------------------------------------------------------------

const KEYS: Record<string, string> = {
	up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", shiftTab: "\x1b[Z",
	enter: "\r", escape: "\x1b", ctrlC: "\x03", space: " ", j: "j", k: "k", h: "h", l: "l", n: "n",
	a: "a", b: "b", x: "x", H: "H", i: "i", backspace: "\x7f", del: "\x1b[3~", ctrlD: "\x04", ctrlE: "\x05", ctrlA: "\x01",
	ctrlB: "\x02", ctrlF: "\x06", ctrlW: "\x17", ctrlU: "\x15", ctrlK: "\x0b", ctrlY: "\x19", altY: "\x1by",
	altB: "\x1bb", altF: "\x1bf", altD: "\x1bd", ctrlLeft: "\x1b[1;5D", ctrlRight: "\x1b[1;5C", home: "\x1b[H", end: "\x1b[F",
	undo: "\x1f", collapse: "\x1d", altO: "\x1bo", ctrlRBrace: "\x1b[93;5u", lf: "\n",
	hello: "hello world", note: "needs review", e_acute: "é", emoji: "🙂", cjk: "漢字",
	kittyA: "\x1b[97u", paste: "\x1b[200~pasted\r\ntext\twith tab\x1b[201~", pasteStart: "\x1b[200~split ", pasteEnd: "paste\x1b[201~z",
	dotted: "foo.bar-baz qux", ctrlBackslash: "\x1c",
};
const keybindingIds = Object.keys(tui.getKeybindings().getResolvedBindings?.() ?? tui.TUI_KEYBINDINGS);
const keyIds = ["tab", "right", "shift+tab", "left", "ctrl+]", "alt+o", "ctrl+\\", "ctrl+}"];
const keyTable = Object.entries(KEYS).map(([name, data]) => ({
	name,
	data,
	bindings: keybindingIds.filter((id) => tui.getKeybindings().matches(data, id)),
	keyIds: keyIds.filter((id) => tui.matchesKey(data, id)),
	kitty: tui.decodeKittyPrintable(data) ?? null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PREVIEW_TS = "```ts\nconst answer = 42;\nfunction greet(name: string) {\n  return `hi ${name}`;\n}\n```";
const PREVIEW_LIST = "## Layout\n\n- header\n- sidebar with **bold** text\n- footer\n\n> quoted note";
const PREVIEW_LONG = Array.from({ length: 24 }, (_, i) => `line ${i + 1} of a long preview`).join("\n");
const PREVIEW_WIDE = `| col a | col b |\n|---|---|\n| ${"x".repeat(30)} | ${"y".repeat(40)} |`;

type Q = { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string; preview?: string }> };
const questionnaires: Record<string, { questions: Q[] }> = {
	single: {
		questions: [
			{
				question: "Which database should we use?",
				header: "Database",
				options: [
					{ label: "Postgres (Recommended)", description: "Relational, strong consistency and rich SQL." },
					{ label: "SQLite", description: "Embedded, zero setup." },
					{ label: "DynamoDB", description: "Managed key-value store with on-demand capacity and a long description that wraps." },
				],
			},
		],
	},
	preview: {
		questions: [
			{
				question: "Which implementation?",
				header: "Impl",
				options: [
					{ label: "Function", description: "A plain function.", preview: PREVIEW_TS },
					{ label: "Layout", description: "Markdown layout.", preview: PREVIEW_LIST },
					{ label: "Long", description: "Clipped preview.", preview: PREVIEW_LONG },
					{ label: "None", description: "No preview here." },
				],
			},
		],
	},
	multi: {
		questions: [
			{
				question: "Which features do you want?",
				header: "Features",
				multiSelect: true,
				options: [
					{ label: "Auth", description: "Login and sessions." },
					{ label: "Billing", description: "Payments via a provider with a description long enough to wrap at narrow widths." },
					{ label: "Search", description: "" },
				],
			},
		],
	},
	tabs: {
		questions: [
			{
				question: "Pick a language",
				header: "Lang",
				options: [
					{ label: "Go", description: "Compiled." },
					{ label: "TypeScript", description: "Typed JS." },
				],
			},
			{
				question: "Pick extras",
				header: "",
				multiSelect: true,
				options: [
					{ label: "Lint", description: "Static checks." },
					{ label: "Format", description: "Code style." },
				],
			},
			{
				question: "Pick a layout",
				header: "Layout",
				options: [
					{ label: "Wide", description: "Wide table.", preview: PREVIEW_WIDE },
					{ label: "Code", description: "Code sample.", preview: PREVIEW_TS },
				],
			},
		],
	},
	unicode: {
		questions: [
			{
				question: "表示する言語は？ 🙂",
				header: "言語",
				options: [
					{ label: "日本語", description: "漢字とかなを使う長い説明文がここに入ります。" },
					{ label: "English 🙂", description: "Emoji label." },
				],
			},
			{
				question: "Second question without a header",
				header: "",
				options: [
					{ label: "Yes", description: "" },
					{ label: "No", description: "" },
				],
			},
		],
	},
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const sanitizeInputs = [
	"Add\r\r it\r\r to\r\r the\r\r backlog\r\r;",
	"plain\r-text\r field",
	"a\r\nb\n\tc",
	"x\x1b[2Jy\x00z\x7f\x0b\x0c",
	"keep 🙂 é 漢字",
];
const sanitizeTexts = sanitizeInputs.map((input) => ({ input, out: sanitize.sanitizeText(input) }));
const sanitizeParams = [
	{
		questions: [
			{
				question: "Which\r plan?",
				header: "ARC\r\r plan",
				multiSelect: false,
				options: [
					{ label: "Backlog\r it", description: "Revisit\r later" },
					{ label: "Now", description: "Do it", preview: "line1\r\nline2\r" },
				],
			},
		],
	},
];
const sanitizeCases = sanitizeParams.map((input) => ({ input, out: sanitize.sanitizeQuestionnaire(input) }));

const opt = (label: string, description = "d", preview?: string) => (preview === undefined ? { label, description } : { label, description, preview });
const q = (question: string, options: unknown[], extra: Record<string, unknown> = {}) => ({ question, header: "H", options, ...extra });
const validateInputs = [
	{ questions: [] },
	{ questions: [q("1", [opt("A"), opt("B")]), q("2", [opt("A"), opt("B")]), q("3", [opt("A"), opt("B")]), q("4", [opt("A"), opt("B")]), q("5", [opt("A"), opt("B")])] },
	{ questions: [q("Same", [opt("A"), opt("B")]), q("Same", [opt("A"), opt("B")])] },
	{ questions: [q("One", [opt("A")])] },
	{ questions: [q("One", [opt("Other"), opt("B")])] },
	{ questions: [q("One", [opt("Type something."), opt("B")])] },
	{ questions: [q("One", [opt("Next"), opt("B")])] },
	{ questions: [q("One", [opt("A"), opt("A")])] },
	{ questions: [q("One", [opt("A"), opt("A"), opt("Other")])] },
	{ questions: [q("One", [opt("A"), opt("B")]), q("Two", [opt("A")])] },
	{ questions: [q("One", [opt("A"), opt("B")])] },
	{ questions: [q("Pick?", [opt("Same"), opt("Sa\rme")])] },
];
const validateCases = validateInputs.map((input) => ({ input, out: validate.validateQuestionnaire(sanitize.sanitizeQuestionnaire(input as never)) }));

const answers = [
	{ questionIndex: 0, question: "Q0", kind: "option", answer: "A" },
	{ questionIndex: 0, question: "Q0", kind: "option", answer: null },
	{ questionIndex: 0, question: "Q0", kind: "option", answer: "A", preview: "```ts\nx\n```", notes: "be careful" },
	{ questionIndex: 1, question: "Q1", kind: "custom", answer: "typed" },
	{ questionIndex: 1, question: "Q1", kind: "custom", answer: "" },
	{ questionIndex: 1, question: "Q1", kind: "custom", answer: null, notes: "" },
	{ questionIndex: 2, question: "Q2", kind: "multi", answer: null, selected: ["A", "B"] },
	{ questionIndex: 2, question: "Q2", kind: "multi", answer: null, selected: [] },
];
const answerCases = answers.map((a) => ({ answer: a, segment: envelope.buildAnswerSegment(a) }));
const params3 = { questions: [q("Q0", [opt("A"), opt("B")]), q("Q1", [opt("A"), opt("B")]), q("Q2", [opt("A"), opt("B")], { multiSelect: true })] };
const responseResults: unknown[] = [
	null,
	{ answers: [], cancelled: true },
	{ answers: [answers[0]], cancelled: true },
	{ answers: [], cancelled: false },
	{ answers: [answers[6], answers[0]], cancelled: false },
	{ answers: [answers[2], answers[3], answers[7]], cancelled: false },
	{ answers: [{ ...answers[0], questionIndex: 9 }], cancelled: false },
];
const responseCases = responseResults.map((result) => ({ result, out: envelope.buildQuestionnaireResponse(result as never, params3 as never) }));

const itemsCases = Object.values(questionnaires).flatMap((qs) => qs.questions.map((question) => ({ question, items: tool.buildItemsForQuestion(question) })));

const collapseInputs: unknown[] = [
	undefined, null, "", "   ", "off", " OFF ", "ctrl+]", "Ctrl+]", "alt+o", "ctrl+}", "ctrl+shift+h", "ctr+]", "ctrl+ctrl+a",
	"+a", "a+", "ctrl++", "shift+tab", "f12", "f13", "ctrl+é", "ctrl+🙂", "super+space", "x", "ctrl+\\", "esc", 5, true,
];
const collapseCases = collapseInputs.map((value) => {
	const cfg = value === undefined ? {} : { collapseKey: value };
	try {
		return { config: cfg, out: config.resolveCollapseKey(cfg as never), error: null };
	} catch (error) {
		return { config: cfg, out: null, error: (error as Error).message };
	}
});

const layoutItems = tool.buildItemsForQuestion(questionnaires.preview.questions[0]);
const layoutCases = {
	decide: [[99, 120], [100, 99], [100, 100], [160, 120]].map(([t, p]) => ({ t, p, out: layout.decideLayout(t, p) })),
	adaptive: [20, 60, 100, 140, 200].map((w) => ({ w, out: layout.adaptiveLeftWidth(layoutItems, layoutItems.length, w) })),
	donation: Object.entries(questionnaires).flatMap(([name, qs]) =>
		[60, 100, 120, 160, 220].map((w) => ({
			name,
			w,
			out: layout.crossTabLeftWidthWithDonation(
				qs.questions.map((x) => ({ multiSelect: x.multiSelect })),
				qs.questions.map((x) => tool.buildItemsForQuestion(x)),
				qs.questions,
				w,
			),
		})),
	),
	columns: [[10, 5], [100, 40], [100, 120], [3, 30]].map(([p, a]) => ({ p, a, out: layout.columnWidths(p, a) })),
	body: [[100, "stacked", 40], [120, "side-by-side", 40], [120, "side-by-side", 200]].map(([p, m, a]) => ({ p, m, a, out: layout.bodyWidths(p as number, m as never, a as number) })),
	source: Object.entries(questionnaires).flatMap(([name, qs]) => qs.questions.map((x, i) => ({ name, i, out: layout.previewSourceWidth(x) }))),
};
const fenceLines = ["```ts", "\x1b[90m```\x1b[39m", "code", "  ```", "\x1b]8;;http://x\x07```", "``"];
const boxCases = {
	strip: box.stripFenceMarkers(fenceLines),
	borders: [
		{ lines: ["a", "bb"], width: 10, hidden: 0 },
		{ lines: ["wide line here"], width: 8, hidden: 3 },
		{ lines: [], width: 40, hidden: 12 },
		{ lines: ["🙂漢"], width: 2, hidden: 0 },
	].map((c) => ({ ...c, out: box.renderBorderedBox(c.lines, c.width, (s: string) => `<${s}>`, c.hidden) })),
	dims: [
		{ lines: ["short"], max: 60 },
		{ lines: ["x".repeat(70) + "   "], max: 60 },
		{ lines: ["abc   \x1b[39m"], max: 20 },
	].map((c) => ({ ...c, out: box.computeBoxDimensions(c.lines, c.max) })),
};

// ---------------------------------------------------------------------------
// pi-tui Input
// ---------------------------------------------------------------------------

const inputScripts: string[][] = [
	["hello", "left", "left", "x", "home", "a", "end", "b"],
	["hello", "ctrlW", "ctrlW", "undo", "undo"],
	["dotted", "altB", "altB", "ctrlW", "altF", "altD", "ctrlY"],
	["hello", "ctrlA", "ctrlK", "ctrlY", "ctrlY", "altY"],
	["hello", "ctrlLeft", "ctrlU", "ctrlE", "ctrlLeft", "ctrlRight", "del", "ctrlD"],
	["emoji", "cjk", "e_acute", "left", "backspace", "left", "backspace", "ctrlB", "ctrlF"],
	["kittyA", "paste", "lf", "enter", "escape", "tab"],
	["pasteStart", "pasteEnd", "a"],
	["a", "b", "space", "a", "undo", "undo"],
	[...Array(14).fill("hello"), "left", "left", "home", "right"],
];
const inputCases = inputScripts.map((keys) => {
	const input = new tui.Input();
	const steps: unknown[] = [];
	for (const key of keys) {
		input.handleInput(KEYS[key]);
		const cursor = (input as unknown as { cursor: number }).cursor;
		input.focused = steps.length % 2 === 0;
		steps.push({ key, value: input.getValue(), cursor, focused: input.focused, renders: [1, 2, 3, 12, 40].map((w) => input.render(w)) });
	}
	return { keys, steps };
});

// ---------------------------------------------------------------------------
// QuestionnaireSession scenarios
// ---------------------------------------------------------------------------

const ser = (s: any) => ({
	currentTab: s.currentTab,
	optionIndex: s.optionIndex,
	inputMode: s.inputMode,
	notesVisible: s.notesVisible,
	answers: [...s.answers.entries()].sort((a: any, b: any) => a[0] - b[0]),
	multiSelectChecked: [...s.multiSelectChecked].sort((a: number, b: number) => a - b),
	notesByTab: [...s.notesByTab.entries()].sort((a: any, b: any) => a[0] - b[0]),
	focusedOptionHasPreview: s.focusedOptionHasPreview,
	submitChoiceIndex: s.submitChoiceIndex,
	notesDraft: s.notesDraft,
	collapsed: s.collapsed,
});
const inputState = (input: any) => ({ value: input.getValue(), cursor: input.cursor });

type Scenario = { name: string; questionnaire: string; keys: string[]; sizes: Array<[number, number]>; collapseKey?: string };
const ALL_SIZES: Array<[number, number]> = [[160, 50], [100, 40], [80, 24], [40, 30], [16, 12]];
const scenarios: Scenario[] = [
	{ name: "single-pick", questionnaire: "single", keys: ["down", "j", "k", "down", "enter"], sizes: ALL_SIZES },
	{ name: "single-wrap-custom", questionnaire: "single", keys: ["up", "hello", "left", "x", "enter"], sizes: ALL_SIZES },
	{ name: "single-custom-escape", questionnaire: "single", keys: ["k", "j", "a", "escape", "up", "escape"], sizes: [[80, 24]] },
	{ name: "single-empty-custom", questionnaire: "single", keys: ["up", "enter"], sizes: [[80, 24]] },
	{ name: "single-collapse", questionnaire: "single", keys: ["collapse", "down", "enter", "collapse", "down", "enter"], sizes: [[80, 24], [40, 10]] },
	{ name: "single-collapse-cancel", questionnaire: "single", keys: ["collapse", "ctrlC"], sizes: [[80, 24]] },
	{ name: "single-alt-collapse", questionnaire: "single", keys: ["collapse", "altO", "altO", "escape"], sizes: [[80, 24]], collapseKey: "alt+o" },
	{ name: "single-off-collapse", questionnaire: "single", keys: ["collapse", "n", "escape"], sizes: [[80, 24]], collapseKey: "off" },
	{ name: "single-overflow", questionnaire: "single", keys: ["down", "down", "down", "down", "up"], sizes: [[60, 14], [60, 9], [60, 6], [30, 5], [30, 3]] },
	{ name: "preview-notes", questionnaire: "preview", keys: ["n", "note", "backspace", "enter", "down", "n", "escape", "up", "enter"], sizes: ALL_SIZES },
	{ name: "preview-walk", questionnaire: "preview", keys: ["down", "down", "down", "n", "down", "hello", "up", "down", "x", "enter"], sizes: ALL_SIZES },
	{ name: "preview-overflow", questionnaire: "preview", keys: ["down", "down", "down", "down"], sizes: [[120, 18], [80, 14], [120, 8]] },
	{ name: "multi-toggle", questionnaire: "multi", keys: ["space", "down", "enter", "down", "space", "enter", "down", "down", "enter"], sizes: ALL_SIZES },
	{ name: "multi-custom", questionnaire: "multi", keys: ["space", "down", "space", "up", "up", "emoji", "hello", "hello", "enter"], sizes: ALL_SIZES },
	{ name: "multi-escape", questionnaire: "multi", keys: ["k", "k", "escape", "escape"], sizes: [[80, 24]] },
	{
		name: "tabs-submit",
		questionnaire: "tabs",
		keys: ["enter", "space", "down", "space", "down", "down", "enter", "n", "note", "enter", "down", "enter", "up", "down", "shiftTab", "left", "h", "l", "tab", "right", "enter"],
		sizes: ALL_SIZES,
	},
	{ name: "tabs-partial-cancel", questionnaire: "tabs", keys: ["tab", "tab", "tab", "down", "j", "k", "down", "enter"], sizes: [[100, 40], [60, 20]] },
	{ name: "tabs-partial-submit", questionnaire: "tabs", keys: ["l", "space", "h", "up", "hello", "enter", "tab", "enter", "escape"], sizes: [[100, 40], [60, 12]] },
	{ name: "tabs-custom-back", questionnaire: "tabs", keys: ["up", "hello", "enter", "shiftTab", "up", "ctrlA", "ctrlK", "a", "enter", "left", "enter", "escape"], sizes: [[100, 40], [80, 24]] },
	{ name: "unicode", questionnaire: "unicode", keys: ["down", "enter", "up", "cjk", "e_acute", "enter", "enter"], sizes: [[80, 24], [24, 20], [12, 10]] },
	{ name: "input-editing", questionnaire: "single", keys: ["up", "paste", "kittyA", "ctrlW", "altB", "ctrlE", "pasteStart", "pasteEnd", "ctrlU", "undo", "escape"], sizes: [[80, 24], [30, 20]] },
];

function runScenario(s: Scenario) {
	const params = questionnaires[s.questionnaire];
	const itemsByTab = params.questions.map((x) => tool.buildItemsForQuestion(x));
	const terminal = { columns: s.sizes[0][0], rows: s.sizes[0][1] };
	let renders = 0;
	let done: unknown = null;
	const hidden: boolean[] = [];
	const session = new sessionMod.QuestionnaireSession({
		tui: { terminal, requestRender: () => renders++ },
		theme,
		params,
		itemsByTab,
		done: (result: unknown) => {
			done = result;
		},
		collapseKey: s.collapseKey ?? "ctrl+]",
	});
	session.setOverlayHandle({ setHidden: (h: boolean) => hidden.push(h) } as never);
	const anySession = session as any;
	const frames: unknown[] = [];
	const snap = (key: string | null, action: unknown) => {
		frames.push({
			key,
			action,
			state: ser(anySession.state),
			input: inputState(anySession.inlineInput),
			notes: inputState(anySession.notesInput),
			done,
			hidden: [...hidden],
			renders: s.sizes.map(([columns, rows]) => {
				terminal.columns = columns;
				terminal.rows = rows;
				return session.component.render(columns);
			}),
		});
	};
	snap(null, null);
	for (const key of s.keys) {
		if (done) break;
		const action = keyRouter.routeKey(KEYS[key], anySession.state, anySession.runtime());
		session.dispatch(KEYS[key]);
		snap(key, action);
	}
	return { ...s, frames, requestRenders: renders };
}
const scenarioCases = scenarios.map(runScenario);

// ---------------------------------------------------------------------------
// Reducer cases beyond the scenarios
// ---------------------------------------------------------------------------

const mkState = (over: Record<string, unknown> = {}) => ({
	currentTab: 0, optionIndex: 0, inputMode: false, notesVisible: false, answers: new Map(), multiSelectChecked: new Set(),
	notesByTab: new Map(), focusedOptionHasPreview: false, submitChoiceIndex: 0, notesDraft: "", collapsed: false, ...over,
});
const tabsQs = questionnaires.tabs.questions;
const tabsCtx = { questions: tabsQs, itemsByTab: tabsQs.map((x) => tool.buildItemsForQuestion(x)) };
const ans = (i: number, extra: Record<string, unknown>) => ({ questionIndex: i, question: tabsQs[i].question, ...extra });
const reduceInputs: Array<{ state: any; action: any }> = [
	{ state: mkState({ notesVisible: true, notesDraft: "  keep  ", answers: new Map([[0, ans(0, { kind: "option", answer: "Go" })]]) }), action: { kind: "notes_exit" } },
	{ state: mkState({ notesVisible: true, notesDraft: "   ", notesByTab: new Map([[0, "old"]]), answers: new Map([[0, ans(0, { kind: "option", answer: "Go", notes: "old" })]]) }), action: { kind: "notes_exit" } },
	{ state: mkState({ answers: new Map([[0, ans(0, { kind: "custom", answer: "prior" })]]) }), action: { kind: "nav", nextIndex: 2 } },
	{ state: mkState({ answers: new Map([[0, ans(0, { kind: "custom", answer: null })]]) }), action: { kind: "nav", nextIndex: 2 } },
	{ state: mkState({ currentTab: 1, optionIndex: 3, inputMode: true }), action: { kind: "exit_input_mode" } },
	{ state: mkState({ currentTab: 1, multiSelectChecked: new Set([0, 1]), notesByTab: new Map([[1, "n1"]]) }), action: { kind: "toggle", index: 1 } },
	{ state: mkState({ currentTab: 1, multiSelectChecked: new Set([0]) }), action: { kind: "toggle", index: 0 } },
	{ state: mkState({ currentTab: 1, notesByTab: new Map([[1, "n1"]]) }), action: { kind: "multi_confirm", selected: ["Lint"], autoAdvanceTab: 2 } },
	{ state: mkState({ currentTab: 1, multiSelectChecked: new Set([1]) }), action: { kind: "confirm", answer: ans(1, { kind: "custom", answer: "own" }) } },
	{ state: mkState({ currentTab: 2, notesByTab: new Map([[2, "why"]]) }), action: { kind: "confirm", answer: ans(2, { kind: "option", answer: "Code" }), autoAdvanceTab: 3 } },
	{ state: mkState({ currentTab: 3, answers: new Map([[1, ans(1, { kind: "multi", answer: null, selected: ["Format"], notes: "fmt" })]]) }), action: { kind: "tab_switch", nextTab: 1 } },
	{ state: mkState({ currentTab: 3 }), action: { kind: "submit_nav", nextIndex: 1 } },
	{ state: mkState({ collapsed: true }), action: { kind: "toggle_collapsed" } },
	{ state: mkState(), action: { kind: "notes_forward", data: "x" } },
	{ state: mkState({ currentTab: 9 }), action: { kind: "multi_confirm", selected: [] } },
	{ state: mkState({ answers: new Map([[2, ans(2, { kind: "option", answer: "Wide" })], [0, ans(0, { kind: "option", answer: "Go" })]]) }), action: { kind: "submit" } },
];
const reduceCases = reduceInputs.map(({ state, action }) => {
	const out = reducer.reduce(state, action, tabsCtx);
	return { state: ser(state), action, out: { state: ser(out.state), effects: out.effects } };
});

// ---------------------------------------------------------------------------
// RPC fallback
// ---------------------------------------------------------------------------

type Reply = { value?: unknown; undef?: boolean };
const rpcScenarios: Array<{ questionnaire: string; replies: Reply[] }> = [
	{ questionnaire: "single", replies: [{ value: "2. SQLite — Embedded, zero setup." }] },
	{ questionnaire: "single", replies: [{ value: "4. Type something." }, { value: "my own" }] },
	{ questionnaire: "single", replies: [{ value: "4. Type something." }, { undef: true }] },
	{ questionnaire: "single", replies: [{ undef: true }] },
	{ questionnaire: "single", replies: [{ value: null }] },
	{ questionnaire: "single", replies: [{ value: "9. bogus" }] },
	{ questionnaire: "single", replies: [{ value: 3 }] },
	{ questionnaire: "preview", replies: [{ value: "1. Function — A plain function." }] },
	{ questionnaire: "multi", replies: [{ value: " 1, 3 3. " }] },
	{ questionnaire: "multi", replies: [{ value: "   " }] },
	{ questionnaire: "multi", replies: [{ value: "1 13" }] },
	{ questionnaire: "multi", replies: [{ value: "just words" }] },
	{ questionnaire: "multi", replies: [{ undef: true }] },
	{ questionnaire: "tabs", replies: [{ value: "1. Go — Compiled." }, { value: "2" }, { value: "2. Code — Code sample." }] },
	{ questionnaire: "tabs", replies: [{ value: "2. TypeScript — Typed JS." }, { undef: true }] },
	{ questionnaire: "unicode", replies: [{ value: "2. English 🙂 — Emoji label." }, { value: "1. Yes — " }] },
];
const rpcCases = await Promise.all(
	rpcScenarios.map(async (s) => {
		const calls: unknown[] = [];
		let i = 0;
		const next = () => {
			const r = s.replies[i++] ?? { undef: true };
			return r.undef ? undefined : r.value;
		};
		const ui = {
			select: async (title: string, options: string[]) => {
				calls.push({ fn: "select", title, options });
				return next();
			},
			input: async (title: string, placeholder?: string) => {
				calls.push({ fn: "input", title, placeholder });
				return next();
			},
		};
		const result = await rpc.runRpcQuestionnaire(ui as never, questionnaires[s.questionnaire] as never);
		return { ...s, calls, result };
	}),
);

// ---------------------------------------------------------------------------
// Registration, reconcile, and execute through a mock host
// ---------------------------------------------------------------------------

const configDir = join(root, ".config", "rpiv-ask-user-question");
const writeConfig = (value: unknown) => {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify(value));
};
const clearConfig = () => rmSync(configDir, { recursive: true, force: true });

function registerWith(cfg: unknown) {
	if (cfg === null) clearConfig();
	else writeConfig(cfg);
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	const pi = {
		registerTool: (t: any) => tools.push(t),
		on: (ev: string, h: any) => (handlers[ev] ??= []).push(h),
		events: { emit: () => {} },
	};
	tool.registerAskUserQuestionTool(pi as never);
	const t = tools[0];
	return {
		tool: t,
		meta: {
			name: t.name,
			label: t.label,
			description: t.description,
			promptSnippet: t.promptSnippet,
			promptGuidelines: t.promptGuidelines,
			parameters: JSON.parse(JSON.stringify(t.parameters)),
			executionMode: t.executionMode,
		},
	};
}
const registrations = [
	{ config: null, ...registerWith(null) },
	{ config: { guidance: { promptSnippet: "Custom snippet", promptGuidelines: ["Use ask_user_question sparingly."] } }, ...registerWith({ guidance: { promptSnippet: "Custom snippet", promptGuidelines: ["Use ask_user_question sparingly."] } }) },
	{ config: { guidance: { promptSnippet: "", promptGuidelines: ["ok", ""] } }, ...registerWith({ guidance: { promptSnippet: "", promptGuidelines: ["ok", ""] } }) },
];
const registrationCases = registrations.map((r) => ({ config: r.config, meta: r.meta }));

const reconcileCases = [
	{ hasUI: false, active: ["read", "ask_user_question", "bash"] },
	{ hasUI: true, active: ["read", "bash"] },
	{ hasUI: true, active: ["ask_user_question"] },
	{ hasUI: false, active: ["read"] },
].map((c) => {
	let active = [...c.active];
	let calls = 0;
	reconcile.reconcileAskUserQuestionTool(
		{ getActiveTools: () => [...active], setActiveTools: (n: string[]) => { calls++; active = [...n]; } } as never,
		{ hasUI: c.hasUI } as never,
	);
	return { ...c, out: active, setCalls: calls };
});

type ExecScenario = {
	name: string;
	params: unknown;
	hasUI?: boolean;
	mode?: string;
	dialogs?: boolean;
	terminalInput?: boolean;
	customUndefined?: boolean;
	config?: unknown;
	keys?: string[];
	replies?: Reply[];
	size?: [number, number];
	unfocused?: boolean;
};
const P = questionnaires;
const execScenarios: ExecScenario[] = [
	{ name: "no-ui", params: P.single, hasUI: false },
	{ name: "no-questions", params: { questions: [] } },
	{ name: "reserved", params: { questions: [q("Q", [opt("Other"), opt("B")])] } },
	{ name: "duplicate-after-sanitize", params: { questions: [q("Q", [opt("Same"), opt("Sa\rme")])] } },
	{ name: "rpc-single", params: P.single, mode: "rpc", replies: [{ value: "1. Postgres (Recommended) — Relational, strong consistency and rich SQL." }] },
	{ name: "rpc-preview-custom", params: P.preview, mode: "rpc", replies: [{ value: "5. Type something." }, { value: "write it inline" }] },
	{ name: "rpc-cancel", params: P.tabs, mode: "rpc", replies: [{ value: "1. Go — Compiled." }, { undef: true }] },
	{ name: "rpc-no-dialogs", params: P.single, mode: "rpc", dialogs: false, customUndefined: true },
	{ name: "tui-single", params: P.single, keys: ["down", "enter"] },
	{ name: "tui-cancel", params: P.single, keys: ["escape"] },
	{ name: "tui-preview-notes", params: P.preview, keys: ["n", "note", "enter", "enter"], size: [120, 40] },
	{ name: "tui-multi", params: P.multi, keys: ["space", "j", "j", "space", "j", "j", "enter"] },
	{ name: "tui-tabs", params: P.tabs, keys: ["enter", "space", "j", "j", "j", "enter", "j", "enter", "enter"], size: [100, 40] },
	{ name: "tui-custom", params: P.single, keys: ["up", "hello", "enter"] },
	{ name: "tui-collapse", params: P.single, keys: ["collapse", "down", "enter", "collapse", "collapse", "collapse", "down", "enter"] },
	{ name: "tui-collapse-unfocused", params: P.single, keys: ["collapse", "down", "enter"], unfocused: true },
	{ name: "tui-collapse-off", params: P.single, config: { collapseKey: "off" }, keys: ["collapse", "down", "enter"] },
	{ name: "tui-collapse-alt", params: P.single, config: { collapseKey: " Alt+O " }, keys: ["collapse", "altO", "altO", "enter"] },
	{ name: "tui-collapse-invalid", params: P.single, config: { collapseKey: "ctr+]" }, keys: ["collapse", "collapse", "enter"] },
	{ name: "tui-collapse-number", params: P.single, config: { collapseKey: 5 }, keys: ["enter"] },
	{ name: "tui-no-terminal-input", params: P.single, terminalInput: false, keys: ["down", "enter"] },
	{ name: "custom-undefined-dialogs", params: P.multi, customUndefined: true, replies: [{ value: "2" }] },
	{ name: "custom-undefined-no-dialogs", params: P.single, customUndefined: true, dialogs: false },
	{ name: "tui-sanitized", params: { questions: [{ question: "Pick\r one?", header: "H\x1b[1m", options: [{ label: "A\r\r a", description: "x\r\ny" }, { label: "B", description: "b", preview: "p\r" }] }] }, keys: ["down", "enter"] },
];
const execCases: unknown[] = [];
for (const s of execScenarios) {
	if (s.config === undefined) clearConfig();
	else writeConfig(s.config);
	const emitted: unknown[] = [];
	const notifies: unknown[] = [];
	const customCalls: unknown[] = [];
	const dialogCalls: unknown[] = [];
	const listenerLog: string[] = [];
	const frames: unknown[] = [];
	const hiddenCalls: boolean[] = [];
	let replyIndex = 0;
	const nextReply = () => {
		const r = s.replies?.[replyIndex++] ?? { undef: true };
		return r.undef ? undefined : r.value;
	};
	const [cols, rows] = s.size ?? [80, 24];
	const listeners: Array<(d: string) => unknown> = [];
	const ui: Record<string, unknown> = {
		notify: (message: string, level: string) => notifies.push({ message, level }),
		custom: async (factory: any, options: any) => {
			customCalls.push({ overlay: options?.overlay, overlayOptions: options?.overlayOptions, hasOnHandle: typeof options?.onHandle === "function" });
			if (s.customUndefined) return undefined;
			let result: unknown;
			let finished = false;
			const component = factory({ terminal: { columns: cols, rows }, requestRender: () => {} }, theme, {}, (r: unknown) => {
				result = r;
				finished = true;
			});
			const handle = {
				hidden: false,
				focused: !s.unfocused,
				setHidden(h: boolean) {
					this.hidden = h;
					hiddenCalls.push(h);
				},
				isHidden() {
					return this.hidden;
				},
				isFocused() {
					return this.focused;
				},
			};
			options?.onHandle?.(handle);
			frames.push({ key: null, consumed: false, routed: false, hidden: false, lines: component.render(cols) });
			for (const key of s.keys ?? []) {
				let consumed = false;
				for (const l of [...listeners]) {
					const r = l(KEYS[key]) as { consume?: boolean } | undefined;
					if (r?.consume) {
						consumed = true;
						break;
					}
				}
				let routed = false;
				if (!consumed && !handle.hidden && handle.focused) {
					component.handleInput(KEYS[key]);
					routed = true;
				}
				frames.push({ key, consumed, routed, hidden: handle.hidden, lines: component.render(cols) });
				if (finished) break;
				// An overlay on top (e.g. /btw) closes after the first key.
				handle.focused = true;
			}
			return result;
		},
	};
	if (s.dialogs !== false) {
		ui.select = async (title: string, options: string[]) => {
			dialogCalls.push({ fn: "select", title, options });
			return nextReply();
		};
		ui.input = async (title: string, placeholder?: string) => {
			dialogCalls.push({ fn: "input", title, placeholder });
			return nextReply();
		};
	}
	if (s.terminalInput !== false) {
		ui.onTerminalInput = (l: (d: string) => unknown) => {
			listeners.push(l);
			listenerLog.push("subscribe");
			return () => {
				const i = listeners.indexOf(l);
				if (i >= 0) listeners.splice(i, 1);
				listenerLog.push("unsubscribe");
			};
		};
	}
	const ctx = { hasUI: s.hasUI ?? true, mode: s.mode, ui, sessionManager: { getSessionId: () => "session-1" } };
	// Route pi.events.emit of the registered tool into this scenario's log.
	const { tool: fresh } = (() => {
		const tools: any[] = [];
		const pi = { registerTool: (t: any) => tools.push(t), on: () => {}, events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data: JSON.parse(JSON.stringify(data)) }) } };
		tool.registerAskUserQuestionTool(pi as never);
		return { tool: tools[0] };
	})();
	let result: unknown = null;
	let error: string | null = null;
	try {
		result = await fresh.execute("call-1", JSON.parse(JSON.stringify(s.params)), undefined, undefined, ctx);
	} catch (e) {
		error = (e as Error).message;
	}
	execCases.push({
		name: s.name,
		params: s.params,
		hasUI: s.hasUI ?? true,
		mode: s.mode ?? "",
		dialogs: s.dialogs !== false,
		terminalInput: s.terminalInput !== false,
		customUndefined: !!s.customUndefined,
		unfocused: !!s.unfocused,
		config: s.config ?? null,
		keys: s.keys ?? [],
		replies: s.replies ?? [],
		size: [cols, rows],
		result,
		error,
		emitted,
		notifies,
		customCalls,
		dialogCalls,
		listenerLog,
		frames,
		hiddenCalls,
	});
}
clearConfig();
rmSync(root, { recursive: true, force: true });

const golden = {
	roleCodes: ROLE_CODES,
	mdCodes: shim.MD_CODES,
	keyTable,
	questionnaires,
	sanitizeTexts,
	sanitizeCases,
	validateCases,
	answerCases,
	responseParams: params3,
	responseCases,
	itemsCases,
	collapseCases,
	reservedLabels: types.RESERVED_LABELS,
	layoutCases,
	boxCases,
	inputCases,
	scenarioCases,
	reduceCases,
	rpcCases,
	registrationCases,
	reconcileCases,
	execCases,
};

const output = `${JSON.stringify(golden, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("askuserquestion golden.json is stale: run npx tsx go/internal/askuserquestion/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	const counts = Object.entries(golden)
		.filter(([, v]) => Array.isArray(v))
		.map(([k, v]) => `${k}=${(v as unknown[]).length}`)
		.join(" ");
	console.log(`wrote ${counts}`);
}
