import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { NotificationCategory } from "./protocol.js";

export interface NotificationSettings {
	enabled: boolean;
	focusSkip: boolean;
	minSeconds: number;
	sound: string;
	preview: boolean;
	categories: Record<NotificationCategory, boolean>;
}

export function defaultSettings(): NotificationSettings {
	return { enabled: true, focusSkip: true, minSeconds: 0, sound: "off", preview: false, categories: { core: true, goal: true, background: true, critical: true } };
}

export function settingsPath(): string {
	return process.env.AIO_NOTIFY_SETTINGS_FILE?.trim() || join(getAgentDir(), "aio-notifications.settings.json");
}

export function normalizeSettings(value: unknown): NotificationSettings {
	const result = defaultSettings();
	if (!value || typeof value !== "object" || Array.isArray(value)) return result;
	const data = value as Record<string, unknown>;
	for (const key of ["enabled", "focusSkip", "preview"] as const) {
		if (typeof data[key] === "boolean") result[key] = data[key];
	}
	if (typeof data.minSeconds === "number" && Number.isFinite(data.minSeconds) && data.minSeconds >= 0 && data.minSeconds <= 86400) result.minSeconds = data.minSeconds;
	if (typeof data.sound === "string" && /^[\w -]{1,64}$/.test(data.sound)) result.sound = data.sound;
	if (data.categories && typeof data.categories === "object") {
		for (const key of Object.keys(result.categories) as NotificationCategory[]) {
			const enabled = (data.categories as Record<string, unknown>)[key];
			if (typeof enabled === "boolean") result.categories[key] = enabled;
		}
	}
	return result;
}

export function loadSettings(): NotificationSettings {
	try { return normalizeSettings(JSON.parse(readFileSync(settingsPath(), "utf8"))); }
	catch { return defaultSettings(); }
}

export function saveSettings(settings: NotificationSettings): void {
	const file = settingsPath();
	mkdirSync(dirname(file), { recursive: true });
	const staging = `${file}.${process.pid}.tmp`;
	writeFileSync(staging, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
	renameSync(staging, file);
}
