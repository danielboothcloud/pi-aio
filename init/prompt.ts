export type InitOptions = {
	cwd: string;
	args?: string;
};

export function buildInitPrompt({ cwd, args }: InitOptions): string {
	const trimmedArgs = (args ?? "").trim();
	const force = /\b(force|refresh|--force)\b/i.test(trimmedArgs);
	const dryRun = /\b(dry-run|preview|--dry-run)\b/i.test(trimmedArgs);

	const modeLines = [
		dryRun
			? "- **Dry run**: analyze the project and show the AGENTS.md you would write. Do not create or modify files."
			: "- **Write mode**: create or update AGENTS.md on disk.",
		force
			? "- **Force refresh**: regenerate even if AGENTS.md already exists; preserve accurate sections where possible."
			: "- **Update in place**: if AGENTS.md exists, merge improvements into it instead of replacing wholesale.",
	].join("\n");

	return `Analyze this codebase and ${dryRun ? "draft" : "create or update"} AGENTS.md for Pi and other coding agents.

Project root: ${cwd}
${trimmedArgs ? `User args: ${trimmedArgs}\n` : ""}
## Goal

Pi loads AGENTS.md (and CLAUDE.md) from parent directories and the current directory at startup. Produce a concise project guide agents cannot reliably infer from code alone.

## Mode

${modeLines}

## What to detect

Inspect the repo (read-only first) to identify:
- Languages and major frameworks
- Build systems and package managers
- Test frameworks and how to run tests, lint, typecheck, and build
- CI/CD (GitHub Actions, GitLab CI, etc.)
- Directory layout and architectural boundaries that matter for changes
- Existing AGENTS.md / CLAUDE.md content to preserve or refine

Look for manifests and configs such as package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, justfile, docker-compose.yml, and .github/workflows.

## What belongs in AGENTS.md

Include only high-value, non-discoverable guidance:
- Exact commands for dev, build, test, lint, and deploy
- Code style or conventions that differ from language defaults
- Testing expectations and preferred runners
- Repo etiquette (branch naming, PR expectations) when visible
- Architectural decisions, module boundaries, and integration points
- Environment quirks, required env vars, and common gotchas

Exclude noise agents can read from the tree:
- Generic "write clean code" advice
- File-by-file directory inventories
- Duplicated API docs (link out instead)
- Framework tutorials or defaults the model already knows

Keep it short and scannable. Prefer bullets and command blocks over prose.

## Propagation

- Write the primary AGENTS.md at the project root (${cwd}).
- If the repo is a monorepo with distinct subprojects (separate package.json, Cargo.toml, pyproject.toml, etc.), create or update AGENTS.md in each subproject root that needs its own stack-specific guidance.
- Do not create nested AGENTS.md files for folders that share the same stack and commands as the root.

## Output format

Use this structure when it fits; omit empty sections:

\`\`\`markdown
# Project name

One-line purpose.

## Commands

- \`npm test\` — ...

## Stack

- ...

## Conventions

- ...

## Architecture

- ...

## Testing

- ...

## Gotchas

- ...
\`\`\`

## Finish

${dryRun ? "Show the proposed AGENTS.md in your response and list any subproject files you would also create." : "Write the file(s), summarize what changed, and remind the user to run `/reload` so Pi loads the new context."}`;
}
