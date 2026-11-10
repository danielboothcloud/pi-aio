// ---------------------------------------------------------------------------
// Stand-in for `@earendil-works/pi-coding-agent` inside the aio-pig launcher.
//
// The launcher runs before `pig` starts, where Pi's package is not installed.
// bin/aio-pig.mjs loads the recipe modules through jiti with this file
// aliased as `@earendil-works/pi-coding-agent`, so recipes/trampoline.ts,
// config.ts, trust.ts and continue.ts run unchanged. Only the exports that
// launch-time code uses exist here; a missing export is a launcher bug and
// `pig-launch.test.ts` loads the real module graph through this alias.
//
// Directories follow PiG, not Pi (docs: config.md, environment-variables.md):
//   default mode: root = $PIG_HOME | $XDG_CONFIG_HOME/pig | ~/.pig,
//                 agent dir = $PIG_CODING_AGENT_DIR | <root>/agent,
//                 project dir name `.pig`
//   shared mode (PIG_USE_PI_DIRS=1): agent dir = $PI_CODING_AGENT_DIR |
//                 ~/.pi/agent, project dir name `.pi`
// Session lookup mirrors Pi's SessionManager (same file format, which PiG
// shares): the leaf is the last non-header entry, and --continue picks the
// newest `.jsonl` by mtime.
// ---------------------------------------------------------------------------

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export { parseArgs } from "./args.js";

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function resolvePath(path: string): string {
	return resolve(expandHome(path));
}

/** True when PiG shares Pi's directories (`PIG_USE_PI_DIRS=1`). */
export function pigSharedMode(env: Env = process.env): boolean {
	return env.PIG_USE_PI_DIRS === "1";
}

/** PiG's configuration root in default mode. */
export function pigConfigRoot(env: Env = process.env): string {
	const home = nonEmpty(env.PIG_HOME);
	if (home) return resolvePath(home);
	const xdg = nonEmpty(env.XDG_CONFIG_HOME);
	if (xdg) return join(resolvePath(xdg), "pig");
	return join(homedir(), ".pig");
}

/** PiG's agent directory, which holds settings, sessions, and AIO's recipe files. */
export function pigAgentDir(env: Env = process.env): string {
	if (pigSharedMode(env)) {
		const pi = nonEmpty(env.PI_CODING_AGENT_DIR);
		return pi ? resolvePath(pi) : join(homedir(), ".pi", "agent");
	}
	const own = nonEmpty(env.PIG_CODING_AGENT_DIR);
	return own ? resolvePath(own) : join(pigConfigRoot(env), "agent");
}

/** The session-directory env var PiG honors in the current mode. */
export function pigSessionDirEnv(env: Env = process.env): string | undefined {
	return nonEmpty(pigSharedMode(env) ? env.PI_CODING_AGENT_SESSION_DIR : env.PIG_CODING_AGENT_SESSION_DIR);
}

export function getAgentDir(): string {
	return pigAgentDir(process.env);
}

/** Project config directory name (`.pig`, or `.pi` in shared mode). Fixed at load, like Pi's. */
export const CONFIG_DIR_NAME = pigSharedMode(process.env) ? ".pi" : ".pig";

// -- sessions -----------------------------------------------------------------

interface SessionEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	cwd?: unknown;
}

function defaultSessionDir(cwd: string): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvePath(getAgentDir()), "sessions", safePath);
}

function parseLine(line: string): SessionEntry | null {
	if (!line.trim()) return null;
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as SessionEntry) : null;
	} catch {
		return null;
	}
}

const HEADER_SCAN_BYTES = 1024 * 1024;

/** The session header (first parsed line), or null when the file is not a session. */
function readHeader(path: string): SessionEntry | null {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
			const read = readSync(fd, buffer, 0, buffer.length, 0);
			for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				const entry = parseLine(line);
				if (!entry) continue;
				return entry.type === "session" && typeof entry.id === "string" ? entry : null;
			}
			return null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

