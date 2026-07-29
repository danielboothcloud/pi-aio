import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Execute an RTK file/search command without involving a shell. */
export async function executeRtkTool(
	pi: ExtensionAPI,
	subcommand: "read" | "grep" | "find" | "ls",
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<ExecResult | undefined> {
	try {
		delete process.env.RTK_DISABLED;
		return await pi.exec("rtk", [subcommand, ...args], { cwd, signal });
	} catch {
		// Native fallback is allowed only when RTK itself cannot execute.
		return undefined;
	}
}

/** Keep tool output bounded after RTK has filtered it. */
export function truncateRtkOutput(
	text: string,
	maxLines = 2_000,
	maxBytes = 50 * 1024,
): string {
	const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
	const lines = normalized.split("\n");
	const kept: string[] = [];
	let bytes = 0;

	for (const line of lines) {
		if (kept.length >= maxLines) break;
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
		if (bytes + lineBytes > maxBytes) break;
		kept.push(line);
		bytes += lineBytes;
	}

	if (kept.length === lines.length) return normalized;
	return `${kept.join("\n")}\n\n[RTK output truncated: ${kept.length} of ${lines.length} lines]`;
}

export function requireRtkSuccess(
	subcommand: string,
	result: ExecResult,
	acceptedCodes: readonly number[] = [0],
): void {
	if (!result.killed && acceptedCodes.includes(result.code)) return;
	const detail = (result.stderr || result.stdout).trim();
	throw new Error(
		detail ||
			`rtk ${subcommand} ${result.killed ? "was cancelled" : `exited with code ${result.code}`}`,
	);
}

export function limitRtkLines(text: string, limit: number): string {
	const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
	return normalized.split("\n").slice(0, Math.max(0, limit)).join("\n");
}
