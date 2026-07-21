import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PermissionMode = "default" | "ask" | "plan" | "auto";

export interface PermissionModeAccess {
	getMode: () => PermissionMode;
	setMode: (mode: PermissionMode, ctx: ExtensionContext) => Promise<void>;
}

let access: PermissionModeAccess | undefined;

export function setPermissionModeAccess(next: PermissionModeAccess): void {
	access = next;
}

export function getPermissionModeAccess(): PermissionModeAccess | undefined {
	return access;
}
