package recipes

// Launch decisions inside pig (port of recipes/trampoline.ts decideRelaunch
// and canPromptAtLaunch, recipes/continue.ts launchArgs, and
// recipes/trust.ts recipeFileTrust's --no-approve rule). PiG runs the Go
// extension in a helper process, so it never relaunches: the decision only
// yields the launch note that the session shows once. The bin/aio-pig.mjs
// launcher runs the real bridge before pig starts.

import (
	"fmt"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
)

// Env names read by the launch decision.
const (
	SubagentChildEnv = "AIO_SUBAGENT_CHILD"
	PigHarnessEnv    = "PIG_HARNESS_BINARY"
	InjectedArgsEnv  = "AIO_RECIPE_INJECTED_ARGS"
)

// Subcommands are PI_SUBCOMMANDS: names dispatched before a session starts.
var Subcommands = []string{"install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"}

// IsPigHost is pig-host.ts isPigHost.
func IsPigHost(env map[string]string) bool {
	return env["AI_AGENT"] == "pig" && jsTrim(env[PigHarnessEnv]) != ""
}

// StartedByPigLauncher is pig-host.ts startedByPigLauncher.
func StartedByPigLauncher(env map[string]string) bool { return env[PigLauncherEnv] == "1" }

// PigRestartNote is trampoline.ts pigRestartNote.
func PigRestartNote(label string) string {
	return label + ": extension set and model scope not applied — PiG cannot restart from an extension; start pig through AIO's bin/aio-pig.mjs launcher to apply them. Everything else applies in-session"
}

// PigLauncherMismatchNote is trampoline.ts pigLauncherMismatchNote.
func PigLauncherMismatchNote(label string) string {
	return label + ": extension set and model scope not applied — the aio-pig launcher did not apply them for this launch; everything else applies in-session"
}

// NoApprove reports pig's --no-approve: the `.pi-recipe` is skipped
// ("denied") for this run.
func NoApprove(argv []string) bool {
	parsed := piargs.Parse(argv)
	return parsed.ProjectTrustOverride != nil && !*parsed.ProjectTrustOverride
}

// FileTrustForLaunch is recipeFileTrust with the launch's CLI arguments.
func FileTrustForLaunch(file, store string, argv []string) string {
	if NoApprove(argv) {
		return Denied
	}
	return FileTrust(file, store)
}

// Continued is continue.ts ContinuedRecipe: the recipe pinned on the branch
// of a session opened with --continue, --session, or --session-id.
type Continued struct {
	Name string
	File string
}

// ContinuedSession is continue.ts launchArgs: it reports whether the argv
// opens a saved session whose branch recipe owns the launch.
func ContinuedSession(argv []string, env map[string]string) bool {
	if env[StageEnv] != "" || env[SubagentChildEnv] != "" {
		return false
	}
	if len(argv) > 0 && contains(Subcommands, argv[0]) {
		return false
	}
	parsed := piargs.Parse(argv)
	if parsed.NoSession || parsed.Resume || parsed.Fork != nil || parsed.Help || parsed.Version ||
		parsed.Export != nil || parsed.ListModels != nil || hasUnknown(parsed, Flag) {
		return false
	}
	return parsed.Continue || parsed.Session != nil || parsed.SessionID != nil
}

func hasUnknown(parsed piargs.Args, name string) bool {
	for _, flag := range parsed.UnknownFlags {
		if flag.Name == name {
			return true
		}
	}
	return false
}

func unknownValue(parsed piargs.Args, name string) (any, bool) {
	for _, flag := range parsed.UnknownFlags {
		if flag.Name == name {
			return flag.Value, true
		}
	}
	return nil, false
}

// LaunchInput is decideRelaunch's options. Argv is the CLI arguments (after
// the binary).
type LaunchInput struct {
	Argv            []string
	Env             map[string]string
	Recipes         map[string]*Definition
	DirectoryRecipe string
	Continued       *Continued
}

