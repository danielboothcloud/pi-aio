/**
 * Plain-text mutation previews for permission prompts.
 * Computes diffs from tool input before execution.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { type ApplyPatchChange, previewApplyPatch } from "./apply-patch.js";
import {
	getEditOperations,
	resolveApplyPatchChanges,
} from "./cursor-compat.js";
import { type ParsedDiff, parseDiff } from "./diff.js";
import { replace } from "./replace.js";

const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_CHARS = 2_000;

/**
 * Optional caps for mutation previews. The default caps keep the legacy
 * `ctx.ui.select` approval prompt small; the scrollable approval overlay passes
 * large values so it can show the whole diff.
 */
export interface MutationPreviewOptions {
	maxLines?: number;
	maxChars?: number;
}

export function formatParsedDiffPlain(
	diff: ParsedDiff,
	maxLines = MAX_PREVIEW_LINES,
): string {
	const lines: string[] = [];
	let shown = 0;
	let total = 0;

	for (const line of diff.lines) {
		if (line.type === "sep") continue;
		total++;
		if (shown >= maxLines) continue;
		const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		lines.push(`${prefix} ${line.content}`);
		shown++;
	}

	if (total > shown) {
		lines.push(`… ${total - shown} more lines`);
	}

	return lines.join("\n");
}

function truncatePreview(text: string, maxChars = MAX_PREVIEW_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… (preview truncated)`;
}

function previewEditInput(
	input: Record<string, unknown>,
	opts: MutationPreviewOptions = {},
): string | undefined {
	const filePath =
		typeof input.path === "string"
			? input.path
			: typeof input.file_path === "string"
				? input.file_path
				: "";
	const operations = getEditOperations(input);
	if (!filePath || operations.length === 0) return undefined;

	if (!existsSync(filePath)) {
		return `(file not found: ${filePath})`;
	}

	let content = readFileSync(filePath, "utf8");
	const original = content;

	for (const op of operations) {
		const result = replace(content, op.oldText, op.newText);
		if (!result.changed) {
			return `(could not preview: oldText not found in ${basename(filePath)})`;
		}
		content = result.content;
	}

	if (content === original) return "(no changes)";
	const diff = parseDiff(original, content);
	const body = formatParsedDiffPlain(diff, opts.maxLines ?? MAX_PREVIEW_LINES);
	return body ? truncatePreview(body, opts.maxChars) : "(no diff)";
}

function previewApplyPatchInput(
	input: Record<string, unknown>,
	opts: MutationPreviewOptions = {},
): Promise<string | undefined> {
	const changes = resolveApplyPatchChanges(input);
	if (changes.length === 0) return Promise.resolve(undefined);
	return formatApplyPatchPreview(changes, opts);
}

async function formatApplyPatchPreview(
	changes: ApplyPatchChange[],
	opts: MutationPreviewOptions = {},
): Promise<string | undefined> {
	const maxLines = opts.maxLines ?? MAX_PREVIEW_LINES;
	const result = await previewApplyPatch(changes);
	if (!result.ok) {
		const first = result.errors[0];
		return first
			? `(could not preview: ${first.error})`
			: "(could not preview patch)";
	}

	const blocks: string[] = [];
	for (const change of result.applied) {
		const label = basename(change.path);
		switch (change.action) {
			case "add": {
				const content = change.newContent ?? "";
				const lines = content.split("\n");
				const previewLines = lines
					.slice(0, maxLines)
					.map((line) => `+ ${line}`);
				if (lines.length > maxLines) {
					previewLines.push(`… ${lines.length - maxLines} more lines`);
				}
				blocks.push(`--- ${label} (new file) ---\n${previewLines.join("\n")}`);
				break;
			}
			case "delete": {
				const content = change.oldContent ?? "";
				const diff = parseDiff(content, "");
				const body = formatParsedDiffPlain(diff, maxLines);
				blocks.push(`--- ${label} (delete) ---\n${body || "(empty file)"}`);
				break;
			}
			case "move": {
				blocks.push(
					`--- ${label} ---\nmove ${change.path} -> ${change.movePath ?? "?"}`,
				);
				break;
			}
			case "update": {
				const diff = parseDiff(
					change.oldContent ?? "",
					change.newContent ?? "",
				);
				const body = formatParsedDiffPlain(diff, maxLines);
				blocks.push(`--- ${label} ---\n${body || "(no diff)"}`);
				break;
			}
		}
	}

	if (blocks.length === 0) return undefined;
	return truncatePreview(blocks.join("\n\n"), opts.maxChars);
}

export async function formatMutationPreview(
	tool: string,
	input: Record<string, unknown>,
	opts: MutationPreviewOptions = {},
): Promise<string | undefined> {
	if (tool === "edit") return previewEditInput(input, opts);
	if (tool === "apply_patch") return previewApplyPatchInput(input, opts);
	return undefined;
}

export function buildMutationApprovalPrompt(
	tool: string,
	target: string,
	preview: string | undefined,
): string {
	const header = `Allow ${tool} on ${target}?`;
	if (!preview) return header;
	return `${header}\n\n${preview}`;
}
