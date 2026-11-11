// Package toolpaths is the Go port of yaml-hooks/tool-paths.ts: which tools
// mutate files and which paths a write/edit/apply_patch/bash call touched.
// nvim uses it now; the yaml-hooks port will share it. No SDK imports.
package toolpaths

import (
	"regexp"
	"strings"
)

// Change is one file change.
type Change struct {
	Operation string `json:"operation"` // "create", "modify", "delete", or "rename"
	Path      string `json:"path,omitempty"`
	FromPath  string `json:"fromPath,omitempty"`
	ToPath    string `json:"toPath,omitempty"`
}

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// NormalizeTool maps a tool name to write/edit/multiedit/apply_patch/bash, or "".
func NormalizeTool(name string) string {
	switch name {
	case "write", "edit", "multiedit", "bash":
		return name
	case "patch", "apply_patch":
		return "apply_patch"
	}
	return ""
}

func pick(values ...any) string {
	for _, v := range values {
		if s, ok := v.(string); ok && strings.Trim(s, jsSpace) != "" {
			return s
		}
	}
	return ""
}

// FileChanges is getToolFileChanges.
func FileChanges(tool string, args map[string]any) []Change {
	switch NormalizeTool(tool) {
	case "":
		return nil
	case "apply_patch":
		if text := pick(args["patchText"], args["patch"], args["diff"], args["input"]); text != "" {
			return parsePatch(text)
		}
		return nil
	case "bash":
		if command := pick(args["command"], args["cmd"]); command != "" {
			return ParseBash(command)
		}
		return nil
	case "multiedit", "edit":
		if changes := editsArray(args); len(changes) > 0 {
			return changes
		}
	}
	if change, ok := direct(args, ""); ok {
		return []Change{change}
	}
	return nil
}

// ChangedPaths is getChangedPaths: unique paths in first-seen order.
func ChangedPaths(changes []Change) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, c := range changes {
		if c.Operation == "rename" {
			add(c.FromPath)
			add(c.ToPath)
			continue
		}
		add(c.Path)
	}
	return out
}