// LaunchDecision is TrampolineDecision without the relaunch spec.
type LaunchDecision struct {
	// Action is "none", "unknown-recipe", "session-apply", or "relaunch".
	Action string
	Reason string // for "none"
	Name   string
	Note   string // for "session-apply"
}

// DecideLaunch is decideRelaunch. The factory skips it for --resume, which
// the caller checks with piargs (see LaunchNote).
func DecideLaunch(in LaunchInput) LaunchDecision {
	env := in.Env
	if env[StageEnv] != "" {
		return LaunchDecision{Action: "none", Reason: "stage"}
	}
	if env[SubagentChildEnv] != "" {
		return LaunchDecision{Action: "none", Reason: "child"}
	}
	args := in.Argv
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") && contains(Subcommands, args[0]) {
		return LaunchDecision{Action: "none", Reason: "sessionless"}
	}
	parsed := piargs.Parse(args)
	flagValue, flagSet := unknownValue(parsed, Flag)
	var name, origin string
	switch {
	case !flagSet && in.Continued != nil:
		name, origin = in.Continued.Name, "session"
	case !flagSet:
		directoryName := jsTrim(in.DirectoryRecipe)
		if directoryName == "" {
			return LaunchDecision{Action: "none", Reason: "no-recipe"}
		}
		// A directory default is a default, not an override.
		if parsed.Continue || parsed.Resume || parsed.Session != nil || parsed.SessionID != nil || parsed.Fork != nil {
			return LaunchDecision{Action: "none", Reason: "resume"}
		}
		name, origin = directoryName, "directory"
	default:
		s, isString := flagValue.(string)
		if !isString || jsTrim(s) == "" {
			return LaunchDecision{Action: "none", Reason: "bare-flag"}
		}
		name, origin = jsTrim(s), "flag"
	}
	label := fmt.Sprintf(`.pi-recipe default "%s"`, name)
	switch origin {
	case "flag":
		label = fmt.Sprintf(`--recipe "%s"`, name)
	case "session":
		label = fmt.Sprintf(`resumed recipe "%s"`, name)
	}
	if parsed.Help || parsed.Version || parsed.Export != nil || parsed.ListModels != nil {
		return LaunchDecision{Action: "none", Reason: "sessionless"}
	}
	recipe := in.Recipes[name]
	if recipe == nil {
		return LaunchDecision{Action: "unknown-recipe", Name: name}
	}
	if !IsRestartScoped(recipe.Config) {
		return LaunchDecision{Action: "session-apply", Name: name}
	}
	if IsPigHost(env) && !StartedByPigLauncher(env) {
		return LaunchDecision{Action: "session-apply", Name: name, Note: PigRestartNote(label)}
	}
	// CLI flags the user typed win over recipe keys.
	userExtFlags := parsed.NoExtensions || len(parsed.Extensions) > 0
	extensionsApplicable := len(recipe.Config.Extensions) > 0 && !userExtFlags
	modelsApplicable := len(recipe.Config.Models) > 0 && parsed.Models == nil
	if !extensionsApplicable && !modelsApplicable {
		var skipped []string
		if !extensionsApplicable {
			skipped = append(skipped, "extension set")
		}
		if !modelsApplicable {
			skipped = append(skipped, "model scope")
		}
		return LaunchDecision{Action: "session-apply", Name: name,
			Note: label + ": " + strings.Join(skipped, " and ") + " left unchanged (overridden by explicit CLI flags); everything else applies in-session"}
	}
	if extensionsApplicable {
		// resolveExtensionSource with the factory's exists seam (always
		// true): only "aio" (always injected) resolves to nothing.
		resolved := 0
		for _, entry := range recipe.Config.Extensions {
			if trimmed := jsTrim(entry); trimmed != "" && trimmed != "aio" {
				resolved++
			}
		}
		if resolved == 0 {
			return LaunchDecision{Action: "session-apply", Name: name, Note: label + ": no extension sources resolved; extension set left unchanged"}
		}
	}
	if IsPigHost(env) {
		return LaunchDecision{Action: "session-apply", Name: name, Note: PigLauncherMismatchNote(label)}
	}
	return LaunchDecision{Action: "relaunch", Name: name}
}

