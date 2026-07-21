/**
 * Combined pi extension: /effort thinking control + Shift+Tab permission modes.
 *
 * Based on @pandi-coding-agent/pandi-effort and @aprimediet/permission-modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEffort } from "./effort/index.js";
import { registerPermissionModes } from "./permission-modes/index.js";

export default function aioEffortModes(pi: ExtensionAPI): void {
	registerEffort(pi);
	registerPermissionModes(pi);
}
