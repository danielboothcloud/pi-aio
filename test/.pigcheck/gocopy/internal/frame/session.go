package frame

import "sync"

// HostSnapshot is what registerFrameEditor's getMetadata reads from the
// context: cwd, the model id (empty without a model), the thinking level,
// the context percent, the session name, and the session entries.
type HostSnapshot struct {
	Cwd            string
	ModelID        string
	ThinkingLevel  string
	ContextPercent *float64
	SessionName    string
	Entries        []map[string]any
}

// Session is the per-session state of registerFrameEditor: the git
// snapshot and the agent run clock.
type Session struct {
	mu          sync.Mutex
	git         GitStatus
	agentStart  *float64
	agentActive bool
}

// Reset is the session_start/session_shutdown reset.
func (s *Session) Reset() {
	s.mu.Lock()
	s.git, s.agentStart, s.agentActive = GitStatus{}, nil, false
	s.mu.Unlock()
}

// SetGit stores a git read.
func (s *Session) SetGit(status GitStatus) {
	s.mu.Lock()
	s.git = status
	s.mu.Unlock()
}

// AgentStart is the agent_start handler (now is epoch ms).
func (s *Session) AgentStart(now float64) {
	s.mu.Lock()
	s.agentStart, s.agentActive = &now, true
	s.mu.Unlock()
}

// AgentEnd is the agent_end handler: the clock keeps its start.
func (s *Session) AgentEnd() {
	s.mu.Lock()
	s.agentActive = false
	s.mu.Unlock()
}

// AgentActive reports a running agent.
func (s *Session) AgentActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.agentActive
}

// Metadata is getMetadata: the frame's own metadata, the feature
// contributions, then the Codex quota.
func (s *Session) Metadata(h HostSnapshot, now float64, codex *CodexQuota) Metadata {
	s.mu.Lock()
	git, start, active := s.git, s.agentStart, s.agentActive
	s.mu.Unlock()
	model := h.ModelID
	if model == "" {
		model = "no-model"
	}
	m := Metadata{
		Cwd:            h.Cwd,
		Branch:         git.Branch,
		Dirty:          git.Dirty,
		Ahead:          git.Ahead,
		Behind:         git.Behind,
		CostLabel:      BuildCostLabel(ComputeUsageTotals(h.Entries)),
		ModelLabel:     model,
		ThinkingLevel:  h.ThinkingLevel,
		ContextPercent: h.ContextPercent,
		SessionName:    h.SessionName,
		AgentActive:    active,
	}
	if start != nil {
		elapsed := now - *start
		m.AgentDurationMs = &elapsed
	}
	m = m.Apply(ContributedMetadata())
	if codex != nil {
		if text := CodexQuotaText(codex); text != "" {
			m.CodexQuota = &Tinted{Text: text, Role: CodexQuotaRole(*codex)}
		}
	}
	return m
}
