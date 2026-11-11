package yamlhooks

// Core hook types (port of yaml-hooks/types.ts).

import (
	"regexp"
	"slices"

	"github.com/danielboothcloud/pi-aio/go/internal/toolpaths"
)

// FileChange is one file change (types.ts FileChange).
type FileChange = toolpaths.Change

var (
	sessionHookEvents = []string{"session.idle", "session.created", "session.deleted", "file.changed"}
	promptHookEvents  = []string{"user.prompt.submit"}
	toolEventPattern  = regexp.MustCompile(`^tool\.(before|after)\.(\*|.+)$`)
)

// ValidationError is HookValidationError. Path is "" when absent.
type ValidationError struct {
	Code     string `json:"code"`
	FilePath string `json:"filePath"`
	Message  string `json:"message"`
	Path     string `json:"path,omitempty"`
}

// Source is HookConfigSource.
type Source struct {
	FilePath string `json:"filePath"`
	Index    int    `json:"index"`
}

// AsyncConfig is a hook's async setting: `true` or { group?, concurrency? }.
type AsyncConfig struct {
	True        bool
	Group       *string
	Concurrency *int
}

// Condition is one hook condition: the legacy "matchesCodeFiles" string or
// a path condition (Key is matchesAnyPath or matchesAllPaths).
type Condition struct {
	Legacy   string
	Key      string
	Patterns []string
}

// Action is one hook action; Kind is the single key it carries (command,
// tool, bash, notify, confirm, or setStatus). Short is true for the string
// short form.
type Action struct {
	Kind  string
	Short bool
	// command/tool: Name, Args (command args string; tool args object).
	Name        string
	CommandArgs *string
	ToolArgs    *Object
	// bash: Command, Timeout (ms).
	Command string
	Timeout *float64
	// notify/setStatus: Text, Level; confirm: Title, Message.
	Text    string
	Level   *string
	Title   *string
	Message string
}

// HookConfig is one validated hook. Pointer identity is the hook identity
// (TypeScript compares hook objects).
type HookConfig struct {
	ID         *string
	Event      string
	Action     string // "" or "stop"
	Actions    []Action
	Scope      string
	RunIn      string
	Async      *AsyncConfig
	Conditions []Condition // nil when absent
	HasConds   bool
	Source     Source
}

// Override is HookOverrideEntry.
type Override struct {
	TargetID    string
	Disable     bool
	Replacement *HookConfig
	Source      Source
}

// HookMap is Map<HookEvent, HookConfig[]> with its insertion order.
type HookMap struct {
	events  []string
	buckets map[string][]*HookConfig
}

// NewHookMap returns an empty map.
func NewHookMap() *HookMap { return &HookMap{buckets: map[string][]*HookConfig{}} }

// Get returns the hooks for event.
func (m *HookMap) Get(event string) []*HookConfig {
	if m == nil {
		return nil
	}
	return m.buckets[event]
}

// Has reports whether event has a bucket.
func (m *HookMap) Has(event string) bool {
	if m == nil {
		return false
	}
	_, ok := m.buckets[event]
	return ok
}

// Set replaces the bucket; a new event goes last.
func (m *HookMap) Set(event string, hooks []*HookConfig) {
	if _, ok := m.buckets[event]; !ok {
		m.events = append(m.events, event)
	}
	m.buckets[event] = hooks
}

// Delete removes the bucket.
func (m *HookMap) Delete(event string) {
	if _, ok := m.buckets[event]; !ok {
		return
	}
	delete(m.buckets, event)
	m.events = slices.DeleteFunc(m.events, func(e string) bool { return e == event })
}

// Events returns the events in insertion order.
func (m *HookMap) Events() []string {
	if m == nil {
		return nil
	}
	return m.events
}

// Size is the number of buckets.
func (m *HookMap) Size() int {
	if m == nil {
		return 0
	}
	return len(m.events)
}

// isHookEvent is types.ts isHookEvent.
func isHookEvent(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	return slices.Contains(sessionHookEvents, s) || slices.Contains(promptHookEvents, s) || toolEventPattern.MatchString(s)
}

// ToJSON returns the hook as TypeScript builds the object (key order kept).
func (h *HookConfig) ToJSON() *Object {
	o := &Object{Values: map[string]any{}}
	if h.ID != nil {
		o.Set("id", *h.ID)
	}
	o.Set("event", h.Event)
	if h.Action != "" {
		o.Set("action", h.Action)
	}
	actions := make([]any, len(h.Actions))
	for i, a := range h.Actions {
		actions[i] = a.ToJSON()
	}
	o.Set("actions", actions)
	o.Set("scope", h.Scope)
	o.Set("runIn", h.RunIn)
	if h.Async != nil {
		if h.Async.True {
			o.Set("async", true)
		} else {
			a := &Object{Values: map[string]any{}}
			if h.Async.Group != nil {
				a.Set("group", *h.Async.Group)
			}
			if h.Async.Concurrency != nil {
				a.Set("concurrency", float64(*h.Async.Concurrency))
			}
			o.Set("async", a)
		}
	}
	if h.HasConds {
		conds := make([]any, len(h.Conditions))
		for i, c := range h.Conditions {
			if c.Legacy != "" {
				conds[i] = c.Legacy
				continue
			}
			patterns := make([]any, len(c.Patterns))
			for j, p := range c.Patterns {
				patterns[j] = p
			}
			conds[i] = NewObject(c.Key, patterns)
		}
		o.Set("conditions", conds)
	}
	o.Set("source", NewObject("filePath", h.Source.FilePath, "index", float64(h.Source.Index)))
	return o
}

// ToJSON returns the action object as written in TypeScript.
func (a Action) ToJSON() *Object {
	var inner any
	switch a.Kind {
	case "command":
		if a.Short {
			inner = a.Name
		} else {
			o := NewObject("name", a.Name)
			if a.CommandArgs != nil {
				o.Set("args", *a.CommandArgs)
			}
			inner = o
		}
	case "tool":
		o := NewObject("name", a.Name)
		if a.ToolArgs != nil {
			o.Set("args", a.ToolArgs)
		}
		inner = o
	case "bash":
		if a.Short {
			inner = a.Command
		} else {
			o := NewObject("command", a.Command)
			if a.Timeout != nil {
				o.Set("timeout", *a.Timeout)
			}
			inner = o
		}
	case "notify":
		if a.Short {
			inner = a.Text
		} else {
			o := NewObject("text", a.Text)
			if a.Level != nil {
				o.Set("level", *a.Level)
			}
			inner = o
		}
	case "confirm":
		o := &Object{Values: map[string]any{}}
		if a.Title != nil {
			o.Set("title", *a.Title)
		}
		o.Set("message", a.Message)
		inner = o
	case "setStatus":
		if a.Short {
			inner = a.Text
		} else {
			inner = NewObject("text", a.Text)
		}
	}
	return NewObject(a.Kind, inner)
}

// mapToJSON renders a HookMap as an ordered object of event → hooks.
func mapToJSON(m *HookMap) *Object {
	o := &Object{Values: map[string]any{}}
	for _, event := range m.Events() {
		hooks := m.Get(event)
		list := make([]any, len(hooks))
		for i, h := range hooks {
			list[i] = h.ToJSON()
		}
		o.Set(event, list)
	}
	return o
}

// MapJSON renders a HookMap as JSON (event → hooks), for tests.
func MapJSON(m *HookMap) string { return Stringify(mapToJSON(m)) }
