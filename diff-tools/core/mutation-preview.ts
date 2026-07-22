/**
 * Plain-text mutation previews for permission prompts.
 * Computes diffs from tool input before execution.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	type ApplyPatchChange,
	previewApplyPatch,
} from "./apply-patch.js";
import { type ParsedDiff, parseDiff } from "./diff.js";
import { replace } from "./replace.js";

const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_CHARS = 2_000;

type EditOperation = { oldText: string; newText: string };

function getEditOperations(
	input: Record<string, unknown>,
): EditOperation[] {
	if (Array.isArray(input.edits)) {
		return input.edits
			.map((edit) => {
				if (typeof edit !== "object" || edit === null) return null;
				const record = edit as Record<string, unknown>;
				const oldText =
					typeof record.oldText === "string"
						? record.oldText
						: typeof record.old_text === "string"
							? record.old_text
							: "";
				const newText =
					typeof record.newText === "string"
						? record.newText
						: typeof record.new_text === "string"
							? record.new_text
							: "";
				return oldText && oldText !== newText ? { oldText, newText } : null;
			})
			.filter((edit): edit is EditOperation => edit !== null);
	}

	const oldText =
		typeof input.oldText === "string"
			? input.oldText
			: typeof input.old_text === "string"
				? input.old_text
				: "";
	const newText =
		typeof input.newText === "string"
			? input.newText
			: typeof input.new_text === "string"
				? input.new_text
				: "";
	return oldText && oldText !== newText ? [{ oldText, newText }] : [];
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
		const prefix =
			line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		lines.push(`${prefix} ${line.content}`);
		shown++;
	}

	if (total > shown) {
		lines.push(`… ${total - shown} more lines`);
	}

	return lines.join("\n");
}

function truncatePreview(text: string): string {
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	return `${text.slice(0, MAX_PREVIEW_CHARS)}\n… (preview truncated)`;
}

function previewEditInput(input: Record<string, unknown>): string | undefined {
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
	const body = formatParsedDiffPlain(diff);
	return body ? truncatePreview(body) : "(no diff)";
}

function previewApplyPatchInput(
	input: Record<string, unknown>,
): Promise<string | undefined> {
	if (!Array.isArray(input.changes) || input.changes.length === 0) {
		return Promise.resolve(undefined);
	}

	const changes: ApplyPatchChange[] = input.changes.flatMap((change) => {
		if (typeof change !== "object" || change === null) return [];
		const record = change as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.action !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				action: record.action as ApplyPatchChange["action"],
				content: typeof record.content === "string" ? record.content : undefined,
				oldText: typeof record.oldText === "string" ? record.oldText : undefined,
				newText: typeof record.newText === "string" ? record.newText : undefined,
				movePath:
					typeof record.movePath === "string" ? record.movePath : undefined,
			},
		];
	});

	if (changes.length === 0) return Promise.resolve(undefined);
	return formatApplyPatchPreview(changes);
}

async function formatApplyPatchPreview(
	changes: ApplyPatchChange[],
): Promise<string | undefined> {
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
					.slice(0, MAX_PREVIEW_LINES)
					.map((line) => `+ ${line}`);
				if (lines.length > MAX_PREVIEW_LINES) {
					previewLines.push(`… ${lines.length - MAX_PREVIEW_LINES} more lines`);
				}
				blocks.push(`--- ${label} (new file) ---\n${previewLines.join("\n")}`);
				break;
			}
			case "delete": {
				const content = change.oldContent ?? "";
				const diff = parseDiff(content, "");
				const body = formatParsedDiffPlain(diff);
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
				const body = formatParsedDiffPlain(diff);
				blocks.push(`--- ${label} ---\n${body || "(no diff)"}`);
				break;
			}
		}
	}

	if (blocks.length === 0) return undefined;
	return truncatePreview(blocks.join("\n\n"));
}

export async function formatMutationPreview(
	tool: string,
	input: Record<string, unknown>,
): Promise<string | undefined> {
	if (tool === "edit") return previewEditInput(input);
	if (tool === "apply_patch") return previewApplyPatchInput(input);
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
