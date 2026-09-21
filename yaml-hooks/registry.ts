// Runtime registry: one HooksRuntime per project directory, created lazily
// on first use, plus the freshest ExtensionContext per cwd (kept current by
// every adapter handler). Ported from pi-yaml-hooks (MIT), Pi-only.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostAdapter } from "./types.js";
import type { CreateHooksRuntimeOptions, HooksRuntime } from "./runtime.js";
import { createHooksRuntime } from "./runtime.js";

export interface RuntimeRegistry {
	/** Capture the freshest context for a cwd (cheap; every handler calls). */
	rememberContext(cwd: string, ctx: ExtensionContext): void;
	/** Lazily construct (or reuse) the runtime for a cwd. */
	getRuntimeFor(cwd: string): HooksRuntime;
	/** Capture the adapter used for runtimes created after this call. */
	setHostAdapter(adapter: HostAdapter): void;
	/** Diagnostics: number of live runtimes. */
	size(): number;
}

export interface CreateRuntimeRegistryOptions {
	readonly pi: ExtensionAPI;
	readonly runtimeOptions: Omit<CreateHooksRuntimeOptions, "projectDir" | "host">;
}

export function createRuntimeRegistry(pi: ExtensionAPI, options: CreateRuntimeRegistryOptions): RuntimeRegistry {
	const runtimes = new Map<string, HooksRuntime>();
	const contexts = new Map<string, ExtensionContext>();
	let hostAdapter: HostAdapter | undefined;

	return {
		rememberContext(cwd: string, ctx: ExtensionContext): void {
			contexts.set(cwd, ctx);
		},

		getRuntimeFor(cwd: string): HooksRuntime {
			const existing = runtimes.get(cwd);
			if (existing) {
				return existing;
			}

			if (!hostAdapter) {
				throw new Error("Host adapter must be registered before runtime creation.");
			}

			const runtime = createHooksRuntime({
				...options.runtimeOptions,
				projectDir: cwd,
				host: hostAdapter,
			});
			runtimes.set(cwd, runtime);
			return runtime;
		},

		setHostAdapter(adapter: HostAdapter): void {
			hostAdapter = adapter;
		},

		size(): number {
			return runtimes.size;
		},
	};
}

export type { ExtensionAPI as PiExtensionAPI };
