package yamlhooks

// Path conditions (port of yaml-hooks/path-filter.ts): matchesCodeFiles,
// matchesAnyPath, and matchesAllPaths over project-relative globs.

import (
	"strings"
)

var codeExtensions = map[string]bool{}

func init() {
	for _, ext := range strings.Fields(`.ts .tsx .mts .cts .js .jsx .mjs .cjs
		.json .jsonc .json5 .yml .yaml .toml .xml .ini
		.cfg .conf .properties .css .scss .sass .less
		.html .vue .svelte .astro .mdx .graphql .gql
		.proto .sql .prisma .go .rs .zig .c .h .cpp
		.cc .cxx .hpp .java .groovy .gradle .py .rb
		.php .sh .bash .zsh .fish .ps1 .psm1 .psd1
		.bat .cmd .kt .kts .swift .m .mm .cs .fs
		.scala .clj .hs .lua .dart .elm .ex .exs
		.erl .hrl .nim .nix .r .rkt .tf .tfvars`) {
		codeExtensions[ext] = true
	}
}

// extname is Node's path.posix.extname.
func extname(p string) string {
	startDot, startPart, end := -1, 0, -1
	matchedSlash := true
	preDotState := 0
	for i := len(p) - 1; i >= 0; i-- {
		c := p[i]
		if c == '/' {
			if !matchedSlash {
				startPart = i + 1
				break
			}
			continue
		}
		if end == -1 {
			matchedSlash = false
			end = i + 1
		}
		if c == '.' {
			if startDot == -1 {
				startDot = i
			} else if preDotState != 1 {
				preDotState = 1
			}
		} else if startDot != -1 {
			preDotState = -1
		}
	}
	if startDot == -1 || end == -1 || preDotState == 0 || (preDotState == 1 && startDot == end-1 && startDot == startPart+1) {
		return ""
	}
	return p[startDot:end]
}

// HasCodeExtension is path-filter.ts hasCodeExtension.
func HasCodeExtension(p string) bool {
	ext := strings.ToLower(extname(p))
	return ext != "" && codeExtensions[ext]
}

// PathMatchContext is path-filter.ts PathMatchContext.
type PathMatchContext struct {
	ChangedPaths []string
	HasCodeFiles bool
}

// ConditionFailure is PathConditionFailure; Patterns is nil when absent.
type ConditionFailure struct {
	Reason   string
	Patterns []string
}

// EvaluatePathConditions is path-filter.ts evaluatePathConditions.
func EvaluatePathConditions(conditions []Condition, ctx PathMatchContext) *ConditionFailure {
	return evaluatePathConditions(conditions, ctx, globNocase)
}

func evaluatePathConditions(conditions []Condition, ctx PathMatchContext, nocase bool) *ConditionFailure {
	anyMatch := func(file string, patterns []string) bool {
		for _, p := range patterns {
			if matchGlob(file, p, nocase) {
				return true
			}
		}
		return false
	}
	for _, c := range conditions {
		if c.Legacy == "matchesCodeFiles" {
			if !ctx.HasCodeFiles {
				return &ConditionFailure{Reason: "matchesCodeFiles_failed"}
			}
			continue
		}
		if c.Key == "matchesAnyPath" {
			if len(ctx.ChangedPaths) == 0 {
				return &ConditionFailure{Reason: "matchesAnyPath_no_paths", Patterns: c.Patterns}
			}
			matched := false
			for _, f := range ctx.ChangedPaths {
				if anyMatch(f, c.Patterns) {
					matched = true
					break
				}
			}
			if !matched {
				return &ConditionFailure{Reason: "matchesAnyPath_failed", Patterns: c.Patterns}
			}
			continue
		}
		if len(ctx.ChangedPaths) == 0 {
			return &ConditionFailure{Reason: "matchesAllPaths_no_paths", Patterns: c.Patterns}
		}
		for _, f := range ctx.ChangedPaths {
			if !anyMatch(f, c.Patterns) {
				return &ConditionFailure{Reason: "matchesAllPaths_failed", Patterns: c.Patterns}
			}
		}
	}
	return nil
}

// BuildPathMatchContext is path-filter.ts buildPathMatchContext. changes
// nil means absent.
func BuildPathMatchContext(projectDir string, files []string, changes []FileChange) PathMatchContext {
	paths := getFinalChangedPaths(projectDir, files, changes)
	has := false
	for _, p := range paths {
		if HasCodeExtension(p) {
			has = true
			break
		}
	}
	if paths == nil {
		paths = []string{}
	}
	return PathMatchContext{ChangedPaths: paths, HasCodeFiles: has}
}

func getFinalChangedPaths(projectDir string, files []string, changes []FileChange) []string {
	if len(changes) > 0 {
		out := make([]string, len(changes))
		for i, c := range changes {
			p := c.Path
			if c.Operation == "rename" {
				p = c.ToPath
				if p == "" {
					p = c.Path
				}
			}
			out[i] = NormalizeConditionPath(projectDir, p)
		}
		return out
	}
	out := make([]string, len(files))
	for i, f := range files {
		out[i] = NormalizeConditionPath(projectDir, f)
	}
	return out
}

// NormalizeConditionPath is path-filter.ts normalizeConditionPath.
func NormalizeConditionPath(projectDir, filePath string) string {
	normalized := normalizeGlobCandidate(filePath)
	if !strings.HasPrefix(filePath, "/") {
		return normalized
	}
	rel := normalizeGlobCandidate(relativePath(projectDir, filePath))
	if rel != "" && rel != "." && !strings.HasPrefix(rel, "../") {
		return rel
	}
	return normalized
}

func normalizeGlobCandidate(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	return strings.TrimPrefix(p, "./")
}
