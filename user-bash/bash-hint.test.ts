import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncBashHint } from "./bash-hint.js";

function makeCtx() {
	const widgets: Array<{ key: string; content: unknown; options?: unknown }> =
		[];
	const statuses: Array<{ key: string; text: unknown }> = [];

	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setWidget: (
				key: string,
				content: unknown,
				options?: unknown,
			) => {
				widgets.push({ key, content, options });
			},
			setStatus: (key: string, text: unknown) => {
				statuses.push({ key, text });
			},
		},
	} as unknown as ExtensionContext;

	return { ctx, widgets, statuses };
}

test("syncBashHint clears widget and status for normal input", () => {
	const { ctx, widgets, statuses } = makeCtx();
	syncBashHint(ctx, "hello");
	assert.equal(widgets.at(-1)?.content, undefined);
	assert.equal(statuses.at(-1)?.text, undefined);
});

test("syncBashHint keeps editor chrome singular and publishes !bash status", () => {
	const { ctx, widgets, statuses } = makeCtx();
	syncBashHint(ctx, "!git status");
	const widget = widgets.at(-1);
	const status = statuses.at(-1);
	assert.equal(widget?.key, "user-bash-hint");
	assert.equal(widget?.content, undefined);
	assert.equal(widget?.options, undefined);
	assert.equal(status?.text, "!bash");
});

test("syncBashHint labels hidden mode for !! input", () => {
	const { ctx, widgets, statuses } = makeCtx();
	syncBashHint(ctx, "!!npm test");
	assert.equal(widgets.at(-1)?.content, undefined);
	assert.equal(statuses.at(-1)?.text, "!!bash");
});