// StructuredChanges is applyPatchStructuredChanges (aio's `changes` array).
func StructuredChanges(args map[string]any) []Change {
	raw, ok := args["changes"].([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	var out []Change
	for _, entry := range raw {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		path := pick(record["path"], record["movePath"])
		if path == "" {
			continue
		}
		action := pick(record["action"])
		if action == "" {
			action = "update"
		}
		from := pick(record["fromPath"])
		switch {
		case action == "move" && from != "" && from != path:
			out = append(out, Change{Operation: "rename", FromPath: from, ToPath: path})
		case action == "add":
			out = append(out, Change{Operation: "create", Path: path})
		case action == "delete":
			out = append(out, Change{Operation: "delete", Path: path})
		default:
			out = append(out, Change{Operation: "modify", Path: path})
		}
	}
	return out
}

func editsArray(args map[string]any) []Change {
	edits, ok := args["edits"].([]any)
	if !ok || len(edits) == 0 {
		return nil
	}
	top := pick(args["filePath"], args["file_path"], args["path"], args["file"])
	var out []Change
	seen := map[string]bool{}
	for _, raw := range edits {
		edit, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		change, ok := direct(edit, top)
		if !ok {
			continue
		}
		key := change.Operation + ":" + change.Path
		if change.Operation == "rename" {
			key = "rename:" + change.FromPath + "->" + change.ToPath
		}
		if !seen[key] {
			seen[key] = true
			out = append(out, change)
		}
	}
	return out
}

func direct(args map[string]any, fallback string) (Change, bool) {
	path := pick(args["filePath"], args["file_path"], args["path"], args["file"])
	if path == "" {
		path = fallback
	}
	if path == "" {
		return Change{}, false
	}
	source := pick(args["sourcePath"], args["fromPath"])
	destination := pick(args["move"], args["rename"], args["toPath"])
	if source != "" && source != path {
		return Change{Operation: "rename", FromPath: source, ToPath: path}, true
	}
	if destination != "" && destination != path {
		return Change{Operation: "rename", FromPath: path, ToPath: destination}, true
	}
	if op := pick(args["op"], args["operation"]); op == "create" || op == "delete" {
		return Change{Operation: op, Path: path}, true
	}
	return Change{Operation: "modify", Path: path}, true
}

var (
	addRe    = regexp.MustCompile(`^\*\*\* Add File: (.+)$`)
	deleteRe = regexp.MustCompile(`^\*\*\* Delete File: (.+)$`)
	updateRe = regexp.MustCompile(`^\*\*\* Update File: (.+)$`)
	moveRe   = regexp.MustCompile(`^\*\*\* Move to: (.+)$`)
)

func parsePatch(text string) []Change {
	var out []Change
	pending := ""
	flush := func() {
		if pending != "" {
			out = append(out, Change{Operation: "modify", Path: pending})
			pending = ""
		}
	}
	trim := func(s string) string { return strings.Trim(s, jsSpace) }
	for _, line := range strings.Split(text, "\n") {
		if m := addRe.FindStringSubmatch(line); m != nil {
			flush()
			out = append(out, Change{Operation: "create", Path: trim(m[1])})
			continue
		}
		if m := deleteRe.FindStringSubmatch(line); m != nil {
			flush()
			out = append(out, Change{Operation: "delete", Path: trim(m[1])})
			continue
		}
		if m := updateRe.FindStringSubmatch(line); m != nil {
			flush()
			pending = trim(m[1])
			continue
		}
		if m := moveRe.FindStringSubmatch(line); m != nil && pending != "" {
			out = append(out, Change{Operation: "rename", FromPath: pending, ToPath: trim(m[1])})
			pending = ""
		}
	}
	flush()
	return out
}

var splitRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*(?:&&|\|\||;)[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*`)

func isJSSpace(r rune) bool { return strings.ContainsRune(jsSpace, r) }

func tokenize(segment string) []string {
	var tokens []string
	var current strings.Builder
	single, double, escape := false, false, false
	for _, ch := range segment {
		switch {
		case escape:
			current.WriteRune(ch)
			escape = false
		case ch == '\\' && !single:
			escape = true
		case ch == '\'' && !double:
			single = !single
		case ch == '"' && !single:
			double = !double
		case isJSSpace(ch) && !single && !double:
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(ch)
		}
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func pathArgs(tokens []string, start int) []string {
	var out []string
	positional := false
	for _, token := range tokens[min(start, len(tokens)):] {
		switch {
		case positional:
			out = append(out, token)
		case token == "--":
			positional = true
		case strings.HasPrefix(token, "-"):
		default:
			out = append(out, token)
		}
	}
	return out
}

// ParseBash is parseBashChanges: rm/git rm, mv/git mv, cp/git cp, touch, mkdir.
func ParseBash(command string) []Change {
	var out []Change
	for _, segment := range splitRe.Split(command, -1) {
		tokens := tokenize(segment)
		if len(tokens) == 0 {
			continue
		}
		cmd := tokens[0]
		git := func(sub string) bool { return cmd == "git" && len(tokens) > 1 && tokens[1] == sub }
		start := 1
		if cmd == "git" {
			start = 2
		}
		switch {
		case cmd == "rm" || git("rm"):
			for _, p := range pathArgs(tokens, start) {
				out = append(out, Change{Operation: "delete", Path: p})
			}
		case cmd == "mv" || git("mv"):
			if paths := pathArgs(tokens, start); len(paths) >= 2 {
				dest := paths[len(paths)-1]
				for _, src := range paths[:len(paths)-1] {
					out = append(out, Change{Operation: "rename", FromPath: src, ToPath: dest})
				}
			}
		case cmd == "cp" || git("cp"):
			if paths := pathArgs(tokens, start); len(paths) >= 2 {
				out = append(out, Change{Operation: "create", Path: paths[len(paths)-1]})
			}
		case cmd == "touch" || cmd == "mkdir":
			for _, p := range pathArgs(tokens, 1) {
				out = append(out, Change{Operation: "create", Path: p})
			}
		}
	}
	return out
}