function headerCwd(header: SessionEntry): string | undefined {
	return typeof header.cwd === "string" ? header.cwd : undefined;
}

function cwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

interface SessionFileInfo {
	path: string;
	id: string;
	cwd: string | undefined;
	mtime: number;
}

function scan(dir: string): SessionFileInfo[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const infos: SessionFileInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		const header = readHeader(path);
		if (!header || typeof header.id !== "string") continue;
		let mtime = 0;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		infos.push({ path, id: header.id, cwd: headerCwd(header), mtime });
	}
	return infos.sort((a, b) => b.mtime - a.mtime);
}

/** Pi's rule: a custom session dir that is not cwd's default dir is filtered by header cwd. */
function lookup(cwd: string, sessionDir: string | undefined): { dir: string; keep: (info: SessionFileInfo) => boolean } {
	const dir = sessionDir ? resolvePath(sessionDir) : defaultSessionDir(cwd);
	const filter = sessionDir !== undefined && dir !== defaultSessionDir(cwd);
	const resolvedCwd = resolvePath(cwd);
	return { dir, keep: (info) => !filter || cwdMatches(info.cwd, resolvedCwd) };
}

function loadEntries(path: string): SessionEntry[] {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		const entry = parseLine(line);
		if (entry) entries.push(entry);
	}
	const header = entries[0];
	return header?.type === "session" && typeof header.id === "string" ? entries : [];
}

/** The read-only slice of Pi's SessionManager that launch-time recipe lookup uses. */
export class SessionManager {
	private constructor(
		private readonly cwd: string,
		private readonly file: string | undefined,
	) {}

	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const { dir, keep } = lookup(cwd, sessionDir);
		const recent = scan(dir).find(keep);
		return new SessionManager(cwd, recent?.path);
	}

	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const { dir, keep } = lookup(cwd, sessionDir);
		return scan(dir).find((info) => info.id === id && keep(info))?.path;
	}

	static async list(cwd: string, sessionDir?: string): Promise<Array<{ id: string; path: string; cwd: string }>> {
		const { dir, keep } = lookup(cwd, sessionDir);
		return scan(dir)
			.filter(keep)
			.map((info) => ({ id: info.id, path: info.path, cwd: info.cwd ?? "" }));
	}

	static open(path: string, _sessionDir?: string): SessionManager {
		const resolved = resolvePath(path);
		const header = existsSync(resolved) ? readHeader(resolved) : null;
		return new SessionManager((header && headerCwd(header)) ?? process.cwd(), resolved);
	}

	getSessionFile(): string | undefined {
		return this.file;
	}

	getCwd(): string {
		return this.cwd;
	}

	/** Root-to-leaf path; the leaf is the last non-header entry, as in Pi. */
	getBranch(): SessionEntry[] {
		if (!this.file) return [];
		const entries = loadEntries(this.file).filter((entry) => entry.type !== "session");
		const byId = new Map<string, SessionEntry>();
		for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
		const path: SessionEntry[] = [];
		const seen = new Set<string>();
		let current = entries[entries.length - 1];
		while (current) {
			path.push(current);
			if (typeof current.id === "string") seen.add(current.id);
			const parent = current.parentId ? byId.get(current.parentId) : undefined;
			if (!parent || (typeof parent.id === "string" && seen.has(parent.id))) break;
			current = parent;
		}
		return path.reverse();
	}
}

/** The slice of Pi's SettingsManager the launcher uses: the global `sessionDir`. */
export class SettingsManager {
	private constructor(private readonly sessionDir: string | undefined) {}

	static create(_cwd?: string): SettingsManager {
		try {
			const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { sessionDir?: unknown };
			const dir = typeof settings.sessionDir === "string" ? nonEmpty(settings.sessionDir) : undefined;
			return new SettingsManager(dir ? resolvePath(dir) : undefined);
		} catch {
			return new SettingsManager(undefined);
		}
	}

	getSessionDir(): string | undefined {
		return this.sessionDir;
	}
}
