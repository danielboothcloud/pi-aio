// File composition: parse a hooks.yaml into a HookMap, merge multiple files,
// and resolve overrides. Ported from pi-yaml-hooks (MIT).

import type {
	HookConfig,
	HookMap,
	HookOverrideEntry,
	HookPolicy,
	HookValidationError,
	ParsedHooksFile,
} from "./types.js";
import { defaultReadFile, formatHookReadError, parseHooksFileEnvelope } from "./yaml-envelope.js";
import { createError, parseHookDefinition } from "./schema.js";

// No-op policy for embedders/tests; the Pi policy is registered by
// yaml-hooks/unsupported.ts and rejects `command:` actions.
const NOOP_POLICY: HookPolicy = {
	diagnose: () => ({ errors: [], advisories: [], invalidHooks: new Set<HookConfig>() }),
};
let activeHookPolicy: HookPolicy = NOOP_POLICY;

export function setActiveHookPolicy(policy: HookPolicy | undefined): void {
	activeHookPolicy = policy ?? NOOP_POLICY;
}

export function getActiveHookPolicy(): HookPolicy {
	return activeHookPolicy;
}

export type ParsedHooksFileResult = ParsedHooksFile & { readonly files: string[] };

export function parseHooksFile(
	filePath: string,
	content: string,
	options: { policy?: HookPolicy } = {},
): ParsedHooksFileResult {
	const envelope = parseHooksFileEnvelope(filePath, content);
	if (envelope.errors.length > 0 || !envelope.body) {
		return {
			hooks: new Map(),
			overrides: [],
			errors: envelope.errors,
			files: [filePath],
		};
	}

	return parseHooksObject(filePath, envelope.body, options.policy);
}

export function parseHooksObject(
	filePath: string,
	parsed: Record<string, unknown>,
	policy: HookPolicy = activeHookPolicy,
): ParsedHooksFileResult {
	if (!Object.prototype.hasOwnProperty.call(parsed, "hooks")) {
		return {
			hooks: new Map(),
			overrides: [],
			errors: [{ code: "missing_hooks", filePath, message: "hooks.yaml must define a hooks list.", path: "hooks" }],
			files: [filePath],
		};
	}

	if (!Array.isArray(parsed.hooks)) {
		return {
			hooks: new Map(),
			overrides: [],
			errors: [{ code: "invalid_hooks", filePath, message: "hooks must be an array.", path: "hooks" }],
			files: [filePath],
		};
	}

	const hooks = new Map<HookConfig["event"], HookConfig[]>();
	const overrides: HookOverrideEntry[] = [];
	const errors: HookValidationError[] = [];
	const seenIds = new Set<string>();

	parsed.hooks.forEach((hookDefinition, index) => {
		const parsedHook = parseHookDefinition(filePath, hookDefinition, index, seenIds);
		errors.push(...parsedHook.errors);
		if (!parsedHook.hook) {
			if (parsedHook.override) {
				overrides.push(parsedHook.override);
			}
			return;
		}

		if (parsedHook.override) {
			overrides.push(parsedHook.override);
			return;
		}

		const existing = hooks.get(parsedHook.hook.event) ?? [];
		hooks.set(parsedHook.hook.event, [...existing, parsedHook.hook]);
	});

	errors.push(...validateAsyncQueueConfigs(hooks));

	const policyDiagnostics = policy.diagnose(hooks);
	for (const message of policyDiagnostics.errors) {
		errors.push({ code: "unsupported_on_pi", filePath, message });
	}

	// Drop hooks that produced unsupported_on_pi errors so the runtime never
	// executes them; the errors above remain so operators see why.
	if (policyDiagnostics.invalidHooks.size > 0) {
		for (const [event, hookList] of hooks) {
			const filtered = hookList.filter((hook) => !policyDiagnostics.invalidHooks.has(hook));
			if (filtered.length === 0) {
				hooks.delete(event);
			} else if (filtered.length !== hookList.length) {
				hooks.set(event, filtered);
			}
		}
	}

	if (policyDiagnostics.advisories.length > 0) {
		return { hooks, overrides, errors: dedupeValidationErrors(errors), advisories: [...policyDiagnostics.advisories], files: [filePath] };
	}

	return { hooks, overrides, errors: dedupeValidationErrors(errors), files: [filePath] };
}

export function loadHooksFile(
	filePath: string,
	readFile: (filePath: string) => string = defaultReadFile,
): ParsedHooksFileResult {
	try {
		return parseHooksFile(filePath, readFile(filePath));
	} catch (error) {
		return {
			hooks: new Map(),
			overrides: [],
			errors: [{ code: "invalid_frontmatter", filePath, message: formatHookReadError(error) }],
			files: [filePath],
		};
	}
}

