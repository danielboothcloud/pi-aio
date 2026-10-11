/**
 * Trimmed git probe for the AIO frame — adapted from pi-zentui's git.ts
 * (MIT, see UPSTREAM.md). Only branch/dirty/ahead/behind are collected; the
 * Minimalist frame renders nothing else.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 2_000;

export type GitFrameStatus = {
	branch?: string;
	dirty: boolean;
	ahead: number;
	behind: number;
};

export type GitFrameReadResult =
	| { kind: "ok"; status: GitFrameStatus }
	| { kind: "not_a_repo" }
	| { kind: "error" };

export function emptyGitFrameStatus(): GitFrameStatus {
	return { branch: undefined, dirty: false, ahead: 0, behind: 0 };
}

export function parseGitFrameStatus(stdoutText: string): GitFrameStatus {
	const status = emptyGitFrameStatus();
	for (const line of stdoutText.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const branch = line.slice("# branch.head ".length).trim();
			status.branch = branch === "(detached)" || !branch ? undefined : branch;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				status.ahead = Number(match[1] ?? 0);
				status.behind = Number(match[2] ?? 0);
			}
			continue;
		}
		if (line.startsWith("#")) continue;
		status.dirty = true;
	}
	return status;
}

function isNotARepoError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /not a git repository|outside repository|not a git repo/i.test(message);
}

export async function readGitFrameStatus(cwd: string): Promise<GitFrameReadResult> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain=2", "--branch"], {
			cwd,
			timeout: GIT_COMMAND_TIMEOUT_MS,
		});
		return { kind: "ok", status: parseGitFrameStatus(String(stdout)) };
	} catch (error) {
		if (isNotARepoError(error)) return { kind: "not_a_repo" };
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			});
			return String(stdout).trim() === "true" ? { kind: "error" } : { kind: "not_a_repo" };
		} catch (inner) {
			return isNotARepoError(inner) ? { kind: "not_a_repo" } : { kind: "error" };
		}
	}
}
