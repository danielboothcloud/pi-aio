/**
 * Combined Pi extension: ask_user_question, /pick, /effort, Shift+Tab
 * permission modes, enhanced built-in tool output, syntax-highlighted diffs,
 * configurable web search, rtk shell-command rewriting, ast-grep structural
 * search, a message-queue UI with Enter-to-interrupt, YAML hook automation,
 * and live Hunk diff-review control with inline AI annotations.
 *
 * Effort and permission modes are based on @pandi-coding-agent/pandi-effort
 * and @aprimediet/permission-modes. The questionnaire implementation is based
 * on @juicesharp/rpiv-ask-user-question and retains its public event contract.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUserQuestion from "./ask-user-question/index.js";
import { registerAstGrep } from "./ast-grep/index.js";
import { registerBlocklist } from "./blocklist/index.js";
import { registerBrowserSearch } from "./browser-search/index.js";
import { registerCopyWidget } from "./copy-widget/index.js";
import registerDiffTools from "./diff-tools/index.js";
import { registerEffort } from "./effort/index.js";
import registerHunk from "./hunk/index.js";
import { registerInit } from "./init/index.js";
import registerLoopPolice from "./loop-police/index.js";
import registerGoalLoop from "./goal-loop/index.js";
import { registerHypa } from "./hypa/index.js";
import { registerPermissionModes } from "./permission-modes/index.js";
import { registerRtk } from "./rtk/index.js";
import { registerQueue } from "./queue/index.js";
import registerPrettyTools from "./pretty-tools/index.js";
import { registerSubagents } from "./subagents/index.js";
import { registerStatusLine } from "./status-line/index.js";
import { registerUserBash } from "./user-bash/index.js";
import registerYamlHooks from "./yaml-hooks/index.js";

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./ask-user-question/events.js";

export default async function aio(pi: ExtensionAPI): Promise<void> {
	registerAskUserQuestion(pi);
	registerGoalLoop(pi);
	registerAstGrep(pi);
	registerBrowserSearch(pi);
	registerCopyWidget(pi);
	registerEffort(pi);
	registerInit(pi);
	await registerDiffTools(pi);
	// Blocklist gates must run before the permission-modes tool_call gate and
	// the user-bash gate: the runner honors the first blocking handler, so a
	// blocked command short-circuits mode checks (including auto approval).
	registerBlocklist(pi);
	// Loop-police sits between blocklist and permission-modes: a loop block
	// preempts mode checks, while the hard blocklist still wins over a loop
	// block (blocked commands stay blocked). Its context scrub composes with
	// blocklist's context dedupe — it only touches assistant thinking blocks.
	registerLoopPolice(pi);
	registerPermissionModes(pi);
	registerSubagents(pi);
	registerUserBash(pi);
	registerRtk(pi);
	// Hypa compliments rtk: it registers after rtk so commands rtk already
	// rewrote (`rtk ...`) are never rewritten again by hypa (rtk precedence —
	// see hypa/index.ts isRtkClaimedCommand). It must also run before the queue
	// and pretty-tools registrations, which own the final bash tool surface.
	registerHypa(pi);
	// Queue installs its editor after user-bash so its factory wins; it
	// extends BashHintEditor, keeping the !bash hint behavior intact.
	registerQueue(pi);
	await registerPrettyTools(pi);
	registerStatusLine(pi);
	// Hunk owns the `hunk` tool (live diff-review control) and surfaces the
	// bundled hunk-review skill through resources_discover; optional when the
	// hunk binary is not installed.
	registerHunk(pi);
	// Yaml hooks last: it owns no tool surface, but its user-bash interception
	// (opt-in via env) must wrap the user-bash gate above.
	registerYamlHooks(pi);
}
