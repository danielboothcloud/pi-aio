import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const AIO_EXTENSION_PATH = fileURLToPath(
	new URL("../index.ts", import.meta.url),
);

function parseExtraExtensionPaths(): string[] {
	const raw = process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS?.trim();
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function resolveCursorExtensionPath(): string | undefined {
	const fromEnv = process.env.AIO_SUBAGENT_CURSOR_EXTENSION?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const candidates = [
		join(
			homedir(),
			".config",
			"pi",
			"npm",
			"node_modules",
			"pi-cursor-sdk",
			"src",
			"index.ts",
		),
		join(
			homedir(),
			".config",
			"pi",
			"npm",
			"node_modules",
			"pi-cursor-sdk",
			"dist",
			"index.js",
		),
	];
	try {
		candidates.push(
			join(
				dirname(getAgentDir()),
				"npm",
				"node_modules",
				"pi-cursor-sdk",
				"src",
				"index.ts",
			),
		);
	} catch {
		// getAgentDir() can fail in unusual test harnesses.
	}
	return candidates.find((candidate) => existsSync(candidate));
}

export function resolveChildExtensionPaths(input: {
	modelProvider?: string;
}): string[] {
	const paths = [AIO_EXTENSION_PATH];
	if (input.modelProvider === "cursor") {
		const cursorExtension = resolveCursorExtensionPath();
		if (cursorExtension) paths.push(cursorExtension);
	}
	for (const extra of parseExtraExtensionPaths()) {
		if (existsSync(extra) && !paths.includes(extra)) paths.push(extra);
	}
	return paths;
}

export function childSupportsModel(
	extensionPaths: string[],
	model?: string,
): boolean {
	if (!model?.startsWith("cursor/")) return true;
	const cursorExtension = resolveCursorExtensionPath();
	return !!cursorExtension && extensionPaths.includes(cursorExtension);
}
