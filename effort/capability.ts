import type { ThinkingLevel } from "./parse.js";

/**
 * pi-aio resolves a model's thinking-level capability on the fly instead of
 * requiring a hand-maintained per-model `thinkingLevelMap`.
 *
 * An explicit `thinkingLevelMap` always wins:
 *   - `null`  → the level is unsupported (pi clamps it away);
 *   - string  → that exact value is sent to the provider;
 *   - missing → pi-aio's default assumption applies.
 *
 * Default assumption: a reasoning-capable model supports every level through
 * `max`. Modern reasoning providers accept the standard effort strings, so
 * `xhigh`/`max` are NOT clamped for unmapped reasoning models. This is what
 * removes the need to declare a map for every model with different levels.
 */
export interface EffortModelLike {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * Provider effort string pi-aio wants sent for a level, or `undefined` when it
 * must not force one (level unsupported, or it is `off` which pi omits).
 */
export function resolveEffortValue(
	model: EffortModelLike | undefined,
	level: ThinkingLevel,
): string | undefined {
	if (!model?.reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[level];
	if (mapped === null) return undefined; // explicitly unsupported
	if (typeof mapped === "string") return mapped; // explicit value wins
	if (level === "off") return undefined; // off: leave reasoning_effort omitted
	return level; // default-on: send the level name (covers xhigh/max without a map)
}

/**
 * Rewrite an outgoing provider payload so a requested extended effort level
 * (`xhigh`/`max`) that pi clamped down is sent anyway — provided the model is
 * reasoning-capable and does not pin the level `null` in an explicit map.
 *
 * Only acts when `reasoning_effort` is already the mechanism pi used (i.e. the
 * payload carries it), so we never inject unsupported parameters into payloads
 * that use another thinking format. Returns the same payload when no override
 * applies.
 */
export function applyEffortOverride(
	model: EffortModelLike | undefined,
	desiredLevel: ThinkingLevel | undefined,
	payload: unknown,
): unknown {
	if (!desiredLevel) return payload;
	if (!model?.reasoning) return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	const record = payload as Record<string, unknown>;
	if (typeof record.reasoning_effort !== "string") return payload;
	const value = resolveEffortValue(model, desiredLevel);
	if (typeof value !== "string" || value === record.reasoning_effort)
		return payload;
	return { ...record, reasoning_effort: value };
}

/**
 * The effort level pi-aio should report as active, reconciling pi's clamped
 * value with the level we will actually send on the wire. When pi clamped an
 * extended level down but `resolveEffortValue` says we can still send the
 * requested value, report the requested level so the UI matches the request.
 */
export function effectiveEffortLevel(
	model: EffortModelLike | undefined,
	requested: ThinkingLevel,
	clamped: ThinkingLevel,
): ThinkingLevel {
	if (clamped === requested) return requested;
	if (
		(requested === "xhigh" || requested === "max") &&
		resolveEffortValue(model, requested) !== undefined
	) {
		return requested;
	}
	return clamped;
}
