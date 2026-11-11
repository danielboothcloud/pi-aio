package subagents

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// TestManualResumeContinuesTheSavedSession follows resumeSubagentChild: a
// failed child resumes as a new single-child run on its own saved session,
// the original run stays unchanged, and the ancestor cannot resume again.
func TestManualResumeContinuesTheSavedSession(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	fixture, _ := filepath.Abs(filepath.Join("..", "..", "..", "subagents", "test-fixture-child.mjs"))
	root := t.TempDir()
	deps := &Deps{Binary: node, ArgsPrefix: []string{fixture}, RunsBaseDir: filepath.Join(root, "runs"),
		MaxAttempts: iptr(1), RetryBackoffMs: fptr(0), TerminationGraceMs: fptr(200), SettleExitGraceMs: fptr(300)}
	agent := AgentConfig{Name: "worker", Description: "d", SystemPrompt: "Work.", SystemPromptMode: "replace", Source: "builtin", FilePath: "/w.md"}
	reg := NewRegistry()
	run, err := reg.Execute(RunInput{Request: Request{Agent: sptr("worker"), Task: sptr("quota-once")}, Agents: []AgentConfig{agent},
		Parent: Parent{Cwd: root, ExtensionLaunch: &ExtensionLaunch{Paths: []string{}}}, Deps: deps}, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg.Mu.Lock()
	child := run.Children[0]
	if run.State != "failed" || child.State != "failed" || child.SessionFile == "" {
		t.Fatalf("first run: %s/%s session %q", run.State, child.State, child.SessionFile)
	}
	if reason := reg.ResumeUnavailable(run, child); reason != "" {
		t.Fatalf("failed child cannot resume: %s", reason)
	}
	reg.Mu.Unlock()

	var updates int
	continuation, err := reg.Resume(ResumeInput{Run: run, Child: child, Deps: deps, OnUpdate: func(*Run) { updates++ }})
	if err != nil {
		t.Fatal(err)
	}
	reg.Mu.Lock()
	defer reg.Mu.Unlock()
	if continuation.State != "completed" || continuation.ResumedFrom == nil || continuation.ResumedFrom.RunID != run.ID {
		t.Fatalf("continuation %s from %+v", continuation.State, continuation.ResumedFrom)
	}
	if got := *continuation.Children[0].Output; got != "completed:"+ContinuationPrompt("quota-once") {
		t.Errorf("continuation output %q", got)
	}
	if continuation.Children[0].SessionFile != child.SessionFile {
		t.Errorf("continuation session %q, want the saved %q", continuation.Children[0].SessionFile, child.SessionFile)
	}
	if run.State != "failed" || child.State != "failed" {
		t.Errorf("the original run changed: %s/%s", run.State, child.State)
	}
	if reason := reg.ResumeUnavailable(run, child); reason != "Already resumed; select the latest continuation run." {
		t.Errorf("ancestor resume: %q", reason)
	}
	if runID, _, ok := reg.ChildSessionOwner(child.SessionFile); !ok || runID != continuation.ID {
		t.Errorf("session owner %q, want the continuation", runID)
	}
	if updates == 0 {
		t.Error("no continuation updates")
	}
	notices := continuation.Children[0].Transcript.Entries
	if len(notices) == 0 || notices[len(notices)-1].Text != "completed" {
		t.Errorf("continuation transcript ends with %+v", notices[len(notices)-1])
	}
}
