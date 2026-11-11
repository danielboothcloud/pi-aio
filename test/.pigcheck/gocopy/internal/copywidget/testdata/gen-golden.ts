// Regenerate golden.json from the TypeScript copy-widget feature (the
// reference):
//   npx tsx go/internal/copywidget/testdata/gen-golden.ts [--check]
// It drives the real modules: parse.ts (the marked lexer) on Markdown
// samples, pi-tui's Markdown component (the picker preview) with a
// deterministic Markdown theme (pi-shim.mjs), CopyBlockPicker renders and key
// sequences, and registerCopyWidget's /pick and ctrl+p handlers with scripted
// session branches, picker keys, and clipboard results.
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
register(pathToFileURL(join(here, "hooks.mjs")).href);

const shim = await import(join(here, "pi-shim.mjs"));
const parse = await import(join(repo, "copy-widget", "parse.ts"));
const picker = await import(join(repo, "copy-widget", "picker.ts"));
const widget = await import(join(repo, "copy-widget", "index.ts"));
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
// parse.ts
// ---------------------------------------------------------------------------

const JACK = "Hi Jack, I checked the switch for Equativ. The only roles on that account are Admin, Trafficker, Business Owner and Account Manager.";
const samples: string[] = [
	"",
	"   \n\n",
	"Before\n\n```ts\nconst answer = 42;\n```\n\n~~~sh\necho ok\n~~~\n",
	"```typescript title=example.ts\nlet value = 1;\n```",
	"````md\nUse ``` inside this block.\n````",
	"```json\n{\"ready\": true}",
	"```json\n{\"ready\": true}\n",
	"Use `inline()` here.\n\n    const indented = true;",
	"> ```js\n> console.log('quoted');\n> ```\n\n- item\n\n  ~~~py\n  print('listed')\n  ~~~",
	"```text\n```",
	`Here's a draft reply:\n\n> ${JACK}\n\nWant me to adjust it?`,
	"> Hi Jack, I checked\n> the switch for Equativ.\n>\n> Thanks,  \n> Daniel\\\n> (Novatiq)",
	"> Options:\n>\n> - export as yourself\n> - ask an admin\n>\n> > earlier message\nlazy continuation",
	"```sh\nls\n```\n\n> first quote\n\n- item\n\n  > quote in a list\n\n> ```js\n> quoted();\n> ```",
	">\n>\n",
	"> quoted\n\n```ts\nx\n```",
	"```\nno language\n```",
	"  ```js\n  indented fence\n    deeper\n  ```",
	"```go\n\tfunc() {}\n```",
	"1. one\n   ```sh\n   ls\n   ```\n2. two\n   - nested\n\n     ```py\n     x = 1\n     ```",
	"> # Title\n> Some *em* and `code`.\n> ```ts\n> let a;\n> ```\n> - a\n> - b",
	"> line one\nline two lazy\n\nafter",
	"> a\n\n> b",
	"~~~\n~~~",
	"````\n```\ninner\n```\n````",
	"> - item\n>   > deep",
	"   > indented quote\n   > second line",
	"```js\r\nwindows();\r\n```\r\n",
	"> | a | b |\n> |---|---|\n> | 1 | 2 |",
	"```a`b\nnot a fence\n```",
	"    ```\n    indented code with fence\n    ```",
	"> Title\n> ===\n> body",
	"<div>\n```js\ninside html\n```\n</div>\n\n```js\noutside();\n```",
	"- a\n\n  > loose quote\n\n- b",
	"Text\n```js\nafter paragraph\n```",
	"> q\n```js\nafter quote\n```",
	"```c\\+\\+ extra\nint x;\n```",
	"> spaced   \n> trailing\\\n> end",
	"> *emphasis* and **strong** with [a link](https://example.com) and `code`\n> and a second line",
	"```\n\n\nblank lines\n\n```",
	"> ~~~\n> unclosed in quote",
	"* star\n+ plus\n\n> after lists",
	"Para\n> quote right after paragraph",
];
const parseCases = samples.map((markdown) => ({
	markdown,
	all: parse.extractCopyableBlocks(markdown),
	code: parse.extractFencedCodeBlocks(markdown),
}));

const labelBlocks = [
	{ kind: "code", text: "x", language: "ts", lineCount: 1, ordinal: 1 },
	{ kind: "code", text: "a\nb", lineCount: 2, ordinal: 2 },
	{ kind: "code", text: "", lineCount: 0, ordinal: 3 },
	{ kind: "quote", text: "one", lineCount: 1, ordinal: 4 },
	{ kind: "quote", text: "a  long\n\nquote with many words that will be cut at forty characters for sure", lineCount: 3, ordinal: 5 },
	{ kind: "quote", text: "exactly forty characters long text here!", lineCount: 1, ordinal: 6 },
	{ kind: "quote", text: "x".repeat(38) + " yz", lineCount: 1, ordinal: 7 },
	{ kind: "quote", text: "🙂".repeat(30), lineCount: 1, ordinal: 8 },
];
const labels = labelBlocks.map((block) => ({ block, out: picker.blockLabel(block) }));

