import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PermissionMode = "default" | "ask" | "plan" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "ask", "plan", "auto"];

export interface PermissionModeAccess {
	getMode: () => PermissionMode;
	setMode: (mode: PermissionMode, ctx: ExtensionContext) => Promise<void>;
}

let access: PermissionModeAccess | undefined;

export function setPermissionModeAccess(next: PermissionModeAccess | undefined): void {
	access = next;
}

export function getPermissionModeAccess(): PermissionModeAccess | undefined {
	return access;
}

/** A recipe's `permissionMode` value, or undefined when it is not a mode. */
export function parsePermissionMode(value: unknown): PermissionMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (PERMISSION_MODES as readonly string[]).includes(normalized)
		? normalized as PermissionMode
		: undefined;
}

// The active recipe's starting mode. Recipes register (and run session_start)
// before permission-modes, so they publish the mode here and permission-modes
// uses it when a session starts with no explicit --permission-mode flag and no
// mode saved on the session.
let recipeMode: PermissionMode | undefined;

export function setRecipePermissionMode(mode: PermissionMode | undefined): void {
	recipeMode = mode;
}

export function getRecipePermissionMode(): PermissionMode | undefined {
	return recipeMode;
}
