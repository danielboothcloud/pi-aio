package goals

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
)

const (
	// ReviewTranscriptChars bounds the review transcript digest.
	ReviewTranscriptChars = 16_000
	// ReviewTranscriptMessages is the newest messages in the review digest.
	ReviewTranscriptMessages = 60
	workspaceLines           = 60
	// GitTimeoutMs bounds each git call of the workspace summary.
	GitTimeoutMs = 5_000
)

// ExecFunc runs a command in cwd with a timeout. An error is a thrown call.
type ExecFunc func(command string, args []string) (stdout string, code int, err error)

func capLines(text string, max int) string {
	lines := strings.Split(btw.TrimEnd(text), "\n")
	if len(lines) <= max {
		return strings.Join(lines, "\n")
	}
	return strings.Join(append(lines[:max:max], fmt.Sprintf("…[%d more lines]", len(lines)-max)), "\n")
}

// WorkspaceSummary is `git status --short` plus `git diff --stat HEAD`,
// bounded. It never fails.
func WorkspaceSummary(exec ExecFunc) string {
	status, code, err := exec("git", []string{"status", "--short"})
	if err != nil {
		return "(git unavailable)"
	}
	if code != 0 {
		return "(not a git repository)"
	}
	diff, diffCode, err := exec("git", []string{"diff", "--stat", "HEAD"})
	if err != nil {
		return "(git unavailable)"
	}
	short := capLines(status, workspaceLines)
	if short == "" {
		short = "(clean)"
	}
	parts := []string{"git status --short:\n" + short}
	if diffCode == 0 && btw.Trim(diff) != "" {
		parts = append(parts, "git diff --stat HEAD:\n"+capLines(diff, workspaceLines))
	}
	return strings.Join(parts, "\n\n")
}

// ReviewOutcome is a verdict, or Error for an infrastructure failure.
type ReviewOutcome struct {
	Verdict *Verdict
	Error   string
}

// ReviewInput is one goal_done claim.
type ReviewInput struct {
	Goal     Goal
	Summary  string
	Branch   []json.RawMessage
	HasModel bool
	Complete btw.CompleteFunc
	Exec     ExecFunc
	// Aborted reports the tool call's cancellation.
	Aborted func() bool
}

// ReviewGoal runs one isolated review call. It never fails: infrastructure
// failures come back as Error, never as a verdict.
func ReviewGoal(in ReviewInput) ReviewOutcome {
	if !in.HasModel {
		return ReviewOutcome{Error: "no session model is selected"}
	}
	transcript := btw.BuildFlowDigest(in.Branch, btw.FlowDigestOptions{
		MaxChars:    ReviewTranscriptChars,
		MaxMessages: ReviewTranscriptMessages,
	})
	workspace := WorkspaceSummary(in.Exec)
	response, err := in.Complete(ReviewSystemPrompt, ReviewPrompt(in.Goal, in.Summary, transcript, workspace))
	if err != nil {
		return ReviewOutcome{Error: err.Error()}
	}
	stop, _ := response["stopReason"].(string)
	if (in.Aborted != nil && in.Aborted()) || stop == "aborted" {
		return ReviewOutcome{Error: "the review was aborted"}
	}
	if stop == "error" {
		message, _ := response["errorMessage"].(string)
		if message == "" {
			message = "the review call failed"
		}
		return ReviewOutcome{Error: message}
	}
	verdict := ParseReview(btw.TextFromContent(response["content"]))
	if verdict == nil {
		return ReviewOutcome{Error: "the review reply had no APPROVED or REJECTED verdict"}
	}
	return ReviewOutcome{Verdict: verdict}
}
