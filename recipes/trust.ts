// ---------------------------------------------------------------------------
// recipes/trust — explicit, remembered trust for `.pi-recipe` files.
//
// A `.pi-recipe` chooses the model, MCP servers, and extensions pi launches
// with, so it is never trusted implicitly — not even in a folder pi already
// trusts. Each file version must be approved once, explicitly:
//
//   * decisions live in <agentDir>/aio-recipe-trust.json (AIO_RECIPE_TRUST_FILE
//     overrides it for tests and sandboxes), keyed by the file's real path
//     and pinned to a SHA-256 of its contents;
//   * a new file, or an edited one (hash mismatch), is "unknown" and asks
//     again — like direnv, a `git pull` can never silently change a launch;
//   * "never" is remembered for that exact content too, so a declined file
//     does not nag on every start; `--no-approve` skips it for one run.
//
// The interactive `pi` launch asks in the terminal before extension loading
// finishes (promptRecipeTrust), so a trusted restart-scoped recipe can still
// relaunch pi. RPC sessions ask through ctx.ui at session_start instead.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";

export const RECIPE_TRUST_FILE_NAME = "aio-recipe-trust.json";
/** Replaces the trust store path (tests + sandboxes). */
export const RECIPE_TRUST_FILE_ENV = "AIO_RECIPE_TRUST_FILE";

/** `unknown` = new or changed since the last decision: ask. */
export type RecipeFileTrust = "trusted" | "denied" | "unknown";
export type TrustChoice = "trust" | "skip" | "deny";

interface TrustEntry {
	sha256: string;
	trusted: boolean;
	decidedAt: string;
}

interface TrustData {
	version: 1;
	files: Record<string, TrustEntry>;
}

export function recipeTrustStorePath(): string | undefined {
	const override = process.env[RECIPE_TRUST_FILE_ENV]?.trim();
	if (override) return override;
	try {
		return join(getAgentDir(), RECIPE_TRUST_FILE_NAME);
	} catch {
		return undefined;
	}
}

function fileKey(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return resolve(file);
	}
}

export function hashRecipeFile(file: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}

function readStore(path: string): TrustData {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TrustData> | null;
		const files = parsed?.files;
		if (typeof files !== "object" || files === null) return { version: 1, files: {} };
		return { version: 1, files: files as Record<string, TrustEntry> };
	} catch {
		// Missing or corrupt store = no decisions; never a throw.
		return { version: 1, files: {} };
	}
}

function writeStore(path: string, data: TrustData): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, path);
}

/** Trust state of one recipe file version. `--no-approve` skips it ("denied"). */
export function recipeFileTrust(
	file: string,
	options: { cliArgs?: string[]; storePath?: string } = {},
): RecipeFileTrust {
	if (parseArgs(options.cliArgs ?? []).projectTrustOverride === false) return "denied";
	const store = options.storePath ?? recipeTrustStorePath();
	const hash = hashRecipeFile(file);
	if (!store || !hash) return "unknown";
	const entry = readStore(store).files[fileKey(file)];
	if (!entry || entry.sha256 !== hash) return "unknown";
	return entry.trusted ? "trusted" : "denied";
}

/** Remember a decision for the file's CURRENT contents. */
export function recordRecipeFileTrust(
	file: string,
	trusted: boolean,
	options: { storePath?: string } = {},
): void {
	const store = options.storePath ?? recipeTrustStorePath();
	if (!store) throw new Error("agent directory is unavailable");
	const hash = hashRecipeFile(file);
	if (!hash) throw new Error(`cannot read ${file}`);
	const data = readStore(store);
	data.files[fileKey(file)] = { sha256: hash, trusted, decidedAt: new Date().toISOString() };
	writeStore(store, data);
}

/** Forget any decision for the file (it asks again next launch). */
export function forgetRecipeFileTrust(file: string, options: { storePath?: string } = {}): boolean {
	const store = options.storePath ?? recipeTrustStorePath();
	if (!store) return false;
	const data = readStore(store);
	const key = fileKey(file);
	if (!data.files[key]) return false;
	delete data.files[key];
	writeStore(store, data);
	return true;
}

