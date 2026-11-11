// Package tuicr is the Go port of tuicr/core.ts and picker.ts (from
// @joelazar/pi-tuicr 1.1.0, MIT — see tuicr/UPSTREAM.md and tuicr/LICENSE):
// tuicr comment collection, base-branch detection, the target picker, and
// the editor prefill. No SDK imports.
package tuicr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Command is the tuicr executable.
const Command = "tuicr"

// Capture runs a command and returns trimmed stdout, or ok=false when it
// cannot run or exits non-zero.
type Capture func(command string, args []string, cwd string) (string, bool)

// Comment is one tuicr review comment.
type Comment struct {
	ID          string `json:"id"`
	Location    string `json:"location,omitempty"`
	Path        string `json:"path,omitempty"`
	CommentType string `json:"comment_type,omitempty"`
	Content     string `json:"content"`
}

type session struct {
	Path         string  `json:"path"`
	CommentCount float64 `json:"comment_count"`
}

func tuicrJSON(cwd string, args []string, capture Capture, out any) error {
	text, ok := capture(Command, args, cwd)
	if !ok {
		return nil
	}
	var raw any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return fmt.Errorf("%s %s printed malformed JSON: %v", Command, strings.Join(args, " "), err)
	}
	if _, isArray := raw.([]any); !isArray {
		return fmt.Errorf("%s %s did not print a JSON array", Command, strings.Join(args, " "))
	}
	return json.Unmarshal([]byte(text), out)
}

// AllComments is every comment stored in tuicr for this checkout.
func AllComments(cwd string, capture Capture) ([]Comment, error) {
	var sessions []session
	if err := tuicrJSON(cwd, []string{"review", "list", "--all"}, capture, &sessions); err != nil {
		return nil, err
	}
	var out []Comment
	for _, s := range sessions {
		if s.CommentCount <= 0 {
			continue
		}
		var comments []Comment
		if err := tuicrJSON(cwd, []string{"review", "comments", "--session", s.Path}, capture, &comments); err != nil {
			return nil, err
		}
		out = append(out, comments...)
	}
	return out, nil
}

// BaseBranch is the branch this work forked from, or "" when none verifies.
func BaseBranch(cwd string, capture Capture) string {
	var candidates []string
	if head, ok := capture("git", []string{"symbolic-ref", "--short", "refs/remotes/origin/HEAD"}, cwd); ok && head != "" {
		candidates = append(candidates, head)
	}
	candidates = append(candidates, "origin/main", "origin/master", "main", "master")
	current, _ := capture("git", []string{"rev-parse", "--abbrev-ref", "HEAD"}, cwd)
	for _, ref := range candidates {
		if ref == current {
			continue
		}
		if out, ok := capture("git", []string{"rev-parse", "--verify", "--quiet", ref}, cwd); ok && out != "" {
			return ref
		}
	}
	return ""
}

var newlinesRe = regexp.MustCompile(`\n+`)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// Format is the numbered editor prefill for fresh comments.
func Format(comments []Comment) string {
	lines := []string{"I reviewed your changes. Please address these comments:", ""}
	for i, c := range comments {
		anchor := c.Location
		if anchor == "" {
			anchor = c.Path
		}
		kind := ""
		if c.CommentType != "" && c.CommentType != "none" {
			kind = " [" + strings.ToUpper(c.CommentType) + "]"
		}
		body := newlinesRe.ReplaceAllString(strings.Trim(c.Content, jsSpace), " ")
		if anchor != "" {
			lines = append(lines, fmt.Sprintf("%d. `%s`%s - %s", i+1, anchor, kind, body))
		} else {
			lines = append(lines, fmt.Sprintf("%d.%s - %s", i+1, kind, body))
		}
	}
	return strings.Join(lines, "\n")
}

// Choice is one picker entry. Ask is set for entries that need input
// (Prompt, Hint); Build turns the answer into tuicr args.
type Choice struct {
	Label  string
	Args   []string
	Prompt string
	Hint   string
	Build  func(answer string) []string
}

// Choices are the picker entries; base-branch entries need a base.
func Choices(base string) []Choice {
	out := []Choice{{Label: "Uncommitted changes", Args: []string{"-w"}}}
	if base != "" {
		out = append(out,
			Choice{Label: "Branch vs " + base + " (+ uncommitted)", Args: []string{"-r", base + "..HEAD", "-w"}},
			Choice{Label: "Branch vs " + base, Args: []string{"-r", base + "..HEAD"}})
	}
	return append(out,
		Choice{Label: "Last commit", Args: []string{"-r", "HEAD~1..HEAD"}},
		Choice{Label: "Pick commits", Args: []string{}},
		Choice{Label: "Every tracked file", Args: []string{"-A"}},
		Choice{Label: "Custom revset...", Prompt: "Revset:", Hint: "e.g. HEAD~3..HEAD", Build: func(a string) []string { return []string{"-r", a} }},
		Choice{Label: "Pull request...", Prompt: "PR:", Hint: "number, owner/repo#N, or URL", Build: func(a string) []string { return []string{"pr", a} }})
}

// PickerTitle is the picker question.
const PickerTitle = "What should I open in tuicr?"

// FreshComments are the comments whose IDs were not in the snapshot.
func FreshComments(all []Comment, seen map[string]bool) []Comment {
	var out []Comment
	for _, c := range all {
		if !seen[c.ID] {
			out = append(out, c)
		}
	}
	return out
}

// ReadyNotice is the notice after comments load.
func ReadyNotice(n int) string {
	plural := "s"
	if n == 1 {
		plural = ""
	}
	return fmt.Sprintf("%d review comment%s ready - press enter to send", n, plural)
}
