import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerInit } from "./index.ts";
import { buildInitPrompt } from "./prompt.ts";

test("buildInitPrompt includes cwd and write guidance by default", () => {
	const prompt = buildInitPrompt({ cwd: "/tmp/my-app" });
	assert.match(prompt, /Project root: \/tmp\/my-app/);
	assert.match(prompt, /Write mode/);
	assert.match(prompt, /Update in place/);
	assert.match(prompt, /\/reload/);
});

test("buildInitPrompt honors dry-run and force args", () => {
	const dryRun = buildInitPrompt({ cwd: "/repo", args: "dry-run" });
	assert.match(dryRun, /Dry run/);
	assert.match(dryRun, /Do not create or modify files/);

	const force = buildInitPrompt({ cwd: "/repo", args: "force refresh" });
	assert.match(force, /Force refresh/);
});

test("registerInit sends init prompt immediately when idle", async () => {
	const sent: Array<{ content: string; options?: { deliverAs?: string } }> =
		[];
	const idle = true;

	const pi = {
		registerCommand: (
			_name: string,
			options: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => {
			void options.handler("", {
				cwd: "/projects/app",
				isIdle: () => idle,
				ui: { notify: () => {} },
			} as unknown as ExtensionCommandContext);
		},
		sendUserMessage: (
			content: string,
			options?: { deliverAs?: string },
		) => {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	registerInit(pi);
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /Project root: \/projects\/app/);
	assert.equal(sent[0]?.options, undefined);
});

test("registerInit queues init prompt when agent is busy", async () => {
	const sent: Array<{ content: string; options?: { deliverAs?: string } }> =
		[];
	const notifications: string[] = [];

	const pi = {
		registerCommand: (
			_name: string,
			options: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => {
			void options.handler("force", {
				cwd: "/projects/app",
				isIdle: () => false,
				ui: {
					notify: (message: string) => {
						notifications.push(message);
					},
				},
			} as unknown as ExtensionCommandContext);
		},
		sendUserMessage: (
			content: string,
			options?: { deliverAs?: string },
		) => {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	registerInit(pi);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.options?.deliverAs, "followUp");
	assert.match(sent[0]?.content ?? "", /Force refresh/);
	assert.match(notifications.join(" "), /Queued \/init/);
});
