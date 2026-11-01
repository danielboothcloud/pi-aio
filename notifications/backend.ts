import { execFile } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export interface DesktopNotification {
	title: string;
	body: string;
	subtitle: string;
	group: string;
	sound: string;
}
export type Execute = (bin: string, args: string[], signal: AbortSignal) => Promise<string>;
export interface NotificationBackend {
	focused(signal: AbortSignal): Promise<boolean>;
	send(notification: DesktopNotification, signal: AbortSignal, valid: () => boolean): Promise<void>;
	name(): string;
}

const BUNDLES: Record<string, string> = {
	Apple_Terminal: "com.apple.Terminal", "iTerm.app": "com.googlecode.iterm2",
	ghostty: "com.mitchellh.ghostty", WezTerm: "com.github.wez.wezterm",
	vscode: "com.microsoft.VSCode", kitty: "net.kovidgoyal.kitty",
};

/** Strip terminal escapes AND protocol delimiters from untrusted model text. */
export function cleanText(text: string, max = 160): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const execute: Execute = (bin, args, signal) => new Promise((resolve, reject) => {
	execFile(bin, args, { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal }, (error, stdout) => {
		if (error) reject(error);
		else resolve(stdout);
	});
});

export function createNotificationBackend(options: {
	platform?: string;
	env?: NodeJS.ProcessEnv;
	execute?: Execute;
	write?: (text: string) => void;
} = {}): NotificationBackend {
	const env = options.env ?? process.env;
	const localMac = (options.platform ?? process.platform) === "darwin" && !env.SSH_CONNECTION && !env.SSH_TTY;
	const run = options.execute ?? execute;
	const write = options.write ?? ((text: string) => { process.stdout.write(text); });
	const candidate = env.__CFBundleIdentifier || BUNDLES[env.TERM_PROGRAM ?? ""];
	const bundle = candidate && /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(candidate) ? candidate : undefined;
	let native: boolean | undefined;
	const fallback = env.KITTY_WINDOW_ID ? "OSC 99" : "OSC 777";
	return {
		name: () => native === undefined && localMac ? "auto (terminal-notifier → terminal fallback)" : native ? "terminal-notifier" : fallback,
		async focused(signal) {
			if (!localMac || !bundle || signal.aborted) return false;
			try {
				return (await run("osascript", ["-e", 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'], signal)).trim() === bundle;
			} catch { return false; }
		},
		async send(notification, signal, valid) {
			if (!valid() || signal.aborted) return;
			if (localMac && native === undefined) {
				try { await run("terminal-notifier", ["-help"], signal); native = true; }
				catch { if (signal.aborted) return; native = false; }
			}
			if (!valid() || signal.aborted) return;
			const title = cleanText(notification.title, 100);
			const body = cleanText(notification.body);
			const subtitle = cleanText(notification.subtitle, 100);
			if (native) {
				const args = ["-title", title, "-subtitle", subtitle, "-message", ` ${body}`, "-group", notification.group];
				if (notification.sound !== "off") args.push("-sound", cleanText(notification.sound, 64));
				if (bundle) args.push("-activate", bundle);
				try { await run("terminal-notifier", args, signal); return; }
				catch { if (!valid() || signal.aborted) return; native = false; }
			}
			if (!valid() || signal.aborted) return;
			const message = cleanText(`${subtitle ? `${subtitle} — ` : ""}${body}`, 260);
			let sequence = env.KITTY_WINDOW_ID
				? `\x1b]99;i=aio:d=0;${title}\x1b\\\x1b]99;i=aio:p=body;${message}\x1b\\`
				: `\x1b]777;notify;${title};${message}\x07`;
			if (env.TMUX) sequence = `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
			write(sequence);
		},
	};
}
