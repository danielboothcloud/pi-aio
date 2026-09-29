import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The minimalist look is AIO's only supported Zentui presentation: the
 * editor embeds model/effort/context metadata, the footer is hidden (statuses
 * only), and user messages keep Pi's native presentation. This mirrors
 * pi-zentui's `minimalist` component preset.
 */
export const ZENTUI_MINIMALIST_SEED = {
	components: {
		editor: { enabled: true, style: "minimalist" },
		footer: { style: "hidden" },
		userMessages: { enabled: false, style: "framed" },
	},
} as const;

export type SeedResult = { seeded: boolean; path: string; reason?: string };

/**
 * Contract (see AGENTS.md): AIO seeds zentui.json exactly once — only when the
 * file is missing or completely empty. An existing file is never normalized,
 * rewritten, or merged; user edits always win.
 */
export function seedZentuiConfig(path: string): SeedResult {
	if (existsSync(path)) {
		try {
			if (readFileSync(path, "utf8").trim().length > 0) {
				return { seeded: false, path, reason: "existing" };
			}
		} catch {
			return { seeded: false, path, reason: "unreadable" };
		}
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(ZENTUI_MINIMALIST_SEED, null, 2)}\n`, "utf8");
		console.warn(`[aio-zentui] seeded minimalist defaults at ${path}`);
		return { seeded: true, path };
	} catch (error) {
		// Seeding is best-effort; Zentui's own defaults remain usable.
		console.error(
			`[aio-zentui] could not seed ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { seeded: false, path, reason: "error" };
	}
}