// ---------------------------------------------------------------------------
// pi-tui Markdown (the preview renderer)
// ---------------------------------------------------------------------------

const markdownSources = [
	"```ts\nconst a = 1;\nconst b = 2;\n```",
	"```\nplain\n```",
	"````md\nUse ``` here\n````",
	"```go\n\tfunc() {}\n```",
	"> plain quote",
	"> first paragraph that is long enough to wrap at a narrow width for sure\n>\n> second",
	"> Options:\n>\n> - export as yourself\n> - ask an admin\n>\n> > earlier message\n> lazy",
	"> # Title\n> Some *em* and **strong** and `code` and ~~gone~~ and ~kept~.\n> ```ts\n> let a;\n> ```\n> 1. one\n> 2. two",
	"> [link](https://example.com) [https://x.io](https://x.io) <https://auto.dev> www.example.com mail@example.com",
	"> line  \n> hard\\\n> break",
	"> - [x] done\n> - [ ] todo\n>\n> ---\n>\n> after rule",
	"> | a | b |\n> |---|---|\n> | 1 | long cell text that wraps |",
	"> <b>html</b> &amp; \\* escaped",
	"> - a\n>\n> - loose b\n>   - nested c\n>\n>   continued",
	"> 3. three\n> 4. four",
	"> ## Heading two\n> text\n> ### Heading three\n> more",
	"> Title\n> ===\n> body",
	"> > nested\n> > quote\n>\n> outer",
	"> 🙂 wide 漢字 text that should wrap nicely at small widths",
	"> ```\n> code in quote\n> ```\n> after code",
];
const markdownWidths = [10, 30, 56, 96];
const markdownCases: unknown[] = [];
for (const source of markdownSources) {
	for (const width of markdownWidths) {
		for (const hyperlinks of [false, true]) {
			if (hyperlinks && !source.includes("](")) continue;
			tui.setCapabilities({ images: null, trueColor: true, hyperlinks });
			markdownCases.push({ source, width, hyperlinks, out: new tui.Markdown(source, 1, 0, shim.getMarkdownTheme()).render(width) });
		}
	}
}
tui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });

// ---------------------------------------------------------------------------
// CopyBlockPicker
// ---------------------------------------------------------------------------

