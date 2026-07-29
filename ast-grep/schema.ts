import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const AstGrepToolParameters = Type.Object({
	command: Type.Optional(StringEnum(["run", "scan"] as const)),
	pattern: Type.Optional(
		Type.String({
			description:
				"ast-grep pattern for command=run, for example: console.log($A)",
		}),
	),
	kind: Type.Optional(
		Type.String({
			description:
				"AST node kind for command=run, for example: call_expression. Use instead of pattern.",
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				"Optional ast-grep language, for example ts, tsx, js, python, rust, go.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Files or directories to search. Defaults to ['.']. A leading @ is stripped.",
			minItems: 1,
		}),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional ast-grep --globs include/exclude patterns. Repeat entries are passed separately.",
		}),
	),
	config: Type.Optional(
		Type.String({
			description:
				"Optional sgconfig.yml path, passed as --config before the command.",
		}),
	),
	rule: Type.Optional(
		Type.String({
			description:
				"Rule file path for command=scan, passed as --rule. A leading @ is stripped.",
		}),
	),
	inlineRules: Type.Optional(
		Type.String({
			description:
				"Inline ast-grep rule YAML for command=scan, passed as --inline-rules.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Optional selector AST kind for command=run.",
		}),
	),
	strictness: Type.Optional(
		StringEnum(["cst", "smart", "ast", "relaxed", "signature"] as const),
	),
	context: Type.Optional(
		Type.Integer({
			description:
				"Context lines around each run-mode match. Mutually exclusive with before/after.",
			minimum: 0,
			maximum: 20,
		}),
	),
	before: Type.Optional(
		Type.Integer({
			description: "Lines before each run-mode match.",
			minimum: 0,
			maximum: 20,
		}),
	),
	after: Type.Optional(
		Type.Integer({
			description: "Lines after each run-mode match.",
			minimum: 0,
			maximum: 20,
		}),
	),
	json: Type.Optional(StringEnum(["compact", "stream"] as const)),
	maxResults: Type.Optional(
		Type.Integer({
			description:
				"Maximum number of matches included in the LLM-visible summary. Defaults to 200.",
			minimum: 0,
			maximum: 1000,
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Subprocess timeout in milliseconds. Defaults to 30000.",
			minimum: 1000,
			maximum: 300000,
		}),
	),
	includeRaw: Type.Optional(
		Type.Boolean({
			description:
				"Append raw ast-grep JSON to the result. Defaults to false; output is still truncated.",
		}),
	),
});

export type AstGrepToolInput = Static<typeof AstGrepToolParameters>;

export interface NormalizedAstGrepInput {
	command: "run" | "scan";
	pattern?: string;
	kind?: string;
	language?: string;
	paths: string[];
	globs: string[];
	config?: string;
	rule?: string;
	inlineRules?: string;
	selector?: string;
	strictness?: "cst" | "smart" | "ast" | "relaxed" | "signature";
	context?: number;
	before?: number;
	after?: number;
	json: "compact" | "stream";
	maxResults: number;
	timeoutMs: number;
	includeRaw: boolean;
}

function cleanOptionalString(
	value: string | undefined,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} must not be empty when provided.`);
	return trimmed;
}

function cleanPathLike(
	value: string | undefined,
	field: string,
): string | undefined {
	const cleaned = cleanOptionalString(value, field);
	if (cleaned === undefined) return undefined;
	const stripped = cleaned.startsWith("@") ? cleaned.slice(1).trim() : cleaned;
	if (!stripped)
		throw new Error(`${field} must not be empty after stripping a leading @.`);
	return stripped;
}

function cleanPaths(paths: string[] | undefined): string[] {
	if (!paths || paths.length === 0) return ["."];
	return paths.map(
		(path, index) => cleanPathLike(path, `paths[${index}]`) ?? ".",
	);
}

function cleanGlobs(globs: string[] | undefined): string[] {
	if (!globs) return [];
	return globs.map(
		(glob, index) => cleanOptionalString(glob, `globs[${index}]`)!,
	);
}

export function normalizeAstGrepInput(
	params: AstGrepToolInput,
): NormalizedAstGrepInput {
	const command = params.command ?? "run";
	const pattern = cleanOptionalString(params.pattern, "pattern");
	const kind = cleanOptionalString(params.kind, "kind");
	const language = cleanOptionalString(params.language, "language");
	const selector = cleanOptionalString(params.selector, "selector");
	const config = cleanPathLike(params.config, "config");
	const rule = cleanPathLike(params.rule, "rule");
	const inlineRules = cleanOptionalString(params.inlineRules, "inlineRules");

	if (command === "run") {
		if (!pattern && !kind) {
			throw new Error("command=run requires either pattern or kind.");
		}
		if (pattern && kind) {
			throw new Error("command=run accepts pattern or kind, not both.");
		}
		if (rule || inlineRules) {
			throw new Error("rule and inlineRules are only valid with command=scan.");
		}
	} else {
		if (
			pattern ||
			kind ||
			language ||
			selector ||
			params.strictness ||
			params.context !== undefined ||
			params.before !== undefined ||
			params.after !== undefined
		) {
			throw new Error(
				"pattern, kind, language, selector, strictness, context, before, and after are only valid with command=run.",
			);
		}
	}

	if (
		params.context !== undefined &&
		(params.before !== undefined || params.after !== undefined)
	) {
		throw new Error("context is mutually exclusive with before/after.");
	}

	return {
		command,
		pattern,
		kind,
		language,
		paths: cleanPaths(params.paths),
		globs: cleanGlobs(params.globs),
		config,
		rule,
		inlineRules,
		selector,
		strictness: params.strictness,
		context: params.context,
		before: params.before,
		after: params.after,
		json: params.json ?? "compact",
		maxResults: params.maxResults ?? 200,
		timeoutMs: params.timeoutMs ?? 30_000,
		includeRaw: params.includeRaw ?? false,
	};
}
