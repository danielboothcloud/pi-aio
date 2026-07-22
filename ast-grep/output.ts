import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateLine,
	withFileMutationQueue,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { NormalizedAstGrepInput } from "./schema.js";
import type { ProcessResult } from "./cli.js";

export interface AstGrepRangePoint {
	line: number;
	column: number;
	index?: number;
}

export interface AstGrepMatch {
	text?: string;
	file?: string;
	language?: string;
	lines?: string;
	range?: {
		start?: AstGrepRangePoint;
		end?: AstGrepRangePoint;
		byteOffset?: { start: number; end: number };
	};
	metaVariables?: {
		single?: Record<string, { text?: string }>;
		multi?: Record<string, Array<{ text?: string }>>;
	};
	ruleId?: string;
	severity?: string;
	message?: string;
	note?: string | null;
	[key: string]: unknown;
}

export interface AstGrepDetails {
	command: "run" | "scan";
	argv: string[];
	cwd: string;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
	resultCount: number;
	shownCount: number;
	jsonMode: "compact" | "stream";
	stderr?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	timedOut: boolean;
	aborted: boolean;
}

export function parseAstGrepJson(
	stdout: string,
	mode: "compact" | "stream",
): AstGrepMatch[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	if (mode === "stream") {
		const results: AstGrepMatch[] = [];
		for (const line of trimmed.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				results.push(...normalizeParsedJson(JSON.parse(line)));
			} catch (error) {
				throw new Error(
					`ast-grep stream JSON line could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return results;
	}

	try {
		return normalizeParsedJson(JSON.parse(trimmed));
	} catch (error) {
		throw new Error(
			`ast-grep compact JSON output could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function normalizeParsedJson(parsed: unknown): AstGrepMatch[] {
	if (Array.isArray(parsed)) return parsed as AstGrepMatch[];
	if (parsed && typeof parsed === "object") return [parsed as AstGrepMatch];
	throw new Error("ast-grep JSON output was not an object or array.");
}

function oneLine(value: string | undefined, maxBytes = 240): string {
	if (!value) return "";
	const compact = value.replace(/\s+/g, " ").trim();
	return truncateLine(compact, maxBytes).text;
}

function formatLocation(match: AstGrepMatch): string {
	const file = match.file ?? "<unknown>";
	const start = match.range?.start;
	if (!start) return file;
	return `${file}:${start.line + 1}:${start.column + 1}`;
}

function formatMetaVariables(match: AstGrepMatch): string[] {
	const lines: string[] = [];
	const single = match.metaVariables?.single ?? {};
	const names = Object.keys(single).sort().slice(0, 5);
	if (names.length === 0) return lines;
	const rendered = names.map(
		(name) => `$${name}=${oneLine(single[name]?.text, 120)}`,
	);
	const more =
		Object.keys(single).length > names.length
			? `, +${Object.keys(single).length - names.length} more`
			: "";
	lines.push(`   metavars: ${rendered.join(", ")}${more}`);
	return lines;
}

export function formatMatchSummary(
	input: NormalizedAstGrepInput,
	matches: AstGrepMatch[],
): { text: string; shownCount: number } {
	const maxResults = Math.max(0, input.maxResults);
	const shown = matches.slice(0, maxResults);
	const lines: string[] = [];
	const omitted = Math.max(0, matches.length - shown.length);

	lines.push(
		`ast_grep ${input.command} found ${matches.length} match${matches.length === 1 ? "" : "es"}.`,
	);
	if (shown.length > 0) {
		lines.push(
			`Showing ${shown.length}${omitted ? `; ${omitted} omitted by maxResults=${maxResults}` : ""}.`,
		);
	}

	for (let index = 0; index < shown.length; index += 1) {
		const match = shown[index]!;
		const rule = match.ruleId
			? ` [${match.ruleId}${match.severity ? `/${match.severity}` : ""}]`
			: "";
		const language = match.language ? ` (${match.language})` : "";
		lines.push(`${index + 1}. ${formatLocation(match)}${language}${rule}`);
		if (match.message) lines.push(`   message: ${oneLine(match.message, 240)}`);
		const code = oneLine(match.lines ?? match.text, 260);
		if (code) lines.push(`   code: ${code}`);
		lines.push(...formatMetaVariables(match));
	}

	return { text: lines.join("\n"), shownCount: shown.length };
}

function truncateDiagnostic(text: string | undefined): string | undefined {
	if (!text?.trim()) return undefined;
	const truncation = truncateHead(text.trim(), {
		maxBytes: 8 * 1024,
		maxLines: 200,
	});
	return truncation.truncated
		? `${truncation.content}\n[stderr truncated]`
		: truncation.content;
}

async function writeTempOutput(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-ast-grep-"));
	const file = join(dir, "output.txt");
	await withFileMutationQueue(file, async () => {
		await writeFile(file, text, "utf8");
	});
	return file;
}

export async function buildAstGrepToolResult(
	input: NormalizedAstGrepInput,
	argv: string[],
	processResult: ProcessResult,
	matches: AstGrepMatch[],
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: AstGrepDetails;
}> {
	const summary = formatMatchSummary(input, matches);
	let fullText = summary.text;
	if (input.includeRaw) {
		fullText += `\n\nRaw ast-grep JSON:\n${processResult.stdout.trim() || "[]"}`;
	}

	const truncation = truncateHead(fullText, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	let resultText = truncation.content;
	const details: AstGrepDetails = {
		command: input.command,
		argv,
		cwd: processResult.cwd,
		exitCode: processResult.code,
		exitSignal: processResult.signal,
		resultCount: matches.length,
		shownCount: summary.shownCount,
		jsonMode: input.json,
		stderr: truncateDiagnostic(processResult.stderr),
		timedOut: processResult.timedOut,
		aborted: processResult.aborted,
	};

	if (truncation.truncated) {
		const fullOutputPath = await writeTempOutput(fullText);
		details.truncation = truncation;
		details.fullOutputPath = fullOutputPath;
		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` Full output saved to: ${fullOutputPath}]`;
	}

	return {
		content: [{ type: "text", text: resultText }],
		details,
	};
}

export function shouldTreatExitCodeAsSuccess(
	processResult: ProcessResult,
	matches: AstGrepMatch[],
): boolean {
	if (processResult.timedOut || processResult.aborted) return false;
	if (processResult.code === 0) return true;
	// ast-grep exits 1 for successful searches with no matches.
	// compact JSON emits []; stream JSON emits an empty stdout. Real errors normally include stderr.
	const stdout = processResult.stdout.trim();
	if (
		processResult.code === 1 &&
		matches.length === 0 &&
		!processResult.stderr.trim() &&
		(stdout === "[]" || stdout === "")
	)
		return true;
	return false;
}

export function buildCliFailureMessage(processResult: ProcessResult): string {
	if (processResult.aborted) return "ast-grep was cancelled.";
	if (processResult.timedOut) return "ast-grep timed out.";
	const stderr = truncateDiagnostic(processResult.stderr) ?? "<empty stderr>";
	const stdout = truncateDiagnostic(processResult.stdout) ?? "<empty stdout>";
	return `ast-grep failed with exit code ${processResult.code ?? "null"}${processResult.signal ? ` (${processResult.signal})` : ""}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`;
}
