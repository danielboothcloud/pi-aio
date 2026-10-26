import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText, createNotificationBackend, type NotificationBackend } from "./backend.js";
import { AGENT_PROMPT_EVENT, GOAL_ACTIVITY_EVENT, NOTIFICATION_EVENT, type AgentPrompt, type NotificationCategory, type NotificationSignal } from "./protocol.js";
import { loadSettings, saveSettings, type NotificationSettings } from "./settings.js";

export interface NotificationDeps {
	backend?: NotificationBackend;
	load?: () => NotificationSettings;
	save?: (settings: NotificationSettings) => void;
	now?: () => number;
}

/** Desktop-only observer: owns no tools, gates, editor, or model messages. */
export function registerNotifications(pi: ExtensionAPI, deps: NotificationDeps = {}): void {
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;
	const backend = deps.backend ?? createNotificationBackend();
	const now = deps.now ?? Date.now;
	let settings = (deps.load ?? loadSettings)();
	let ctx: ExtensionContext | undefined;
	let sessionId = "";
	let epoch = 0;
	let running = false;
	let runVersion = 0;
	let startedAt = 0;
	let lastText = "";
	let lastStop = "";
	let suppressCompletion = false;
	let goalActivity: { sessionId: string; active: boolean } | undefined;
	const pending = new Set<AbortController>();
	const ownedPrompts = new Map<number, AgentPrompt>();
	const seen = new Set<string>();
	const subscriptions: Array<() => void> = [];

	function observe(name: string, listener: (data: unknown) => void): void {
		const unsubscribe = pi.events.on(name, listener);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	}

	function cancelPending(): void {
		for (const controller of pending) controller.abort();
		pending.clear();
	}

	function deliver(category: NotificationCategory, title: string, body: string, preview?: string, prompt?: number, force = false): void {
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!force && (!settings.enabled || !settings.categories[category])) return;
		const current = ctx;
		const version = epoch;
		const run = runVersion;
		const isSettlement = category === "core" && prompt === undefined && !force;
		const controller = new AbortController();
		pending.add(controller);
		const valid = () => !controller.signal.aborted && version === epoch && ctx === current
			&& current.sessionManager.getSessionId() === sessionId
			&& (prompt === undefined || ownedPrompts.has(prompt))
			&& (!isSettlement || (!running && run === runVersion))
			&& (force || (settings.enabled && settings.categories[category]));
		// Freeze plain display data before any asynchronous focus/backend probes.
		const notification = {
			title: `Pi · ${title}`,
			body: settings.preview && preview ? preview : body,
			subtitle: cleanText(pi.getSessionName() || basename(current.cwd), 80),
			group: `aio.${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.${prompt === undefined ? category : "prompt"}`,
			sound: settings.sound,
		};
		void (async () => {
			if (!force && settings.focusSkip && await backend.focused(controller.signal)) return;
			if (valid()) await backend.send(notification, controller.signal, valid);
		})().catch(() => { /* desktop failures never fail an agent turn */ })
			.finally(() => pending.delete(controller));
	}

	pi.on("session_start", (_event, context) => {
		cancelPending();
		epoch++;
		ctx = context;
		sessionId = context.sessionManager.getSessionId();
		settings = (deps.load ?? loadSettings)();
		running = false;
		suppressCompletion = false;
		ownedPrompts.clear();
		seen.clear();
	});
	pi.on("session_shutdown", () => {
		epoch++;
		cancelPending();
		ctx = undefined;
		running = false;
		goalActivity = undefined;
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		ownedPrompts.clear();
		seen.clear();
	});
	pi.on("agent_start", () => {
		if (!running) { startedAt = now(); runVersion++; }
		running = true;
		lastText = "";
		lastStop = "";
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		lastStop = event.message.stopReason;
		lastText = event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
	});
	pi.on("agent_settled", (event) => {
		const wasRunning = running;
		running = false;
		ownedPrompts.clear();
		const suppressed = suppressCompletion;
		suppressCompletion = false;
		if (!wasRunning || suppressed || event.aborted || lastStop === "aborted") return;
		if (goalActivity?.sessionId === sessionId && goalActivity.active) return;
		if (lastStop === "error") {
			deliver("core", "Run failed", "The agent stopped with an error and needs your attention.", lastText);
		} else if (now() - startedAt >= settings.minSeconds * 1000) {
			deliver("core", "Finished", "The agent has finished and is ready for input.", lastText);
		}
	});

	observe(AGENT_PROMPT_EVENT, (data) => {
		const prompt = data as AgentPrompt & { active: boolean };
		if (prompt.sessionId !== sessionId) return;
		if (!prompt.active) { ownedPrompts.delete(prompt.id); return; }
		if (ownedPrompts.has(prompt.id)) return;
		ownedPrompts.set(prompt.id, prompt);
		// Host ui_prompt_start only fires at depth 0→1, so an agent prompt
		// over a user menu must notify from its explicit ownership signal.
		// Deferral lets immediately failed/closed dialogs retire their marker.
		queueMicrotask(() => {
			if (ownedPrompts.get(prompt.id) === prompt) {
				deliver("core", prompt.title, prompt.body, prompt.preview, prompt.id);
			}
		});
	});
	observe(GOAL_ACTIVITY_EVENT, (data) => {
		const activity = data as { sessionId: string; active: boolean; quietSettle?: boolean };
		if (ctx && activity.sessionId !== sessionId) return;
		goalActivity = activity;
		if (activity.sessionId === sessionId && activity.quietSettle && running) suppressCompletion = true;
	});
	observe(NOTIFICATION_EVENT, (data) => {
		const signal = data as NotificationSignal;
		if (!ctx || signal.sessionId !== sessionId || !settings.enabled || !settings.categories[signal.category]) return;
		const key = `${signal.category}:${signal.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		const oldest = seen.values().next().value;
		if (seen.size > 100 && oldest !== undefined) seen.delete(oldest);
		if (signal.replacesCompletion) suppressCompletion = true;
		deliver(signal.category, signal.title, signal.body, signal.preview);
	});

	pi.registerCommand("notify", {
		description: "Desktop notifications: on/off, focus, min, sound, preview, events, test, status",
		handler: async (args, context) => {
			const [command = "status", value, flag, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (!command || command === "status") {
				context.ui.notify(`Notifications ${settings.enabled ? "on" : "off"} · ${backend.name()} · focus-skip=${settings.focusSkip} · min=${settings.minSeconds}s · sound=${settings.sound} · preview=${settings.preview} · events=${Object.entries(settings.categories).filter(([, on]) => on).map(([key]) => key).join(",")}`, "info");
				return;
			}
			if (command === "test") {
				if (context.mode !== "tui") { context.ui.notify("Desktop notification tests require TUI mode.", "warning"); return; }
				deliver("core", "Test", "AIO desktop notifications are working.", undefined, undefined, true);
				context.ui.notify("Notification test requested (bypasses focus and enabled settings).", "info");
				return;
			}
			const next = structuredClone(settings);
			let valid = extra.length === 0;
			if (["on", "off"].includes(command) && value === undefined) next.enabled = command === "on";
			else if (["focus", "preview"].includes(command) && ["on", "off"].includes(value) && flag === undefined) next[command === "focus" ? "focusSkip" : "preview"] = value === "on";
			else if (command === "min" && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 86400 && flag === undefined) next.minSeconds = Number(value);
			else if (command === "sound" && value && /^[\w-]{1,64}$/.test(value) && flag === undefined) next.sound = value;
			else if (command === "events" && Object.hasOwn(next.categories, value) && ["on", "off"].includes(flag)) next.categories[value as NotificationCategory] = flag === "on";
			else valid = false;
			if (!valid) {
				context.ui.notify("Usage: /notify [status|on|off|test|focus on/off|preview on/off|min <seconds>|sound <name/off>|events core/goal/background/critical on/off]", "warning");
				return;
			}
			try {
				(deps.save ?? saveSettings)(next);
				settings = next;
				cancelPending();
				context.ui.notify("Notification settings saved.", "info");
			} catch {
				context.ui.notify("Could not save notification settings; previous settings retained.", "warning");
			}
		},
	});
}
