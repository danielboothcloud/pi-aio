/**
 * Combined Pi extension: ask_user_question, /pick, /effort, Shift+Tab
 * permission modes, enhanced built-in tool output, and syntax-highlighted diffs.
 *
 * Effort and permission modes are based on @pandi-coding-agent/pandi-effort
 * and @aprimediet/permission-modes. The questionnaire implementation is based
 * on @juicesharp/rpiv-ask-user-question and retains its public event contract.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUserQuestion from "./ask-user-question/index.js";
import { registerCopyWidget } from "./copy-widget/index.js";
import registerDiffTools from "./diff-tools/index.js";
import { registerEffort } from "./effort/index.js";
import { registerPermissionModes } from "./permission-modes/index.js";
import registerPrettyTools from "./pretty-tools/index.js";
import { registerUserBash } from "./user-bash/index.js";

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./ask-user-question/events.js";

export default async function aio(pi: ExtensionAPI): Promise<void> {
	registerAskUserQuestion(pi);
	registerCopyWidget(pi);
	registerEffort(pi);
	await registerDiffTools(pi);
	registerPermissionModes(pi);
	registerUserBash(pi);
	await registerPrettyTools(pi);
}