const pickerSource = [
	"```ts\nconst one = 1;\n```",
	"> A quoted reply with *emphasis* that is long enough to wrap in the preview area of the picker.",
	"```sh\nls -la\npwd\n```",
	"```\nplain\n```",
	"> short",
	"```py\n" + Array.from({ length: 14 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n```",
	"```ts\nconst seven = 7;\n```",
	"> - list in quote\n> - second",
].join("\n\n");
const manyBlocks = parse.extractCopyableBlocks(pickerSource);
const fewBlocks = manyBlocks.slice(0, 3);
const KEYS: Record<string, string> = {
	down: "\x1b[B", up: "\x1b[A", pageDown: "\x1b[6~", pageUp: "\x1b[5~", ctrlD: "\x04", ctrlU: "\x15",
	enter: "\r", escape: "\x1b", ctrlC: "\x03", j: "j", k: "k", g: "g", G: "G", q: "q", x: "x",
};
const pickerScenarios: Array<{ blocks: string; maxRows: number; widths: number[]; keys: string[] }> = [
	{ blocks: "many", maxRows: 40, widths: [3, 4, 5, 40, 80], keys: ["down", "j", "j", "ctrlD", "x", "up", "k", "pageDown", "pageUp", "G", "g", "ctrlU", "enter"] },
	{ blocks: "many", maxRows: 14, widths: [60], keys: ["G", "k", "k", "k", "escape"] },
	{ blocks: "many", maxRows: 12, widths: [60], keys: ["j", "j", "j", "j", "j", "q"] },
	{ blocks: "many", maxRows: 9, widths: [50], keys: ["pageDown", "pageDown", "ctrlC"] },
	{ blocks: "many", maxRows: 10, widths: [50], keys: ["j", "enter"] },
	{ blocks: "few", maxRows: 30, widths: [70], keys: ["k", "j", "j", "j", "enter"] },
	{ blocks: "empty", maxRows: 30, widths: [40], keys: ["j", "enter"] },
	{ blocks: "empty", maxRows: 6, widths: [40], keys: ["escape"] },
	...[1, 2, 3, 4, 5, 8].map((maxRows) => ({ blocks: "few", maxRows, widths: [40], keys: ["j", "enter"] })),
];
const pickerCases: unknown[] = [];
for (const s of pickerScenarios) {
	const blocks = s.blocks === "many" ? manyBlocks : s.blocks === "few" ? fewBlocks : [];
	let done: unknown = "pending";
	let renders = 0;
	const component = new picker.CopyBlockPicker({
		blocks,
		theme,
		requestRender: () => renders++,
		getMaxRows: () => s.maxRows,
		done: (result: { ordinal: number } | undefined) => {
			done = result ? result.ordinal : null;
		},
	});
	const frames: unknown[] = [];
	const snap = (key: string | null) => frames.push({ key, done, renders, lines: s.widths.map((w) => component.render(w)) });
	snap(null);
	for (const key of s.keys) {
		component.handleInput(KEYS[key]);
		snap(key);
	}
	pickerCases.push({ ...s, frames });
}

// ---------------------------------------------------------------------------
// registerCopyWidget
// ---------------------------------------------------------------------------

const commands = new Map<string, any>();
const shortcuts = new Map<string, any>();
widget.registerCopyWidget({
	registerCommand: (name: string, command: unknown) => commands.set(name, command),
	registerShortcut: (key: string, shortcut: unknown) => shortcuts.set(key, shortcut),
} as never);
const assistant = (...content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const text = (t: string) => ({ type: "text", text: t });
const branches: Record<string, unknown[]> = {
	empty: [],
	userOnly: [user("hi")],
	noBlocks: [user("hi"), assistant(text("Just prose, nothing to copy."))],
	emptyText: [assistant(text("```ts\nold\n```")), user("again"), assistant({ type: "thinking", thinking: "hmm" })],
	blocks: [
		assistant(text("```ts\nolder\n```")),
		{ type: "custom", customType: "x" },
		user("show me"),
		assistant({ type: "thinking", thinking: "```ts\nnot this\n```" }, text("Intro\n\n```ts\nconst a = 1;\n```"), { type: "toolCall", name: "read" }, text("> quoted reply\n\n```sh\nls\n```")),
		{ type: "message", message: { role: "toolResult", content: [text("```ts\nresult\n```")] } },
	],
	failing: [assistant(text("```sh\necho FAIL\n```"))],
};
const registerScenarios: Array<{ trigger: string; mode: string; branch: string; keys: string[] }> = [
	{ trigger: "shortcut", mode: "rpc", branch: "blocks", keys: [] },
	{ trigger: "command", mode: "print", branch: "blocks", keys: [] },
	{ trigger: "shortcut", mode: "tui", branch: "empty", keys: [] },
	{ trigger: "command", mode: "tui", branch: "userOnly", keys: [] },
	{ trigger: "shortcut", mode: "tui", branch: "noBlocks", keys: [] },
	{ trigger: "shortcut", mode: "tui", branch: "emptyText", keys: [] },
	{ trigger: "shortcut", mode: "tui", branch: "blocks", keys: ["enter"] },
	{ trigger: "command", mode: "tui", branch: "blocks", keys: ["j", "enter"] },
	{ trigger: "shortcut", mode: "tui", branch: "blocks", keys: ["G", "enter"] },
	{ trigger: "shortcut", mode: "tui", branch: "blocks", keys: ["escape"] },
	{ trigger: "shortcut", mode: "tui", branch: "failing", keys: ["enter"] },
];
const registerCases: unknown[] = [];
for (const s of registerScenarios) {
	const notifications: unknown[] = [];
	const customCalls: unknown[] = [];
	shim.clipboard.length = 0;
	const ctx = {
		mode: s.mode,
		hasUI: s.mode !== "print",
		sessionManager: { getBranch: () => branches[s.branch] },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			custom: async (factory: any, options: unknown) => {
				let result: unknown;
				const component = factory({ requestRender: () => {}, terminal: { rows: 30, columns: 100 } }, theme, {}, (value: unknown) => {
					result = value;
				});
				const firstFrame = component.render(80);
				for (const key of s.keys) component.handleInput(KEYS[key]);
				customCalls.push({ options, firstFrame });
				return result;
			},
		},
	};
	if (s.trigger === "shortcut") await shortcuts.get("ctrl+p").handler(ctx);
	else await commands.get("pick").handler("", ctx);
	registerCases.push({ ...s, notifications, customCalls, clipboard: [...shim.clipboard] });
}

const golden = {
	roleCodes: ROLE_CODES,
	mdCodes: shim.MD_CODES,
	keys: KEYS,
	parseCases,
	labels,
	markdownCases,
	pickerSource,
	manyBlocks,
	pickerCases,
	commands: [...commands.entries()].map(([name, c]) => ({ name, description: c.description })),
	shortcuts: [...shortcuts.entries()].map(([key, s]) => ({ key, description: s.description })),
	branches,
	registerCases,
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
		console.error("copywidget golden.json is stale: run npx tsx go/internal/copywidget/testdata/gen-golden.ts");
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