// -- what is being trusted -----------------------------------------------------

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
}

/** Human summary of a recipe file, shown in every trust prompt. */
export function describeRecipeFile(file: string): string[] {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return ["(not valid JSON — it will be ignored until fixed)"];
	}
	if (typeof raw !== "object" || raw === null) return ["(not a JSON object — it will be ignored)"];
	const config = raw as { defaultRecipe?: unknown; recipes?: unknown };
	const recipes =
		typeof config.recipes === "object" && config.recipes !== null
			? (config.recipes as Record<string, Record<string, unknown> | null>)
			: {};
	const lines: string[] = [];
	if (typeof config.defaultRecipe === "string" && config.defaultRecipe.trim()) {
		const name = config.defaultRecipe.trim();
		lines.push(`default recipe: ${name}${recipes[name] ? "" : " (not defined in this file — ignored)"}`);
	} else {
		lines.push("default recipe: none");
	}
	for (const [name, entry] of Object.entries(recipes)) {
		if (typeof entry !== "object" || entry === null) continue;
		const bits: string[] = [];
		if (typeof entry.model === "string" && entry.model.trim()) bits.push(`model ${entry.model.trim()}`);
		const models = list(entry.models);
		if (models.length) bits.push(`models ${models.join(", ")}`);
		const extensions = list(entry.extensions);
		if (extensions.length) bits.push(`extensions ${extensions.join(", ")}`);
		const mcp = typeof entry.mcpServers === "object" && entry.mcpServers ? Object.keys(entry.mcpServers) : [];
		if (mcp.length) bits.push(`MCP ${mcp.join(", ")}`);
		const tools = list(entry.tools);
		if (tools.length) bits.push(`tools ${tools.join(" ")}`);
		if (typeof entry.instructions === "string" && entry.instructions.trim()) bits.push("instructions");
		const resources = [...list(entry.skills), ...list(entry.prompts), ...list(entry.themes)];
		if (resources.length) bits.push(`${resources.length} resource path(s)`);
		lines.push(`${name}: ${bits.length ? bits.join(" · ") : "no settings"}`);
	}
	return lines;
}

// -- prompts -------------------------------------------------------------------

export const TRUST_CHOICE_LABELS: Record<TrustChoice, string> = {
	trust: "Trust this recipe file",
	skip: "Not now (ask again next start)",
	deny: "Never (until the file changes)",
};

export function trustPromptTitle(file: string): string {
	return [
		"Trust this recipe file?",
		file,
		...describeRecipeFile(file).map((line) => `  ${line}`),
		"It can choose the model, MCP servers, and extensions pi starts with.",
	].join("\n");
}

export function parseTrustAnswer(answer: string | undefined): TrustChoice {
	const value = (answer ?? "").trim().toLowerCase();
	if (["y", "yes", "t", "trust"].includes(value)) return "trust";
	if (["d", "deny", "never", "v"].includes(value)) return "deny";
	return "skip";
}

export interface TerminalPromptIO {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
}

/**
 * One-line terminal prompt for the interactive launch. Runs while extension
 * factories load — before pi starts its TUI — so plain line input is safe.
 * `terminal: false` leaves the tty in cooked mode; closing the interface
 * detaches its listeners and pauses stdin for the TUI to resume.
 */
export function promptRecipeTrust(
	file: string,
	io: TerminalPromptIO = { input: process.stdin, output: process.stderr },
): Promise<TrustChoice> {
	return new Promise((resolvePrompt) => {
		const rl = createInterface({ input: io.input, output: io.output, terminal: false });
		let settled = false;
		const finish = (choice: TrustChoice): void => {
			if (settled) return;
			settled = true;
			rl.close();
			resolvePrompt(choice);
		};
		io.output.write(
			`\n${trustPromptTitle(file)}\n[y] trust  [N] not now  [d] never (until it changes): `,
		);
		rl.once("line", (line) => finish(parseTrustAnswer(line)));
		rl.once("close", () => finish("skip"));
	});
}
