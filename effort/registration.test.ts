import { strict as assert } from "node:assert";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getEffectiveLevel, setEffectiveLevel } from "./effort-status.js";
import { registerEffort } from "./index.js";

type BeforeProviderRequestHandler = (
	event: { type: "before_provider_request"; payload: unknown },
	ctx: ExtensionContext,
) => unknown | Promise<unknown>;

test("before_provider_request reads the active model from ctx.model", async () => {
	let handler: BeforeProviderRequestHandler | undefined;
	const pi = {
		registerCommand() {},
		on(event: string, candidate: BeforeProviderRequestHandler) {
			if (event === "before_provider_request") handler = candidate;
		},
	} as unknown as ExtensionAPI;

	registerEffort(pi);
	assert.ok(handler, "before_provider_request handler should be registered");

	const previous = getEffectiveLevel();
	try {
		setEffectiveLevel("max");
		const payload = { reasoning_effort: "high" };
		const ctx = {
			model: { reasoning: true },
		} as unknown as ExtensionContext;

		const result = await handler(
			{ type: "before_provider_request", payload },
			ctx,
		);
		assert.deepEqual(result, { reasoning_effort: "max" });
	} finally {
		setEffectiveLevel(previous);
	}
});
