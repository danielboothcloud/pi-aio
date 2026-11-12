// Part of gen-golden.ts (imported, not run alone): the /recipe init,
// /recipe status, /recipe-status, session trust question, and launch
// decisions of the TypeScript recipes feature. It drives the real
// registerRecipes command handlers and session_start through a mock pi/ctx.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = unknown;

export async function generate(options: {
	repo: string;
	root: string;
	placeholders: <T>(value: T) => T;
	setStderr: (write: typeof process.stderr.write) => void;
}): Promise<{ golden: Record<string, Json>; counts: string }> {
	const { repo, root, placeholders } = options;
	const index = await import(join(repo, "recipes", "index.ts"));
	const status = await import(join(repo, "recipes", "status.ts"));
	const apply = await import(join(repo, "recipes", "apply.ts"));
	const trampoline = await import(join(repo, "recipes", "trampoline.ts"));
	const trust = await import(join(repo, "recipes", "trust.ts"));
	const config = await import(join(repo, "recipes", "config.ts"));
	const modeAccess = await import(join(repo, "permission-modes", "mode-access.ts"));
	const styleAccess = await import(join(repo, "styles", "style-access.ts"));

	for (const key of ["AIO_RECIPE_ACTIVE", "AIO_RECIPE_STAGE", "AIO_RECIPE_ORIGIN", "AIO_SUBAGENT_CHILD", "AIO_PIG_TRUST_ASKED", "AIO_PIG_LAUNCHER", "PIG_HARNESS_BINARY", "AIO_RECIPE_BLOCKLIST"]) {
		delete process.env[key];
	}
	const agentRecipes = process.env.AIO_RECIPES_FILE;
	const templatesFile = join(root, "templates", "aio-recipes.json");
	const useRecipes = (file: string | undefined) => {
		if (file) process.env.AIO_RECIPES_FILE = file;
		else delete process.env.AIO_RECIPES_FILE;
	};

	// ---- pure helpers ----
	const suggestCwds = ["/work/My Project!", "/work/init", "/work/_x", "/work/日本", "/", "", "/a/b/", "/work/STATUS", "/work/--a.b_c", "/work/x y  z", "/work/Ünïcode-1"];
	const suggest = suggestCwds.map((cwd) => ({ cwd, name: index.suggestRecipeName(cwd) }));
	const initArgs = [
		"", " ", "work", "  work  extra ", "--from", "--from home", "--from=home", "--from=", "name --from home", "--from home name",
		"a\u00a0--from\u2003b", "--from home --from work", "-x --fromx",
	].map((arg) => ({ arg, result: index.parseInitArgs(arg) }));

	useRecipes(templatesFile);
	const templates = config.loadRecipes(undefined).recipes as Record<string, { config: unknown; name: string }>;
	const seeds = [
		{},
		{ description: "Recipe for repo", model: "anthropic/claude-x", thinkingLevel: "high" },
		{ description: "Recipe for repo", model: "hf:zai/GLM:xhigh" },
		{ description: "Recipe for \u2028\"q\"" },
	];
	const scaffolds: Json[] = [];
	for (const name of ["proj", "a.b-c_d", "Ünï"]) {
		for (const seed of seeds) {
			scaffolds.push({ name, seed, template: null, text: index.recipeScaffold(name, seed) });
		}
	}
	for (const template of Object.keys(templates).sort()) {
		scaffolds.push({ name: "proj", seed: seeds[1], template, text: index.recipeScaffold("proj", seeds[1], structuredClone(templates[template]!.config)) });
	}
	useRecipes(agentRecipes);

	// ---- mock pi/ctx around the real registerRecipes ----
	type Note = { message: string; type: string };
	const state = {
		notes: [] as Note[],
		dialogs: [] as Json[],
		entries: [] as Json[],
		selects: [] as Array<string | undefined>,
		inputs: [] as Array<string | undefined>,
		stderr: [] as string[],
		thinking: "high",
		mode: "tui",
		hasUI: true,
		cwd: root,
		model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" } as Record<string, string> | undefined,
	};
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		registerFlag: () => {},
		registerEntryRenderer: () => {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getFlag: () => undefined,
		getThinkingLevel: () => state.thinking,
		appendEntry: (customType: string, data: unknown) => state.entries.push({ customType, data }),
		getCommands: () => [
			{ name: "recipe", source: "extension", sourceInfo: { path: "/ext/aio/index.ts", source: "local" } },
			{ name: "skill:x", source: "skill", sourceInfo: { path: "/skills/x", source: "local" } },
		],
		getAllTools: () => [
			{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
			{ name: "subagent", sourceInfo: { path: "/ext/aio/index.ts", source: "local" } },
		],
		getActiveTools: () => ["read", "subagent"],
		setModel: async () => true,
		setThinkingLevel: (level: string) => { state.thinking = level; },
		registerMcpServer: () => {},
		unregisterMcpServer: () => {},
		events: { emit: () => {} },
	};
	const models = [{ provider: "anthropic", id: "claude-x", api: "anthropic-messages" }, { provider: "openai", id: "gpt-5", api: "openai-responses" }];
	const ctx = () => ({
		get cwd() { return state.cwd; },
		get mode() { return state.mode; },
		get hasUI() { return state.hasUI; },
		get model() { return state.model; },
		scopedModels: [],
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "s" },
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: () => models,
			getRegisteredProviderIds: () => ["anthropic", "openai"],
		},
		ui: {
			notify: (message: string, type?: string) => state.notes.push({ message, type: type ?? "info" }),
			setStatus: () => {},
			select: async (title: string, options: string[]) => {
				state.dialogs.push({ op: "select", title, options });
				return state.selects.shift();
			},
			input: async (title: string, placeholder?: string) => {
				state.dialogs.push({ op: "input", title, placeholder: placeholder ?? null });
				return state.inputs.shift();
			},
			theme: { fg: (_role: string, text: string) => text },
		},
	});
	const factoryCwd = join(root, "factory");
	mkdirSync(factoryCwd, { recursive: true });
	const savedCwd = process.cwd();
	process.chdir(factoryCwd);
	apply.resetRecipeRuntimeForTests();
	await index.registerRecipes(pi as never, { interactiveLaunch: false, relaunch: async () => false, exitOnInvalidScope: ((code: number) => { throw new Error(`exit ${code}`); }) as never });
	// Node's own warnings (deprecations) are not part of parity.
	options.setStderr(((text: string) => { if (!String(text).startsWith("(node:")) state.stderr.push(String(text)); return true; }) as typeof process.stderr.write);
	const reset = () => {
		state.notes = [];
		state.dialogs = [];
		state.entries = [];
		state.stderr = [];
	};

	// ---- /recipe init ----
	type InitCase = {
		name: string;
		dir: string;
		args: string;
		templates?: "templates" | "notemplates" | "missing";
		hasUI?: boolean;
		selects?: Array<string | undefined>;
		inputs?: Array<string | undefined>;
		model?: false;
		thinking?: string;
		setup?: "existing" | "existing-json" | "directory";
	};
	const initCases: InitCase[] = [
		{ name: "blank headless", dir: "My Repo", args: "init", hasUI: false },
		{ name: "blank headless named", dir: "r1", args: "init  web-app ", hasUI: false, thinking: "xhigh" },
		{ name: "headless from", dir: "r2", args: "init --from work", hasUI: false },
		{ name: "headless from=", dir: "r3", args: "init svc --from=home", hasUI: false, model: false },
		{ name: "unknown from", dir: "r4", args: "init --from nope", hasUI: false },
		{ name: "unknown from none", dir: "r4b", args: "init --from nope", hasUI: false, templates: "missing" },
		{ name: "from missing name", dir: "r5", args: "init --from", hasUI: false },
		{ name: "invalid given name", dir: "r6", args: "init status", hasUI: false },
		{ name: "invalid spaced name", dir: "r6b", args: "init a b", hasUI: false },
		{ name: "picker blank", dir: "r7", args: "init", selects: ["Blank recipe (current model)"], inputs: ["  mine  "] },
		{ name: "picker copy", dir: "r8", args: "init", selects: ["Copy work — Work subscriptions with a description l..."], inputs: [""] },
		{ name: "picker unknown label", dir: "r8c", args: "init", selects: ["Copy work — something else"], inputs: ["x"] },
		{ name: "picker copy plain", dir: "r8b", args: "init named", selects: ["Copy plain"] },
		{ name: "picker cancel", dir: "r9", args: "init", selects: [undefined] },
		{ name: "input cancel", dir: "r10", args: "init", selects: ["Copy home — Home"], inputs: [undefined] },
		{ name: "input invalid", dir: "r11", args: "init", selects: ["Blank recipe (current model)"], inputs: ["-bad"] },
		{ name: "ui no templates", dir: "r12", args: "init", templates: "notemplates", inputs: ["ok"], thinking: "weird" },
		{ name: "ui from skips picker", dir: "r13", args: "init --from Ünï", inputs: ["uni"] },
		{ name: "reserved dir", dir: "init", args: "init", hasUI: false },
		{ name: "existing", dir: "r14", args: "init", setup: "existing" },
		{ name: "existing json", dir: "r15", args: "init", setup: "existing-json" },
		{ name: "directory in the way", dir: "r16", args: "init", hasUI: false, setup: "directory" },
	];
	const inits: Json[] = [];
	for (const c of initCases) {
		reset();
		const cwd = join(root, "init", c.dir);
		mkdirSync(cwd, { recursive: true });
		if (c.setup === "existing") writeFileSync(join(cwd, ".pi-recipe"), "{}");
		if (c.setup === "existing-json") writeFileSync(join(cwd, ".pi-recipe.json"), "{}");
		if (c.setup === "directory") mkdirSync(join(cwd, ".pi-recipe"));
		useRecipes(c.templates === "notemplates" ? join(root, "notemplates", "aio-recipes.json") : c.templates === "missing" ? join(root, "missing", "aio-recipes.json") : templatesFile);
		state.cwd = cwd;
		state.hasUI = c.hasUI ?? true;
		state.mode = state.hasUI ? "tui" : "json";
		state.selects = [...(c.selects ?? [])];
		state.inputs = [...(c.inputs ?? [])];
		state.model = c.model === false ? undefined : { provider: "anthropic", id: "claude-x", api: "anthropic-messages" };
		state.thinking = c.thinking ?? "high";
		await commands.get("recipe")!.handler(c.args, ctx());
		const file = join(cwd, ".pi-recipe");
		let text: string | null = null;
		try {
			text = c.setup ? null : readFileSync(file, "utf8");
		} catch {
			text = null;
		}
		inits.push(placeholders({
			case: c,
			notes: state.notes,
			dialogs: state.dialogs,
			text,
			trust: text !== null ? trust.recipeFileTrust(file) : null,
		}));
	}
	useRecipes(agentRecipes);

	// ---- /recipe status, /recipe-status ----
	const theme = { fg: (role: string, text: string) => `<${role}>${text}</>` };
	const normalizeReport = (report: Record<string, unknown>) => ({ ...report, capturedAt: "@@TIME@@" });
	useRecipes(templatesFile);
	const defs = config.loadRecipes(undefined).recipes as Record<string, any>;
	useRecipes(agentRecipes);
	type StatusCase = {
		name: string;
		recipe?: string;
		source?: string;
		argv: string[];
		env?: Record<string, string>;
		model?: { provider: string; id: string; api?: string } | null;
		scoped?: Array<{ provider: string; id: string }>;
		thinking?: string;
		providers?: string[] | null;
		access?: boolean;
		commands?: Array<{ name: string; source: string; sourceInfo?: { path: string; source: string } }>;
		tools?: Array<{ name: string; sourceInfo?: { path: string; source: string } }>;
		active?: string[];
	};
	const statusCases: StatusCase[] = [
		{ name: "off", argv: [] },
		{ name: "work bridged", recipe: "work", source: "env", argv: ["-ne", "-e", "/x/aio", "-e", "npm:pi-lens", "--models", "openai/*,anthropic/claude-x"], env: { AIO_RECIPE_ACTIVE: " work ", AIO_RECIPE_STAGE: "1" }, model: { provider: "openai", id: "gpt-5", api: "openai-responses" }, scoped: [{ provider: "openai", id: "gpt-5" }], access: true },
		{ name: "work unscoped switched", recipe: "work", source: "command", argv: ["--recipe", "home"], model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" }, thinking: "off" },
		{ name: "home flag", recipe: "home", source: "flag", argv: ["--recipe= home ", "-e", "git:https://user:p@ss@github.com/o/r?token=1#x", "-e", "git@github.com:o/r", "-e", "https://h.example/p\u0007x"], providers: null },
		{ name: "uni default", recipe: "Ünï", source: "default", argv: ["--models", ""], model: null, providers: [], active: [] },
		{ name: "bare flag", recipe: "plain", source: "session", argv: ["--recipe"], commands: [], tools: [] },
		{
			name: "sources", argv: ["-e", "./a.ts"],
			commands: [
				{ name: "b", source: "extension", sourceInfo: { path: "/z/ext.ts", source: "cli" } },
				{ name: "a", source: "extension", sourceInfo: { path: "/a/ext.ts", source: "npm:x@1" } },
				{ name: "a", source: "extension", sourceInfo: { path: "/a/ext.ts", source: "npm:x@1" } },
				{ name: "p", source: "prompt", sourceInfo: { path: "/p.md", source: "local" } },
				{ name: "nosrc", source: "extension" },
				{ name: "bi", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
			tools: [
				{ name: "t1", sourceInfo: { path: "https://u:pw@host/x?y=1", source: "git:ssh://k@h/r" } },
				{ name: "t2", sourceInfo: { path: "/a/ext.ts", source: "npm:x@1" } },
				{ name: "t3" },
				{ name: "t4", sourceInfo: { path: "B/ext.ts", source: "c" } },
			],
		},
	];
	const statuses: Json[] = [];
	for (const c of statusCases) {
		apply.resetRecipeRuntimeForTests();
		const runtime = apply.recipeRuntime();
		if (c.recipe) {
			runtime.activeName = c.recipe;
			// A fixed base folder: row wrapping depends on the path length.
			runtime.active = { ...defs[c.recipe], baseDir: "/recipes/home" };
			runtime.source = c.source;
		}
		if (c.access) {
			modeAccess.setPermissionModeAccess({ getMode: () => "plan", setMode: async () => {} });
			styleAccess.setStyleAccess({ getStyle: () => "concise", setStyle: async () => {} });
		} else {
			modeAccess.setPermissionModeAccess(undefined);
			styleAccess.setStyleAccess(undefined);
		}
		const statusPi = {
			...pi,
			getThinkingLevel: () => c.thinking ?? "medium",
			getCommands: () => c.commands ?? pi.getCommands(),
			getAllTools: () => c.tools ?? pi.getAllTools(),
			getActiveTools: () => c.active ?? pi.getActiveTools(),
		};
		const statusCtx = {
			...ctx(),
			model: c.model === undefined ? models[0] : c.model ?? undefined,
			scopedModels: (c.scoped ?? []).map((model) => ({ model })),
			modelRegistry: {
				...ctx().modelRegistry,
				getRegisteredProviderIds: c.providers === null ? undefined : () => c.providers ?? ["anthropic", "openai"],
			},
		};
		const def = runtime.active as { config: { model?: string } } | undefined;
		const spec = def?.config.model ? config.parseModelSpec(def.config.model) : undefined;
		const expectedModel = spec ? apply.findRecipeModel(statusCtx, spec.model) : undefined;
		const report = status.buildRecipeStatus(statusPi as never, statusCtx as never, { argv: ["node", "pi", ...c.argv], env: c.env ?? {} });
		const rows: Json[] = [];
		const fixed = { ...report, capturedAt: "@@TIME@@" };
		for (const width of [0, 4, 30, 72]) {
			for (const expanded of [false, true]) {
				rows.push({ width, expanded, rows: status.renderRecipeStatusRows(fixed, theme, width, expanded) });
			}
		}
		statuses.push(placeholders({
			case: c,
			expected: expectedModel ? `${expectedModel.provider}/${expectedModel.id}` : null,
			report: normalizeReport(report),
			full: status.formatRecipeStatus({ ...report, capturedAt: "@@TIME@@" }),
			summary: status.formatRecipeStatus({ ...report, capturedAt: "@@TIME@@" }, "summary"),
			json: JSON.stringify({ ...report, capturedAt: "@@TIME@@" }, null, 2),
			rows,
		}));
	}
	modeAccess.setPermissionModeAccess(undefined);
	styleAccess.setStyleAccess(undefined);

	// The command surfaces in every mode: entry, notification, or stderr.
	const statusCommands: Json[] = [];
	const statusArgs: Array<[string, string]> = [["recipe", "status"], ["recipe", "status --json"], ["recipe-status", ""], ["recipe-status", "--json"], ["recipe-status", "--bad"]];
	for (const mode of ["tui", "rpc", "json", "print"]) {
		for (const [command, args] of statusArgs) {
			reset();
			apply.resetRecipeRuntimeForTests();
			state.cwd = join(root, "empty");
			state.mode = mode;
			state.hasUI = mode === "tui" || mode === "rpc";
			state.model = { provider: "anthropic", id: "claude-x", api: "anthropic-messages" };
			state.thinking = "high";
			await commands.get(command)!.handler(args, ctx());
			const scrub = (text: string) => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "@@TIME@@");
			statusCommands.push(placeholders({
				mode, command, args,
				entries: state.entries.map((entry: any) => ({ customType: entry.customType, data: normalizeReport(entry.data) })),
				notes: state.notes.map((note) => ({ ...note, message: scrub(note.message) })),
				stderr: state.stderr.map(scrub),
			}));
		}
	}
	// A recipe literally named "status" (or init/trust/untrust) keeps switching.
	const reservedFile = join(root, "reserved", "aio-recipes.json");
	mkdirSync(join(root, "reserved"), { recursive: true });
	writeFileSync(reservedFile, JSON.stringify({ recipes: { status: { description: "s" }, init: {}, trust: {}, untrust: {} } }));
	useRecipes(reservedFile);
	const reservedRuns: Json[] = [];
	for (const args of ["status", "init", "trust", "untrust", "status --json"]) {
		reset();
		apply.resetRecipeRuntimeForTests();
		state.mode = "tui";
		state.hasUI = true;
		await commands.get("recipe")!.handler(args, ctx());
		const scrub = (text: string) => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "@@TIME@@");
		reservedRuns.push(placeholders({ args, notes: state.notes.map((note) => ({ ...note, message: scrub(note.message) })), entries: state.entries.map((entry: any) => entry.customType) }));
	}
	useRecipes(agentRecipes);

	// ---- the session trust question (session_start, reason "startup") ----
	type TrustCase = { name: string; hasUI: boolean; select?: string; asked?: boolean; reason?: string; content?: string };
	// No session-scoped keys: the activation notice is the bare "active" line.
	const directoryText = JSON.stringify({ defaultRecipe: "dir", recipes: { dir: { description: "d" }, other: { model: "x/y" } } });
	useRecipes(join(root, "notemplates", "aio-recipes.json"));
	const trustCases: TrustCase[] = [
		{ name: "trust", hasUI: true, select: "Trust this recipe file" },
		{ name: "not now", hasUI: true, select: "Not now (ask again next start)" },
		{ name: "never", hasUI: true, select: "Never (until the file changes)" },
		{ name: "cancel", hasUI: true },
		{ name: "no ui", hasUI: false },
		{ name: "resume asks nothing", hasUI: true, reason: "resume", select: "Trust this recipe file" },
		{ name: "no default", hasUI: true, select: "Trust this recipe file", content: JSON.stringify({ recipes: { a: {} } }) },
	];
	const trustRuns: Json[] = [];
	for (const c of trustCases) {
		reset();
		apply.resetRecipeRuntimeForTests();
		const cwd = join(root, "trustq", c.name.replace(/ /g, "-"));
		mkdirSync(cwd, { recursive: true });
		const file = join(cwd, ".pi-recipe");
		writeFileSync(file, c.content ?? directoryText);
		state.cwd = cwd;
		state.hasUI = c.hasUI;
		state.mode = c.hasUI ? "rpc" : "json";
		state.selects = c.select ? [c.select] : [undefined];
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: c.reason ?? "startup" }, ctx());
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		trustRuns.push(placeholders({
			case: c,
			dialogs: state.dialogs,
			notes: state.notes,
			stderr: state.stderr,
			trust: trust.recipeFileTrust(file),
			active: apply.recipeRuntime().activeName ?? null,
			entries: state.entries,
		}));
	}

	useRecipes(agentRecipes);

	// ---- --no-approve ----
	const noApproveFile = join(root, "project", ".pi-recipe");
	const noApprove = [[], ["--no-approve"], ["-na"], ["--approve"], ["--no-approve", "--approve"], ["--approve", "--no-approve"]].map((argv) => ({
		argv,
		trust: trust.recipeFileTrust(noApproveFile, { cliArgs: argv }),
	}));

	// ---- launch decisions inside pig ----
	const launchRecipes = {
		plain: { name: "plain", source: "global", baseDir: root, config: { mcpServers: {}, model: "a/b" } },
		scoped: { name: "scoped", source: "global", baseDir: root, config: { mcpServers: {}, models: ["openai/*"] } },
		exts: { name: "exts", source: "global", baseDir: root, config: { mcpServers: {}, extensions: ["npm:x", "./y.ts"] } },
		both: { name: "both", source: "global", baseDir: root, config: { mcpServers: {}, extensions: ["bare"], models: ["m"] } },
		aioOnly: { name: "aioOnly", source: "global", baseDir: root, config: { mcpServers: {}, extensions: ["aio"] } },
	};
	const pigEnv = { AI_AGENT: "pig", PIG_HARNESS_BINARY: "/bin/pig" };
	const envs: Array<[string, Record<string, string>]> = [
		["pig", pigEnv],
		["launcher", { ...pigEnv, AIO_PIG_LAUNCHER: "1" }],
		["stage", { ...pigEnv, AIO_RECIPE_STAGE: "1" }],
		["child", { ...pigEnv, AIO_SUBAGENT_CHILD: "1" }],
		["pi", { AI_AGENT: "pi", PIG_HARNESS_BINARY: "/bin/pig" }],
		["blank binary", { AI_AGENT: "pig", PIG_HARNESS_BINARY: "  " }],
	];
	const argvs: string[][] = [
		[], ["--recipe", "plain"], ["--recipe", "scoped"], ["--recipe=exts"], ["--recipe", "both"], ["--recipe", "aioOnly"],
		["--recipe", "nope"], ["--recipe"], ["--recipe", " "], ["--recipe", "both", "-e", "x.ts"], ["--recipe", "both", "-ne"],
		["--recipe", "both", "--models", "a"], ["--recipe", "both", "--models", "a", "-e", "y"], ["--recipe", "scoped", "--models", ""],
		["install", "--recipe", "both"], ["-x", "install"], ["--recipe", "both", "--help"], ["--recipe", "both", "--list-models"],
		["--recipe", "both", "--export", "f"], ["--recipe", "both", "-r"], ["--recipe", "both", "--version"], ["-c"], ["--session", "f.jsonl"],
		["--fork", "x"], ["--resume"],
	];
	const launches: Json[] = [];
	for (const [envName, env] of envs) {
		for (const argv of argvs) {
			for (const directory of [undefined, "both", "plain"]) {
				for (const continued of [undefined, { name: "scoped", file: "/s.jsonl" }]) {
					if (continued && directory) continue;
					const decision = trampoline.decideRelaunch({
						argv: ["node", "pi", ...argv], command: "/bin/node", env: { ...env }, recipes: launchRecipes,
						directoryRecipe: directory, continuedRecipe: continued, aioExtensionPath: "/aio", disabledBuiltins: [],
					});
					launches.push({
						env: envName, argv, directory: directory ?? null, continued: continued ?? null,
						action: decision.action, reason: decision.reason ?? null, name: decision.name ?? decision.spec?.recipeName ?? null, note: decision.note ?? null,
					});
				}
			}
		}
	}

	process.chdir(savedCwd);
	useRecipes(agentRecipes);
	const counts = `${suggest.length} suggestions, ${initArgs.length} init parses, ${scaffolds.length} scaffolds, ${inits.length} init runs, ${statuses.length} status reports, ${statusCommands.length + reservedRuns.length} status commands, ${trustRuns.length} trust questions, ${launches.length} launch decisions`;
	return {
		golden: {
			suggest, initArgs, scaffolds: placeholders(scaffolds), inits, statuses, statusCommands, reservedRuns, trustRuns, noApprove,
			launches: placeholders(launches),
		},
		counts,
	};
}
