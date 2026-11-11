package frame

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitStatus is GitFrameStatus.
type GitStatus struct {
	Branch string `json:"branch,omitempty"`
	Dirty  bool   `json:"dirty"`
	Ahead  int    `json:"ahead"`
	Behind int    `json:"behind"`
}

// GitReadKind is the kind of a GitFrameReadResult: "ok", "not_a_repo", or
// "error".
type GitReadResult struct {
	Kind   string     `json:"kind"`
	Status *GitStatus `json:"status,omitempty"`
}

var (
	lineBreak = regexp.MustCompile(`\r?\n`)
	abCounts  = regexp.MustCompile(`\+(\d+)\s+-(\d+)`)
	notARepo  = regexp.MustCompile(`(?i)not a git repository|outside repository|not a git repo`)
)

// ParseGitStatus is parseGitFrameStatus over `git status --porcelain=2
// --branch` output.
func ParseGitStatus(stdout string) GitStatus {
	var s GitStatus
	for _, line := range lineBreak.Split(stdout, -1) {
		if line == "" {
			continue
		}
		if rest, ok := strings.CutPrefix(line, "# branch.head "); ok {
			branch := strings.TrimSpace(rest)
			if branch == "(detached)" {
				branch = ""
			}
			s.Branch = branch
			continue
		}
		if strings.HasPrefix(line, "# branch.ab ") {
			if m := abCounts.FindStringSubmatch(line); m != nil {
				s.Ahead, _ = strconv.Atoi(m[1])
				s.Behind, _ = strconv.Atoi(m[2])
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		s.Dirty = true
	}
	return s
}

// GitRunner runs git with args in cwd. err is nil on success; on failure
// message is the text Node's execFile error carries (its message plus the
// command's stderr).
type GitRunner func(cwd string, args ...string) (stdout string, message string, err error)

// GitCommandTimeout is GIT_COMMAND_TIMEOUT_MS.
const GitCommandTimeout = 2 * time.Second

// ExecGit runs the real git binary (the default GitRunner).
func ExecGit(cwd string, args ...string) (string, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), GitCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.String(), "Command failed: git " + strings.Join(args, " ") + "\n" + stderr.String(), err
	}
	return stdout.String(), "", nil
}

// ReadGitStatus is readGitFrameStatus through run.
func ReadGitStatus(cwd string, run GitRunner) GitReadResult {
	stdout, message, err := run(cwd, "status", "--porcelain=2", "--branch")
	if err == nil {
		status := ParseGitStatus(stdout)
		return GitReadResult{Kind: "ok", Status: &status}
	}
	if notARepo.MatchString(message) {
		return GitReadResult{Kind: "not_a_repo"}
	}
	stdout, message, err = run(cwd, "rev-parse", "--is-inside-work-tree")
	if err == nil {
		if strings.TrimSpace(stdout) == "true" {
			return GitReadResult{Kind: "error"}
		}
		return GitReadResult{Kind: "not_a_repo"}
	}
	if notARepo.MatchString(message) {
		return GitReadResult{Kind: "not_a_repo"}
	}
	return GitReadResult{Kind: "error"}
}
