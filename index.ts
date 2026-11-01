/**
 * Combined Pi extension: recipes (`--recipe`, `/recipe`), ask_user_question,
 * /pick, /effort, Shift+Tab permission modes, enhanced built-in tool output,
 * syntax-highlighted diffs, configurable web search, rtk shell-command
 * rewriting, ast-grep structural search, a message-queue UI with
 * Enter-to-interrupt, YAML hook automation, the tuicr review loop (ported
 * from @joelazar/pi-tuicr), the You Should Know (YSK) dual-agent shadow
 * auditor, and the /btw mid-flow side-question channel.
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
import { registerInit } from "./init/index.js";
import registerNvim from "./nvim/index.js";
import registerGoalLoop from "./goal-loop/index.js";
import { registerHypa } from "./hypa/index.js";
import { registerPermissionModes } from "./permission-modes/index.js";
import { registerRecipes } from "./recipes/index.js";
import { registerRtk } from "./rtk/index.js";
import { registerQueue } from "./queue/index.js";
import registerPrettyTools from "./pretty-tools/index.js";
import { registerSubagents } from "./subagents/index.js";
import { registerStatusLine } from "./status-line/index.js";
import { registerStyles } from "./styles/index.js";
import registerTuicr from "./tuicr/index.js";
import { registerUserBash } from "./user-bash/index.js";
import { registerFrameEditor } from "./frame/index.js";
import registerYamlHooks from "./yaml-hooks/index.js";
import { registerYouShouldKnow } from "./you-should-know/index.js";
import { registerBtw } from "./btw/index.js";
import { registerSessionNaming } from "./session-naming/index.js";
import { registerNotifications } from "./notifications/index.js";

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./ask-user-question/events.js";

export default async function aio(pi: ExtensionAPI): Promise<void> {
	// Recipes registers FIRST and is awaited: its factory-time relaunch
	// bridge (restart-scoped recipes: extension set, model scope) must decide
	// before anything else touches the process, and its session_start
	// recipe application has to establish the baseline tool set before
	// permission-modes snapshots passive-mode restrictions or ask-user-question
	// reconciles its tool. Everything else may keep its registration order.
	await registerRecipes(pi);
	registerAskUserQuestion(pi);
	registerGoalLoop(pi);
	registerAstGrep(pi);
	registerBrowserSearch(pi);
	registerCopyWidget(pi);
	registerEffort(pi);
	registerInit(pi);
	await registerDiffTools(pi);
	// Blocklist gates must run before the permission-modes tool_call gate:
	// the runner honors the first blocking handler, so a
	// blocked command short-circuits mode checks (including auto approval).
	registerBlocklist(pi);
	// Nvim owns the /nvim command (no agent tool); registers after the
	// gates (it opens editor panes, it never gates anything).
	registerNvim(pi);
	registerPermissionModes(pi);
	// Styles layer opt-in interaction guidance on top of the permission mode;
	// they register after it so their per-turn instruction follows the mode's.
	registerStyles(pi);
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
	// Tuicr owns the `/tuicr` command and ctrl+shift+r shortcut (ported from
	// @joelazar/pi-tuicr): a foreground diff review whose comments are
	// prefilled into the editor. It registers no tools and owns no editor
	// surface; registration is unconditional and a missing tuicr binary only
	// fails the run (optional integration).
	registerTuicr(pi);
	// The frame registers after every editor/status publisher so it can wrap
	// AIO's QueueEditor and become the single final visual owner (minimalist
	// editor frame, proprietary — see frame/UPSTREAM.md).
	registerFrameEditor(pi);
	// YSK observes successful write/edit/apply_patch results and mutates
	// nothing: no gating, no tool surface, no editor ownership, so its place in
	// the chain is not load-bearing. It runs late, after the visual publishers.
	registerYouShouldKnow(pi);
	// btw owns the /btw command: quick side questions answered by the session
	// model through one isolated complete() call — no gating, no tool surface,
	// no editor ownership, so like YSK its place is not load-bearing. Runs
	// after the visual publishers, before yaml-hooks.
	registerBtw(pi);
	registerSessionNaming(pi);
	// Human-only desktop observer; stays inert in child/headless processes.
	registerNotifications(pi);
	// Yaml hooks last for agent tool-hook composition. Explicit user !/!!
	// commands use Pi's native path without any AIO interception.
	registerYamlHooks(pi);
}
