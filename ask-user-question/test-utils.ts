import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	shortcuts: Map<
		string,
		{ description?: string; handler: (ctx: unknown) => Promise<void> | void }
	>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export function createMockPi(options: Partial<ExtensionAPI> = {}): {
	pi: ExtensionAPI;
	captured: CapturedPi;
} {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name))
				captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn(
			(
				name: string,
				command: Omit<RegisteredCommand, "name" | "sourceInfo">,
			) => {
				captured.commands.set(name, command);
			},
		),
		registerShortcut: vi.fn(
			(
				shortcut: string,
				value: CapturedPi["shortcuts"] extends Map<string, infer V> ? V : never,
			) => {
				captured.shortcuts.set(shortcut, value);
			},
		),
		registerFlag: vi.fn((name: string, value: unknown) =>
			captured.flags.set(name, value),
		),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		}),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		exec: vi.fn(async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		})),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium"),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const values = captured.eventsEmitted.get(channel) ?? [];
				values.push(data);
				captured.eventsEmitted.set(channel, values);
			}),
			on: vi.fn(() => () => {}),
		},
		getCommands: vi.fn(() => []),
		...options,
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

function createMockUI(
	overrides: Partial<ExtensionUIContext> = {},
): ExtensionUIContext {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		custom: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as ExtensionUIContext;
}

export function createMockCtx(
	options: {
		hasUI?: boolean;
		mode?: string;
		cwd?: string;
		model?: Model<Api>;
		branch?: SessionEntry[];
		models?: Model<Api>[];
		ui?: Partial<ExtensionUIContext>;
	} = {},
): ExtensionContext {
	const branch = options.branch ?? [];
	return {
		hasUI: options.hasUI ?? false,
		mode: options.mode,
		cwd: options.cwd ?? "/tmp/test-cwd",
		model: options.model,
		ui: createMockUI(options.ui),
		sessionManager: {
			getBranch: vi.fn(() => branch),
			getEntries: vi.fn(() => branch),
			getLeafId: vi.fn(() => branch.at(-1)?.id ?? null),
			getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
			getSessionId: vi.fn(() => "test-session"),
		},
		modelRegistry: {
			find: vi.fn((provider: string, id: string) =>
				options.models?.find(
					(model) => model.provider === provider && model.id === id,
				),
			),
			getAvailable: vi.fn(() => [...(options.models ?? [])]),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "test-key",
				headers: {},
			})),
		},
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

export interface MockTheme {
	fg: (_color: string, text: string) => string;
	bg: (_color: string, text: string) => string;
	bold: (text: string) => string;
	strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
		...overrides,
	};
}