// LaunchNote is the factory's launchNotice: the note of a "session-apply"
// decision, never for --resume (its picker runs before the session).
func LaunchNote(in LaunchInput) string {
	if piargs.Parse(in.Argv).Resume {
		return ""
	}
	if decision := DecideLaunch(in); decision.Action == "session-apply" {
		return decision.Note
	}
	return ""
}

// RequestedModels is the actual CLI model scope (`--models`), nil when absent.
func RequestedModels(argv []string) []string { return piargs.Parse(argv).Models }

// EmptyScopeMessage is the startup error for a scope that matched nothing.
func EmptyScopeMessage(name string, models []string) string {
	return fmt.Sprintf(`Recipe "%s": no available models matched %s. Check that its provider extension loaded, authentication is available, and the model ID exists in its catalog. Stopping instead of enabling all models.`,
		name, strings.Join(models, ", "))
}

// TrustHint is the no-UI line for a new or changed `.pi-recipe`.
func TrustHint(file string) string {
	return "recipes: " + file + " is new or changed and not trusted yet — skipped (run pi interactively, or /recipe trust)\n"
}

// TrustChoices are the session trust question's choices in label order.
var TrustChoices = []string{"trust", "skip", "deny"}

// TrustChoiceOf maps a picked label to its choice; a cancel is "skip".
func TrustChoiceOf(picked string) string {
	for i, label := range TrustChoiceLabels {
		if label == picked {
			return TrustChoices[i]
		}
	}
	return "skip"
}

// TrustHost is what the session trust question needs.
type TrustHost interface {
	HasUI() bool
	// Select returns the chosen option, ok=false when cancelled.
	Select(title string, options []string) (string, bool)
	// Stderr writes a diagnostic line where no UI exists.
	Stderr(text string)
}

// AskDirectoryTrust is index.ts askDirectoryTrust with the no-UI hint of
// sessionStart: with a UI it asks and records a trust or deny decision;
// without one it writes the hint. It returns "trust", "deny", or "skip".
func AskDirectoryTrust(h TrustHost, file, store string) (string, error) {
	if !h.HasUI() {
		h.Stderr(TrustHint(file))
		return "skip", nil
	}
	picked, _ := h.Select(TrustPromptTitle(file), TrustChoiceLabels)
	choice := TrustChoiceOf(picked)
	if choice == "skip" {
		return choice, nil
	}
	return choice, RecordTrust(file, store, choice == "trust")
}

// DirectoryDefault is activateDirectoryDefault's decision for a just-trusted
// `.pi-recipe`: the recipe to activate, or the info note to show instead.
func DirectoryDefault(loaded Loaded, activeName, fileName string) (*Definition, string) {
	name := ""
	if loaded.DefaultSource == "directory" {
		name = loaded.DefaultRecipe
	}
	def := loaded.Recipes[name]
	if name == "" || def == nil {
		return nil, fileName + " is trusted; its recipes are available in /recipe (no valid defaultRecipe)"
	}
	if activeName != "" {
		return nil, fmt.Sprintf("%s is trusted; \"%s\" starts automatically on the next fresh `pi` here (active recipe \"%s\" unchanged — /recipe %s switches now)",
			fileName, name, activeName, name)
	}
	return def, ""
}

// ActivationText is notifyActivation's first notice and its level.
func ActivationText(name string, applied, warnings []string) (string, string) {
	text := fmt.Sprintf(`Recipe "%s" active`, name)
	if len(applied) > 0 {
		text += " — applied: " + strings.Join(applied, ", ")
	}
	if len(warnings) > 0 {
		return text + "; " + strings.Join(warnings, "; "), "warning"
	}
	return text, "info"
}
