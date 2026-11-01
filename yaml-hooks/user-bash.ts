// Compatibility shim for the retired user-bash interceptor, originally ported
// from pi-yaml-hooks (MIT). Explicit !/!! input is user-authorized and must not
// be observed or blocked by YAML tool hooks. PI_YAML_HOOKS_ENABLE_USER_BASH is
// retained as an ignored legacy environment name, not an opt-in bypass.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeRegistry } from "./registry.js";

export function registerUserBashInterception(
	_pi: ExtensionAPI,
	_options: { runtimeRegistry: RuntimeRegistry },
): void {}
