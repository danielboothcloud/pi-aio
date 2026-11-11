package yamlhooks

// Per-session state (port of yaml-hooks/session-state.ts): scope
// evaluation, pending tool calls (TTL and cap), and file changes collected
// for session.idle. The store has its own lock; parent lookups run without
// it held.

import (
	"sync"
	"time"
)

const (
	maxDeletedTombstones = 256
	maxPendingToolCalls  = 1000
	pendingToolCallTTL   = 5 * time.Minute
)

type pendingToolCall struct {
	callID    string
	sessionID string
	toolArgs  *Object
	inserted  time.Time
}

type changeEntry struct {
	key    string
	change FileChange
}

type sessionRecord struct {
	parentID      *string // nil: unknown; "": no parent (null)
	rootSessionID string
	changes       []changeEntry
	activeIdle    map[string]bool
	replayedIdle  map[string]bool
}

func (r *sessionRecord) hasChange(key string) bool {
	for _, c := range r.changes {
		if c.key == key {
			return true
		}
	}
	return false
}

func (r *sessionRecord) deleteChange(key string) {
	for i, c := range r.changes {
		if c.key == key {
			r.changes = append(r.changes[:i:i], r.changes[i+1:]...)
			return
		}
	}
}

// SessionState is SessionStateStore.
type SessionState struct {
	mu         sync.Mutex
	sessions   map[string]*sessionRecord
	pending    []pendingToolCall
	tombstones []string
	now        func() time.Time
}

// NewSessionState returns an empty store; now is nil for time.Now.
func NewSessionState(now func() time.Time) *SessionState {
	if now == nil {
		now = time.Now
	}
	return &SessionState{sessions: map[string]*sessionRecord{}, now: now}
}

func (s *SessionState) getOrCreate(id string) *sessionRecord {
	r := s.sessions[id]
	if r == nil {
		r = &sessionRecord{replayedIdle: map[string]bool{}}
		s.sessions[id] = r
	}
	return r
}

// RememberSession is rememberSession; parentID nil leaves the parent as is.
func (s *SessionState) RememberSession(id string, parentID *string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.getOrCreate(id)
	if parentID != nil {
		p := *parentID
		r.parentID = &p
	}
}

// ParentResolver returns a session's parent id, "" for none.
type ParentResolver func(sessionID string) string

// EvaluateScope is evaluateScope.
func (s *SessionState) EvaluateScope(sessionID, scope string, resolve ParentResolver) bool {
	if scope == "all" {
		return true
	}
	root := s.GetRootSessionID(sessionID, resolve)
	isMain := root == sessionID
	if scope == "main" {
		return isMain
	}
	return !isMain
}

// GetRootSessionID is getRootSessionID.
func (s *SessionState) GetRootSessionID(sessionID string, resolve ParentResolver) string {
	return s.resolveRoot(sessionID, resolve, map[string]bool{}, true)
}

func (s *SessionState) resolveRoot(id string, resolve ParentResolver, visited map[string]bool, original bool) string {
	if visited[id] {
		if original {
			s.mu.Lock()
			s.getOrCreate(id).rootSessionID = id
			s.mu.Unlock()
		}
		return id
	}
	visited[id] = true
	s.mu.Lock()
	var record *sessionRecord
	if original {
		record = s.getOrCreate(id)
	} else {
		record = s.sessions[id]
	}
	var parent *string
	if record != nil && record.parentID != nil {
		p := *record.parentID
		parent = &p
	}
	s.mu.Unlock()
	if parent == nil {
		p := resolve(id)
		parent = &p
		if record != nil {
			s.mu.Lock()
			record.parentID = &p
			s.mu.Unlock()
		}
	}
	if *parent == "" {
		if record != nil {
			s.mu.Lock()
			record.rootSessionID = id
			s.mu.Unlock()
		}
		return id
	}
	s.mu.Lock()
	if record != nil && record.rootSessionID != "" {
		if pr := s.sessions[*parent]; pr != nil && pr.rootSessionID != "" && pr.rootSessionID == record.rootSessionID {
			root := record.rootSessionID
			s.mu.Unlock()
			return root
		}
	}
	s.mu.Unlock()
	root := s.resolveRoot(*parent, resolve, visited, false)
	if record != nil {
		s.mu.Lock()
		record.rootSessionID = root
		s.mu.Unlock()
	}
	return root
}

