/**
 * Cursor IDE tool schema compatibility.
 *
 * Composer often sends Cursor-native argument shapes (old_string/new_string,
 * unified-diff patch strings) to Pi bridge tools. Normalize those to Pi shapes
 * before validation, preview, and execution.
 */

import type { ApplyPatchChange } from "./apply-patch.js";

export type EditOperation = { oldText: string; newText: string };

const OLD_KEYS = ["oldText", "old_text", "old_string"] as const;
const NEW_KEYS = ["newText", "new_text", "new_string"] as const;

function readEditField(
	record: Record<string, unknown>,
	kind: "old" | "new",
): string {
	const keys = kind === "old" ? OLD_KEYS : NEW_KEYS;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return "";
}

function isEditOperation(op: EditOperation): boolean {
	return op.oldText.length > 0 && op.oldText !== op.newText;
}

/** Extract edit replacements from Pi or Cursor edit tool arguments. */
export function getEditOperations(
	input: Record<string, unknown>,
): EditOperation[] {
	if (Array.isArray(input.edits)) {
		return input.edits
			.map((edit) => {
				if (typeof edit !== "object" || edit === null) return null;
				const record = edit as Record<string, unknown>;
				const oldText = readEditField(record, "old");
				const newText = readEditField(record, "new");
				return isEditOperation({ oldText, newText }) ? { oldText, newText } : null;
			})
			.filter((edit): edit is EditOperation => edit !== null);
	}

	const oldText = readEditField(input, "old");
	const newText = readEditField(input, "new");
	return isEditOperation({ oldText, newText }) ? [{ oldText, newText }] : [];
}

/** Convert Cursor edit args to Pi-native shape for SDK fallback and guards. */
export function normalizeEditParams(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const operations = getEditOperations(input);
	if (operations.length === 0) return input;

	const normalized: Record<string, unknown> = { ...input };

	if (Array.isArray(input.edits)) {
		normalized.edits = input.edits.map((edit) => {
			if (typeof edit !== "object" || edit === null) return edit;
			const record = edit as Record<string, unknown>;
			return {
				...record,
				oldText: readEditField(record, "old"),
				newText: readEditField(record, "new"),
			};
		});
	} else {
		normalized.oldText = operations[0].oldText;
		normalized.newText = operations[0].newText;
		normalized.edits = operations;
	}

	return normalized;
}

interface ParsedPatchHunk {
	lines: Array<{ type: "add" | "del" | "ctx"; content: string }>;
}

interface ParsedPatchFile {
	path: string;
	status: "added" | "deleted" | "modified";
	hunks: ParsedPatchHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function normalizeDiffPath(path: string): string | null {
	if (path === "/dev/null") return null;
	return path.replace(/^[ab]\//, "");
}

function hunkToEditTexts(hunk: ParsedPatchHunk): EditOperation {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of hunk.lines) {
		if (line.type === "ctx") {
			oldLines.push(line.content);
			newLines.push(line.content);
		} else if (line.type === "del") {
			oldLines.push(line.content);
		} else if (line.type === "add") {
			newLines.push(line.content);
		}
	}
	return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function parseUnifiedPatch(patch: string): ParsedPatchFile[] {
	const files: ParsedPatchFile[] = [];
	let current: ParsedPatchFile | null = null;
	let currentHunk: ParsedPatchHunk | null = null;

	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
			const path = match?.[2] ?? match?.[1] ?? "unknown";
			current = { path, status: "modified", hunks: [] };
			files.push(current);
			currentHunk = null;
			continue;
		}

		if (line.startsWith("new file mode")) {
			if (current) current.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			if (current) current.status = "deleted";
			continue;
		}

		if (line.startsWith("--- ")) {
			const oldPath = normalizeDiffPath(line.slice(4).trim());
			if (!current) {
				current = {
					path: oldPath ?? "unknown",
					status: oldPath === null ? "added" : "modified",
					hunks: [],
				};
				files.push(current);
			}
			if (oldPath === null) current.status = "added";
			else if (current.path === "unknown") current.path = oldPath;
			currentHunk = null;
			continue;
		}

		if (line.startsWith("+++ ")) {
			const newPath = normalizeDiffPath(line.slice(4).trim());
			if (!current) {
				current = {
					path: newPath ?? "unknown",
					status: newPath === null ? "deleted" : "modified",
					hunks: [],
				};
				files.push(current);
			}
			if (newPath === null) current.status = "deleted";
			else current.path = newPath;
			currentHunk = null;
			continue;
		}

		if (!current) continue;

		if (HUNK_RE.test(line)) {
			currentHunk = { lines: [] };
			current.hunks.push(currentHunk);
			continue;
		}

		if (!currentHunk || line === "\\ No newline at end of file") continue;

		const prefix = line[0];
		const content = line.slice(1);
		if (prefix === "+") {
			currentHunk.lines.push({ type: "add", content });
		} else if (prefix === "-") {
			currentHunk.lines.push({ type: "del", content });
		} else if (prefix === " ") {
			currentHunk.lines.push({ type: "ctx", content });
		}
	}

	return files;
}

function normalizeApplyPatchChange(change: unknown): ApplyPatchChange | null {
	if (typeof change !== "object" || change === null) return null;
	const record = change as Record<string, unknown>;
	if (typeof record.path !== "string" || typeof record.action !== "string") {
		return null;
	}

	return {
		path: record.path,
		action: record.action as ApplyPatchChange["action"],
		content: typeof record.content === "string" ? record.content : undefined,
		oldText: readEditField(record, "old") || undefined,
		newText: readEditField(record, "new") || undefined,
		movePath:
			typeof record.movePath === "string"
				? record.movePath
				: typeof record.move_path === "string"
					? record.move_path
					: undefined,
	};
}

function patchToChanges(patch: string): ApplyPatchChange[] {
	const changes: ApplyPatchChange[] = [];

	for (const file of parseUnifiedPatch(patch)) {
		if (file.status === "added") {
			const content = file.hunks
				.flatMap((hunk) => hunk.lines.filter((line) => line.type === "add"))
				.map((line) => line.content)
				.join("\n");
			changes.push({ path: file.path, action: "add", content });
			continue;
		}

		if (file.status === "deleted") {
			changes.push({ path: file.path, action: "delete" });
			continue;
		}

		for (const hunk of file.hunks) {
			const { oldText, newText } = hunkToEditTexts(hunk);
			if (isEditOperation({ oldText, newText })) {
				changes.push({
					path: file.path,
					action: "update",
					oldText,
					newText,
				});
			}
		}
	}

	return changes;
}

/** Resolve Pi or Cursor apply_patch arguments to structured changes. */
export function resolveApplyPatchChanges(
	params: Record<string, unknown>,
): ApplyPatchChange[] {
	if (Array.isArray(params.changes) && params.changes.length > 0) {
		return params.changes
			.map((change) => normalizeApplyPatchChange(change))
			.filter((change): change is ApplyPatchChange => change !== null);
	}

	if (typeof params.patch === "string" && params.patch.trim()) {
		return patchToChanges(params.patch);
	}

	return [];
}
