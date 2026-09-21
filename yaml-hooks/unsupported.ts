// Pi hook policy: `command:` actions are unsupported on Pi (Pi exposes no
// slash-command API hooks can target), so they are rejected at load time and
// their hooks dropped from the active set. Ported from pi-yaml-hooks (MIT).

import type { HookAction, HookConfig, HookMap, HookPolicy } from "./types.js";
import { setActiveHookPolicy } from "./composition.js";

export function createPiHookPolicy(): HookPolicy {
	return {
		diagnose: (hookMap: HookMap) => {
			const errors: string[] = [];
			const advisories: string[] = [];
			const invalidHooks = new Set<HookConfig>();

			for (const hookList of hookMap.values()) {
				for (const hook of hookList) {
					if (hook.actions.some((action) => "command" in action)) {
						errors.push(
							`hook ${describeHook(hook)} uses command: actions, which are unsupported on Pi — remove this action or use bash instead`,
						);
						invalidHooks.add(hook);
					}
				}
			}

			return { errors, advisories, invalidHooks };
		},
	};
}

/** True when any of a hook's actions is a command action (diagnostics only). */
export function hasCommandAction(actions: readonly HookAction[]): boolean {
	return actions.some((action) => "command" in action);
}

function describeHook(hook: HookConfig): string {
	return hook.id ?? `${hook.source.filePath}#hooks[${hook.source.index}]`;
}

/** Idempotent registration used by the adapter on load. */
export function registerPiHookPolicy(): void {
	setActiveHookPolicy(createPiHookPolicy());
}