// IsDeleted is isDeleted.
func (s *SessionState) IsDeleted(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[id]; ok {
		return false
	}
	for _, t := range s.tombstones {
		if t == id {
			return true
		}
	}
	return false
}

// DeleteSession is deleteSession.
func (s *SessionState) DeleteSession(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.pending[:0]
	for _, p := range s.pending {
		if p.sessionID != id {
			kept = append(kept, p)
		}
	}
	s.pending = kept
	delete(s.sessions, id)
	for _, t := range s.tombstones {
		if t == id {
			return
		}
	}
	s.tombstones = append(s.tombstones, id)
	if len(s.tombstones) > maxDeletedTombstones {
		s.tombstones = s.tombstones[1:]
	}
}

// SetPendingToolCall is setPendingToolCall.
func (s *SessionState) SetPendingToolCall(callID, sessionID string, args *Object) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) > 0 {
		cutoff := s.now().Add(-pendingToolCallTTL)
		for len(s.pending) > 0 && s.pending[0].inserted.Before(cutoff) {
			s.pending = s.pending[1:]
		}
	}
	if len(s.pending) >= maxPendingToolCalls {
		s.pending = s.pending[1:]
	}
	for i, p := range s.pending {
		if p.callID == callID {
			// Map.set on an existing key keeps its position.
			s.pending[i] = pendingToolCall{callID, sessionID, args, s.now()}
			return
		}
	}
	s.pending = append(s.pending, pendingToolCall{callID, sessionID, args, s.now()})
}

// ConsumePendingToolCall is consumePendingToolCall: the call's session
// and arguments, once.
func (s *SessionState) ConsumePendingToolCall(callID string) (string, *Object, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.pending {
		if p.callID == callID {
			s.pending = append(s.pending[:i:i], s.pending[i+1:]...)
			return p.sessionID, p.toolArgs, true
		}
	}
	return "", nil, false
}

// PendingToolCallCount is pendingToolCallCount.
func (s *SessionState) PendingToolCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

func serializeFileChange(c FileChange) string {
	if c.Operation == "rename" {
		return c.Operation + ":" + c.FromPath + "->" + c.ToPath
	}
	return c.Operation + ":" + c.Path
}

// AddFileChanges is addFileChanges.
func (s *SessionState) AddFileChanges(id string, changes []FileChange) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.getOrCreate(id)
	for _, c := range changes {
		key := serializeFileChange(c)
		if r.activeIdle[key] {
			r.replayedIdle[key] = true
		}
		if !r.hasChange(key) {
			r.changes = append(r.changes, changeEntry{key, c})
		}
	}
}

// GetFileChanges is getFileChanges.
func (s *SessionState) GetFileChanges(id string) []FileChange {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.sessions[id]
	if r == nil || len(r.changes) == 0 {
		return []FileChange{}
	}
	out := make([]FileChange, len(r.changes))
	for i, c := range r.changes {
		out[i] = c.change
	}
	return out
}

// GetModifiedPaths is getModifiedPaths.
func (s *SessionState) GetModifiedPaths(id string) []string {
	paths := changedPaths(s.GetFileChanges(id))
	if paths == nil {
		return []string{}
	}
	return paths
}

// BeginIdleDispatch is beginIdleDispatch.
func (s *SessionState) BeginIdleDispatch(id string, changes []FileChange) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.getOrCreate(id)
	r.activeIdle = map[string]bool{}
	for _, c := range changes {
		r.activeIdle[serializeFileChange(c)] = true
	}
	r.replayedIdle = map[string]bool{}
}

// ConsumeFileChanges is consumeFileChanges.
func (s *SessionState) ConsumeFileChanges(id string, changes []FileChange) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.sessions[id]
	if r == nil {
		return
	}
	for _, c := range changes {
		key := serializeFileChange(c)
		replayed := r.replayedIdle[key]
		r.deleteChange(key)
		if replayed {
			r.changes = append(r.changes, changeEntry{key, c})
		}
	}
	r.activeIdle = nil
	r.replayedIdle = map[string]bool{}
}

// changedPaths is session-state.ts getChangedPaths.
func changedPaths(changes []FileChange) []string {
	set := newOrderedSet()
	for _, c := range changes {
		if c.Operation == "rename" {
			if c.FromPath != "" {
				set.add(c.FromPath)
			}
			if c.ToPath != "" {
				set.add(c.ToPath)
			}
			continue
		}
		if c.Path != "" {
			set.add(c.Path)
		}
	}
	return set.items
}
