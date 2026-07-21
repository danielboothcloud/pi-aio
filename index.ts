/**
 * Combined Pi extension: /pick, /effort, and Shift+Tab permission modes.
 *
 * Effort and permission modes are based on @pandi-coding-agent/pandi-effort
 * and @aprimediet/permission-modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCopyWidget } from "./copy-widget/index.js";
import { registerEffort } from "./effort/index.js";
import { registerPermissionModes } from "./permission-modes/index.js";

export default function aioEffortModes(pi: ExtensionAPI): void {
	registerCopyWidget(pi);
	registerEffort(pi);
	registerPermissionModes(pi);
}