export function mergeHookMaps(...hookMaps: HookMap[]): HookMap {
	const merged = new Map<HookConfig["event"], HookConfig[]>();
	for (const hookMap of hookMaps) {
		mergeHookMapsInto(merged, hookMap);
	}
	return merged;
}

export function mergeHookMapsInto(target: HookMap, source: HookMap): void {
	for (const [event, configs] of source) {
		target.set(event, [...(target.get(event) ?? []), ...configs]);
	}
}

export function resolveOverrides(
	hooks: HookMap,
	overrides: HookOverrideEntry[],
): { hooks: HookMap; errors: HookValidationError[] } {
	const orderedHooks = flattenHookMap(hooks);
	const errors: HookValidationError[] = [];

	const idIndex = new Map<string, number>();
	const idSources = new Map<string, HookConfig[]>();
	orderedHooks.forEach((hook, index) => {
		if (!hook.id) return;
		const existing = idSources.get(hook.id);
		if (existing) {
			existing.push(hook);
		} else {
			idSources.set(hook.id, [hook]);
		}
		// Last-wins for the lookup; duplicates are surfaced as errors below.
		idIndex.set(hook.id, index);
	});

	for (const [id, hooksWithId] of idSources) {
		if (hooksWithId.length <= 1) continue;
		const [first, ...rest] = hooksWithId;
		if (!first) continue;
		for (const dup of rest) {
			errors.push(
				createError(
					dup.source.filePath,
					"duplicate_hook_id",
					`hooks[${dup.source.index}].id duplicates hook id "${id}" already defined at ${first.source.filePath}#hooks[${first.source.index}].`,
					`hooks[${dup.source.index}].id`,
				),
			);
		}
	}

	for (const override of overrides) {
		const targetIndex = idIndex.get(override.targetId);
		if (targetIndex === undefined) {
			errors.push(
				createError(
					override.source.filePath,
					"override_target_not_found",
					`hooks[${override.source.index}].override targets unknown hook id "${override.targetId}".`,
					`hooks[${override.source.index}].override`,
				),
			);
			continue;
		}

		if (override.disable) {
			orderedHooks.splice(targetIndex, 1);
			idIndex.delete(override.targetId);
			// Reindex anything past the splice point so subsequent overrides
			// hit the right slot.
			for (const [id, idx] of idIndex) {
				if (idx > targetIndex) {
					idIndex.set(id, idx - 1);
				}
			}
			continue;
		}

		if (override.replacement) {
			orderedHooks.splice(targetIndex, 1, override.replacement);
			idIndex.delete(override.targetId);
			if (override.replacement.id) {
				idIndex.set(override.replacement.id, targetIndex);
			}
		}
	}

	return { hooks: toHookMap(orderedHooks), errors };
}

export function dedupeValidationErrors(errors: readonly HookValidationError[]): HookValidationError[] {
	const seen = new Set<string>();
	const deduped: HookValidationError[] = [];
	for (const error of errors) {
		const key = `${error.code}\0${error.filePath}\0${error.path ?? ""}\0${error.message}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(error);
	}
	return deduped;
}

export function validateAsyncQueueConfigs(hooks: HookMap): HookValidationError[] {
	const errors: HookValidationError[] = [];
	const concurrencyByGroup = new Map<string, number>();

	for (const hook of flattenHookMap(hooks)) {
		if (!hook.async || hook.async === true) {
			continue;
		}

		const pathBase = `hooks[${hook.source.index}].async`;
		if (hook.async.concurrency !== undefined && hook.async.group === undefined) {
			errors.push(
				createError(
					hook.source.filePath,
					"invalid_async",
					`${pathBase}.concurrency requires async.group so legacy per-event async queues stay serialized by default.`,
					`${pathBase}.concurrency`,
				),
			);
		}

		if (!hook.async.group) {
			continue;
		}

		const expected = concurrencyByGroup.get(hook.async.group);
		const actual = hook.async.concurrency ?? 1;
		if (expected !== undefined && expected !== actual) {
			errors.push(
				createError(
					hook.source.filePath,
					"invalid_async",
					`${pathBase}.concurrency for group ${JSON.stringify(hook.async.group)} must match earlier hooks in that group (${expected}).`,
					`${pathBase}.concurrency`,
				),
			);
			continue;
		}

		concurrencyByGroup.set(hook.async.group, actual);
	}

	return errors;
}

export function flattenHookMap(hooks: HookMap): HookConfig[] {
	return Array.from(hooks.values()).flat();
}

export function countHookConfigs(hooks: HookMap): number {
	return flattenHookMap(hooks).length;
}

function toHookMap(hooks: HookConfig[]): HookMap {
	const hookMap = new Map<HookConfig["event"], HookConfig[]>();
	for (const hook of hooks) {
		const existing = hookMap.get(hook.event) ?? [];
		hookMap.set(hook.event, [...existing, hook]);
	}
	return hookMap;
}
