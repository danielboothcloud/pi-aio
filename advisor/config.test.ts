import assert from "node:assert/strict";
import test from "node:test";

import {
	ADVISOR_DEFAULTS,
	ADVISOR_ENV,
	ADVISOR_STATE_ENTRY,
	describeAdvisor,
	inheritedAdvisor,
	latestAdvisorOverride,
	mirrorAdvisorEnv,
	parseAdvisorModelSpec,
	parseAdvisorSetting,
	resolveAdvisor,
} from "./config.ts";

test("string form: model with optional reasoning suffix, defaults elsewhere", () => {
	assert.deepEqual(parseAdvisorSetting("anthropic/claude-opus-4-5"), {
		...ADVISOR_DEFAULTS,
		model: "anthropic/claude-opus-4-5",
	});
	assert.equal(parseAdvisorSetting("anthropic/claude-opus-4-5:xhigh")?.reasoning, "xhigh");
	// Colon-bearing ids keep their colon when the suffix is not a level.
	assert.deepEqual(parseAdvisorModelSpec("hf:zai-org/GLM-5.3"), { model: "hf:zai-org/GLM-5.3" });
	assert.deepEqual(parseAdvisorModelSpec("hf:zai-org/GLM-5.3:low"), { model: "hf:zai-org/GLM-5.3", reasoning: "low" });
});

test("absent, off words, false, null and junk mean off", () => {
	for (const value of [undefined, null, false, "", "off", "OFF", "none", 42, [], {}, { model: 3 }, { model: "" }]) {
		assert.equal(parseAdvisorSetting(value), undefined, JSON.stringify(value));
	}
	assert.equal(parseAdvisorSetting({ model: "a/b", enabled: false }), undefined);
});

test("object form: reasoning/thinkingLevel alias and clamped integer limits", () => {
	const parsed = parseAdvisorSetting({
		model: "openai/gpt-x:low",
		thinkingLevel: "medium",
		maxUsesPerRun: 0,
		maxTokens: 999_999_999,
		maxContextMessages: 7.9,
	});
	assert.deepEqual(parsed, {
		model: "openai/gpt-x",
		reasoning: "medium",
		maxUsesPerRun: 1,
		maxTokens: 200_000,
		maxContextMessages: 7,
	});
	assert.equal(parseAdvisorSetting({ model: "openai/gpt-x:low" })?.reasoning, "low");
	assert.equal(parseAdvisorSetting({ model: "openai/gpt-x", reasoning: "bogus" })?.reasoning, "high");
	assert.equal(describeAdvisor(parsed!), "openai/gpt-x:medium");
});

test("latestAdvisorOverride: newest advisor-state entry wins; null clears", () => {
	const settings = parseAdvisorSetting("a/b")!;
	const entry = (data: unknown) => ({ type: "custom", customType: ADVISOR_STATE_ENTRY, data });
	assert.equal(latestAdvisorOverride([]), undefined);
	assert.deepEqual(latestAdvisorOverride([entry({ override: { mode: "off" } })]), { mode: "off" });
	assert.deepEqual(
		latestAdvisorOverride([entry({ override: { mode: "off" } }), entry({ override: { mode: "on", settings } })]),
		{ mode: "on", settings },
	);
	assert.equal(
		latestAdvisorOverride([entry({ override: { mode: "off" } }), entry({ override: null }), { type: "message" }]),
		undefined,
	);
});

test("resolveAdvisor precedence: override > recipe > inherited (children only) > off", () => {
	const recipe = { recipe: "work", settings: parseAdvisorSetting("r/model")! };
	const mine = parseAdvisorSetting("o/model")!;
	const env = { [ADVISOR_ENV]: JSON.stringify(parseAdvisorSetting("e/model")) } as NodeJS.ProcessEnv;
	assert.equal(resolveAdvisor({ mode: "off" }, recipe, env), undefined);
	assert.equal(resolveAdvisor({ mode: "on", settings: mine }, recipe, env)?.source, "override");
	assert.deepEqual(resolveAdvisor(undefined, recipe, env), { settings: recipe.settings, source: "recipe", recipe: "work" });
	// A top-level process ignores a stray mirror.
	assert.equal(resolveAdvisor(undefined, undefined, env), undefined);
	const childEnv = { ...env, AIO_SUBAGENT_CHILD: "1" } as NodeJS.ProcessEnv;
	assert.equal(resolveAdvisor(undefined, undefined, childEnv)?.settings.model, "e/model");
	assert.equal(inheritedAdvisor({ AIO_SUBAGENT_CHILD: "1", [ADVISOR_ENV]: "{not json" } as NodeJS.ProcessEnv), undefined);
});

test("mirrorAdvisorEnv writes the effective settings and clears on off", () => {
	const env = {} as NodeJS.ProcessEnv;
	const settings = parseAdvisorSetting("a/b:low")!;
	mirrorAdvisorEnv({ settings, source: "recipe", recipe: "x" }, env);
	assert.deepEqual(JSON.parse(env[ADVISOR_ENV]!), settings);
	mirrorAdvisorEnv(undefined, env);
	assert.equal(env[ADVISOR_ENV], undefined);
});
