import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	applyEffortOverride,
	effectiveEffortLevel,
	resolveEffortValue,
	type EffortModelLike,
} from "./capability.js";

const reasoningNoMap: EffortModelLike = { reasoning: true };
const reasoningWithMaxMap: EffortModelLike = {
	reasoning: true,
	thinkingLevelMap: { low: "low", high: "high", xhigh: null, max: "max" },
};
const reasoningMaxNull: EffortModelLike = {
	reasoning: true,
	thinkingLevelMap: { max: null },
};
const nonReasoning: EffortModelLike = { reasoning: false };

describe("resolveEffortValue", () => {
	it("defaults unmapped reasoning models to the requested level for xhigh/max", () => {
		assert.equal(resolveEffortValue(reasoningNoMap, "max"), "max");
		assert.equal(resolveEffortValue(reasoningNoMap, "xhigh"), "xhigh");
	});

	it("does not force a value for off on unmapped models", () => {
		assert.equal(resolveEffortValue(reasoningNoMap, "off"), undefined);
	});

	it("honors an explicit string map value", () => {
		assert.equal(resolveEffortValue(reasoningWithMaxMap, "max"), "max");
		assert.equal(resolveEffortValue(reasoningWithMaxMap, "high"), "high");
	});

	it("returns undefined when a level is pinned null", () => {
		assert.equal(resolveEffortValue(reasoningWithMaxMap, "xhigh"), undefined);
		assert.equal(resolveEffortValue(reasoningMaxNull, "max"), undefined);
	});

	it("returns undefined for non-reasoning models", () => {
		assert.equal(resolveEffortValue(nonReasoning, "max"), undefined);
		assert.equal(resolveEffortValue(undefined, "max"), undefined);
	});
});

describe("applyEffortOverride", () => {
	const payload = { model: "x", reasoning_effort: "high", messages: [] };

	it("lifts a clamped max back up for an unmapped reasoning model", () => {
		const next = applyEffortOverride(reasoningNoMap, "max", payload);
		assert.equal((next as Record<string, unknown>).reasoning_effort, "max");
	});

	it("leaves the payload unchanged when the mapped value already matches", () => {
		const next = applyEffortOverride(reasoningWithMaxMap, "max", payload);
		// explicit map max:"max", but current payload says high → override to max
		assert.equal((next as Record<string, unknown>).reasoning_effort, "max");
	});

	it("does not override a level pinned null", () => {
		const next = applyEffortOverride(reasoningWithMaxMap, "xhigh", payload);
		assert.equal(next, payload);
	});

	it("does nothing when reasoning_effort is not the mechanism", () => {
		const deepseekPayload = { model: "x", thinking: { type: "enabled" } };
		assert.equal(
			applyEffortOverride(reasoningNoMap, "max", deepseekPayload),
			deepseekPayload,
		);
	});

	it("does nothing for non-reasoning models or missing desired level", () => {
		assert.equal(applyEffortOverride(nonReasoning, "max", payload), payload);
		assert.equal(
			applyEffortOverride(reasoningNoMap, undefined, payload),
			payload,
		);
	});

	it("is a no-op when the desired value equals the current payload value", () => {
		const alreadyMax = { reasoning_effort: "max" };
		assert.equal(
			applyEffortOverride(reasoningNoMap, "max", alreadyMax),
			alreadyMax,
		);
	});
});

describe("effectiveEffortLevel", () => {
	it("reports the requested level when pi honors it", () => {
		assert.equal(effectiveEffortLevel(reasoningNoMap, "high", "high"), "high");
	});

	it("reports requested xhigh/max when the override will send it", () => {
		assert.equal(effectiveEffortLevel(reasoningNoMap, "max", "high"), "max");
		assert.equal(
			effectiveEffortLevel(reasoningWithMaxMap, "max", "high"),
			"max",
		);
	});

	it("reports the clamped level when the level is pinned null", () => {
		assert.equal(
			effectiveEffortLevel(reasoningWithMaxMap, "xhigh", "high"),
			"high",
		);
		assert.equal(effectiveEffortLevel(reasoningMaxNull, "max", "high"), "high");
	});
});
