// Mutation-tool classification and affected-path extraction: which tools can
// mutate files, and what paths a write/edit/apply_patch/bash call touched.
// Ported from pi-yaml-hooks (MIT); Pi write/edit input shapes added.

import type { FileChange } from "./types.js";

const DIRECT_MUTATION_TOOL_NAMES = ["write", "edit", "multiedit"] as const;
const PATCH_MUTATION_TOOL_NAMES = ["patch", "apply_patch"] as const;
const BASH_TOOL_NAME = "bash" as const;

export const MUTATION_TOOL_NAMES = new Set<string>([
	...DIRECT_MUTATION_TOOL_NAMES,
	...PATCH_MUTATION_TOOL_NAMES,
	BASH_TOOL_NAME,
]);

export type NormalizedMutationToolName = "write" | "edit" | "multiedit" | "apply_patch" | "bash";

export function normalizeMutationToolName(toolName: string): NormalizedMutationToolName | undefined {
	if ((DIRECT_MUTATION_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return toolName as NormalizedMutationToolName;
	}
	if ((PATCH_MUTATION_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return "apply_patch";
	}
	if (toolName === BASH_TOOL_NAME) {
		return "bash";
	}
	return undefined;
}

/** Hook-event names for a mutation tool, deduped across patch aliases. */
export function getMutationToolHookNames(toolName: string): string[] {
	const normalized = normalizeMutationToolName(toolName);
	if (!normalized) {
		return [];
	}
	if (normalized === "apply_patch") {
		return ["patch", "apply_patch"];
	}
	return [normalized];
}

export function getToolAffectedPaths(toolName: string, args: Record<string, unknown>): string[] {
	return getChangedPaths(getToolFileChanges(toolName, args));
}

export function getToolFileChanges(toolName: string, args: Record<string, unknown>): FileChange[] {
	const normalized = normalizeMutationToolName(toolName);
	if (!normalized) {
		return [];
	}

	if (normalized === "apply_patch") {
		const patchText = pickString(args.patchText, args.patch, args.diff, args.input);
		return patchText ? parsePatchChanges(patchText) : [];
	}

	if (normalized === "bash") {
		const command = pickString(args.command, args.cmd);
		return command ? parseBashChanges(command) : [];
	}

	// Pi MultiEdit-style inputs carry `edits`; each entry may override the
	// top-level path. aio's multi-file apply_patch changes are handled above.
	if (normalized === "multiedit" || normalized === "edit") {
		const fromArray = extractEditsArrayChanges(args);
		if (fromArray.length > 0) {
			return fromArray;
		}
	}

	const directChange = extractDirectMutationChange(args);
	if (directChange) {
		return [directChange];
	}

	return [];
}

export function getChangedPaths(changes: readonly FileChange[]): string[] {
	const paths = new Set<string>();
	for (const change of changes) {
		if (change.operation === "rename") {
			if (change.fromPath) {
				paths.add(change.fromPath);
			}
			if (change.toPath) {
				paths.add(change.toPath);
			}
			continue;
		}
		if (change.path) {
			paths.add(change.path);
		}
	}
	return Array.from(paths);
}

function pickString(...values: unknown[]): string | undefined {
	const value = values.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
	return typeof value === "string" ? value : undefined;
}

function extractEditsArrayChanges(args: Record<string, unknown>): FileChange[] {
	const editsRaw = args.edits;
	if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
		return [];
	}

	const topLevelPath = pickString(args.filePath, args.file_path, args.path, args.file);

	// Top-level path is the canonical target; each edit may override it.
	// Edits without their own path all map to the canonical target, so
	// identical consecutive changes are deduped (an N-edit multi-edit of one
	// file is one file.changed modify, not N duplicates).
	const changes: FileChange[] = [];
	const seen = new Set<string>();
	for (const edit of editsRaw) {
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
			continue;
		}
		const change = extractDirectMutationChange(edit as Record<string, unknown>, topLevelPath);
		if (!change) {
			continue;
		}
		const key = change.operation === "rename"
			? `rename:${change.fromPath}->${change.toPath}`
			: `${change.operation}:${change.path}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		changes.push(change);
	}
	return changes;
}

function extractDirectMutationChange(
	args: Record<string, unknown>,
	fallbackPath?: string,
): FileChange | undefined {
	const filePath = pickString(args.filePath, args.file_path, args.path, args.file) ?? fallbackPath;
	if (!filePath) {
		return undefined;
	}

	const sourcePath = pickString(args.sourcePath, args.fromPath);
	const destinationPath = pickString(args.move, args.rename, args.toPath);
	if (sourcePath && sourcePath !== filePath) {
		return { operation: "rename", fromPath: sourcePath, toPath: filePath };
	}
	if (destinationPath && destinationPath !== filePath) {
		return { operation: "rename", fromPath: filePath, toPath: destinationPath };
	}

	const operation = pickString(args.op, args.operation);
	if (operation === "create" || operation === "delete") {
		return { operation, path: filePath };
	}

	return { operation: "modify", path: filePath };
}

/** Parse OpenCode-style apply-patch payloads. */
function parsePatchChanges(patchText: string): FileChange[] {
	const changes: FileChange[] = [];
	let pendingUpdatePath: string | undefined;

	const flushPendingModify = (): void => {
		if (!pendingUpdatePath) {
			return;
		}
		changes.push({ operation: "modify", path: pendingUpdatePath });
		pendingUpdatePath = undefined;
	};

	for (const line of patchText.split("\n")) {
		const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
		if (addMatch?.[1]) {
			flushPendingModify();
			changes.push({ operation: "create", path: addMatch[1].trim() });
			continue;
		}

		const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
		if (deleteMatch?.[1]) {
			flushPendingModify();
			changes.push({ operation: "delete", path: deleteMatch[1].trim() });
			continue;
		}

		const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
		if (updateMatch?.[1]) {
			flushPendingModify();
			pendingUpdatePath = updateMatch[1].trim();
			continue;
		}

		const renameMatch = line.match(/^\*\*\* Move to: (.+)$/);
		if (renameMatch?.[1] && pendingUpdatePath) {
			changes.push({ operation: "rename", fromPath: pendingUpdatePath, toPath: renameMatch[1].trim() });
			pendingUpdatePath = undefined;
		}
	}

	flushPendingModify();
	return changes;
}

/**
 * Extract affected paths from a bash command. Recognized mutation-shaped
 * commands: rm/git rm, mv/git mv, cp/git cp, touch, mkdir. Commands are
 * split on && / || / ; then shell-tokenized.
 */
export function parseBashChanges(command: string): FileChange[] {
	const changes: FileChange[] = [];

	for (const segment of splitBashCommands(command)) {
		const tokens = shellTokenize(segment);
		if (tokens.length === 0) {
			continue;
		}

		const cmd = tokens[0];

		if (cmd === "rm" || (cmd === "git" && tokens[1] === "rm")) {
			const paths = extractPathArgs(tokens, cmd === "git" ? 2 : 1);
			for (const p of paths) {
				changes.push({ operation: "delete", path: p });
			}
			continue;
		}

		if (cmd === "mv" || (cmd === "git" && tokens[1] === "mv")) {
			const paths = extractPathArgs(tokens, cmd === "git" ? 2 : 1);
			if (paths.length >= 2) {
				const dest = paths[paths.length - 1];
				for (const src of paths.slice(0, -1)) {
					changes.push({ operation: "rename", fromPath: src, toPath: dest });
				}
			}
			continue;
		}

		if (cmd === "cp" || (cmd === "git" && tokens[1] === "cp")) {
			const paths = extractPathArgs(tokens, cmd === "git" ? 2 : 1);
			if (paths.length >= 2) {
				changes.push({ operation: "create", path: paths[paths.length - 1] });
			}
			continue;
		}

		if (cmd === "touch") {
			const paths = extractPathArgs(tokens, 1);
			for (const p of paths) {
				changes.push({ operation: "create", path: p });
			}
			continue;
		}

		if (cmd === "mkdir") {
			const paths = extractPathArgs(tokens, 1);
			for (const p of paths) {
				changes.push({ operation: "create", path: p });
			}
			continue;
		}
	}

	return changes;
}

function splitBashCommands(command: string): string[] {
	return command.split(/\s*(?:&&|\|\||;)\s*/);
}

function shellTokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (const ch of segment) {
		if (escape) {
			current += ch;
			escape = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escape = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(ch) && !inSingle && !inDouble) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

/**
 * Extract positional path arguments from a tokenized shell segment, skipping
 * flags. POSIX `--` is honoured: every token after it is positional.
 */
function extractPathArgs(tokens: string[], startIndex: number): string[] {
	const paths: string[] = [];
	let positionalOnly = false;
	for (let i = startIndex; i < tokens.length; i++) {
		const token = tokens[i];
		if (positionalOnly) {
			paths.push(token);
			continue;
		}
		if (token === "--") {
			positionalOnly = true;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		paths.push(token);
	}
	return paths;
}
