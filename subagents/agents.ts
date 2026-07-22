import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import type { AgentConfig, SubagentThinking } from "./types.js";

const BUILTIN_AGENT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"agents",
);
const THINKING_LEVELS = new Set<SubagentThinking>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

interface AgentFrontmatter {
	name?: unknown;
	description?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	systemPromptMode?: unknown;
	inheritProjectContext?: unknown;
	inheritSkills?: unknown;
}

function readMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...readMarkdownFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
	}
	return files.sort((a, b) => a.localeCompare(b));
}

function parseFrontmatter(
	content: string,
	filePath: string,
): { frontmatter: AgentFrontmatter; body: string } {
	if (!content.startsWith("---\n")) {
		throw new Error(
			`Agent file '${filePath}' must start with YAML frontmatter.`,
		);
	}
	const end = content.indexOf("\n---", 4);
	if (end === -1)
		throw new Error(
			`Agent file '${filePath}' has unterminated YAML frontmatter.`,
		);
	const raw = content.slice(4, end);
	const parsed = parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Agent file '${filePath}' frontmatter must be an object.`);
	}
	return {
		frontmatter: parsed as AgentFrontmatter,
		body: content.slice(end + 4).trim(),
	};
}

function stringList(
	value: unknown,
	field: string,
	filePath: string,
): string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value.map((item) => item.trim()).filter(Boolean);
	}
	throw new Error(
		`Agent '${filePath}' field '${field}' must be a string or string array.`,
	);
}

function parseAgent(
	filePath: string,
	source: AgentConfig["source"],
): AgentConfig {
	const { frontmatter, body } = parseFrontmatter(
		readFileSync(filePath, "utf8"),
		filePath,
	);
	if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
		throw new Error(`Agent '${filePath}' requires a non-empty name.`);
	}
	if (
		typeof frontmatter.description !== "string" ||
		!frontmatter.description.trim()
	) {
		throw new Error(`Agent '${filePath}' requires a non-empty description.`);
	}
	if (!body)
		throw new Error(`Agent '${filePath}' requires a system prompt body.`);

	const thinking = frontmatter.thinking;
	if (
		thinking !== undefined &&
		(typeof thinking !== "string" ||
			!THINKING_LEVELS.has(thinking as SubagentThinking))
	) {
		throw new Error(`Agent '${filePath}' has an invalid thinking level.`);
	}
	const systemPromptMode = frontmatter.systemPromptMode ?? "replace";
	if (systemPromptMode !== "append" && systemPromptMode !== "replace") {
		throw new Error(
			`Agent '${filePath}' systemPromptMode must be 'append' or 'replace'.`,
		);
	}

	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		systemPrompt: body,
		systemPromptMode,
		inheritProjectContext: frontmatter.inheritProjectContext !== false,
		inheritSkills: frontmatter.inheritSkills === true,
		tools: stringList(frontmatter.tools, "tools", filePath),
		model:
			typeof frontmatter.model === "string" &&
			frontmatter.model.trim() &&
			frontmatter.model !== "inherit"
				? frontmatter.model.trim()
				: undefined,
		thinking: thinking as SubagentThinking | undefined,
		source,
		filePath,
	};
}

function loadDirectory(
	dir: string,
	source: AgentConfig["source"],
): AgentConfig[] {
	return readMarkdownFiles(dir).map((filePath) => parseAgent(filePath, source));
}

function projectAgentDirectories(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	while (true) {
		for (const candidate of [
			join(current, ".pi", "agents"),
			join(current, ".agents", "agents"),
		]) {
			if (existsSync(candidate)) dirs.push(candidate);
		}
		if (existsSync(join(current, ".git"))) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs.toReversed();
}

export function discoverAgents(
	cwd: string,
	options: { includeProject?: boolean } = {},
): AgentConfig[] {
	let agentDir: string;
	try {
		agentDir = getAgentDir();
	} catch {
		agentDir = join(homedir(), ".pi", "agent");
	}

	const merged = new Map<string, AgentConfig>();
	for (const agent of loadDirectory(BUILTIN_AGENT_DIR, "builtin"))
		merged.set(agent.name, agent);
	for (const agent of loadDirectory(join(agentDir, "agents"), "user"))
		merged.set(agent.name, agent);
	if (options.includeProject !== false) {
		for (const dir of projectAgentDirectories(cwd)) {
			for (const agent of loadDirectory(dir, "project"))
				merged.set(agent.name, agent);
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(agents: AgentConfig[], name: string): AgentConfig {
	const agent = agents.find((candidate) => candidate.name === name);
	if (!agent) {
		throw new Error(
			`Unknown agent '${name}'. Available agents: ${agents.map((candidate) => candidate.name).join(", ") || "none"}.`,
		);
	}
	return agent;
}
