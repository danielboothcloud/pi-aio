// Package initcmd is the Go port of init/: the /init command prompt that
// asks the agent to create or update AGENTS.md. It does not import the SDK.
package initcmd

import (
	"regexp"
	"strings"
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var (
	forceRe  = regexp.MustCompile(`(?i)\b(force|refresh|--force)\b`)
	dryRunRe = regexp.MustCompile(`(?i)\b(dry-run|preview|--dry-run)\b`)
)

// BuildPrompt is buildInitPrompt.
func BuildPrompt(cwd, args string) string {
	trimmed := strings.Trim(args, jsSpace)
	force, dryRun := forceRe.MatchString(trimmed), dryRunRe.MatchString(trimmed)
	mode := "- **Write mode**: create or update AGENTS.md on disk."
	verb := "create or update"
	finish := "Write the file(s), summarize what changed, and remind the user to run `/reload` so Pi loads the new context."
	if dryRun {
		mode = "- **Dry run**: analyze the project and show the AGENTS.md you would write. Do not create or modify files."
		verb = "draft"
		finish = "Show the proposed AGENTS.md in your response and list any subproject files you would also create."
	}
	if force {
		mode += "\n- **Force refresh**: regenerate even if AGENTS.md already exists; preserve accurate sections where possible."
	} else {
		mode += "\n- **Update in place**: if AGENTS.md exists, merge improvements into it instead of replacing wholesale."
	}
	userArgs := ""
	if trimmed != "" {
		userArgs = "User args: " + trimmed + "\n"
	}
	return strings.NewReplacer("{{VERB}}", verb, "{{CWD}}", cwd, "{{ARGS}}", userArgs, "{{MODE}}", mode, "{{FINISH}}", finish).Replace(template)
}
