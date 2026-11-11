package askuserquestion

// Port of state/questionnaire-session.ts.

import (
	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
)

// cursorEnd is Ctrl-E (tui.editor.cursorLineEnd).
const cursorEnd = "\x05"

// SessionConfig is QuestionnaireSessionConfig.
type SessionConfig struct {
	Theme    Theme
	Markdown copywidget.MarkdownTheme
	Keys     Keys
	Params   Params
	// ItemsByTab is buildItemsForQuestion for each question.
	ItemsByTab [][]Item
	// Columns and Rows are tui.terminal.columns and rows.
	Columns, Rows func() int
	// RequestRender is tui.requestRender (optional).
	RequestRender func()
	// Done receives the result once.
	Done func(Result)
	// SetOverlayHidden runs the set_overlay_hidden effect
	// (OverlayHandle.setHidden); nil until the handle exists.
	SetOverlayHidden func(hidden bool)
	// CollapseKey is the resolved collapse key spec.
	CollapseKey string
}

// Session is QuestionnaireSession: the state cell, the input buffers, and
// the effect runner around the pure reducer.
type Session struct {
	cfg        SessionConfig
	state      State
	questions  []Question
	isMulti    bool
	itemsByTab [][]Item
	b          *built
}

// NewSession builds the session and applies the initial state.
func NewSession(cfg SessionConfig) *Session {
	s := &Session{cfg: cfg, state: InitialState(), questions: cfg.Params.Questions, isMulti: len(cfg.Params.Questions) > 1, itemsByTab: cfg.ItemsByTab}
	s.state.FocusedOptionHasPreview = ComputeFocusedOptionHasPreview(s.questions, 0, 0)
	s.b = buildQuestionnaire(buildConfig{
		theme: cfg.Theme, markdown: cfg.Markdown, keys: cfg.Keys, questions: s.questions, itemsByTab: s.itemsByTab,
		isMulti: s.isMulti, initialState: s.state, columns: cfg.Columns, rows: cfg.Rows,
		currentTab: func() int { return s.state.CurrentTab }, requestRender: cfg.RequestRender,
	})
	s.b.apply(s.state)
	return s
}

// State is the current canonical state.
func (s *Session) State() State { return s.state }

// InputBuffer is the inline input's value.
func (s *Session) InputBuffer() string { return s.b.inlineInput.Value() }

// NotesValue is the notes input's value.
func (s *Session) NotesValue() string { return s.b.notesInput.Value() }

// SetOverlayHidden installs the set_overlay_hidden effect runner
// (setOverlayHandle).
func (s *Session) SetOverlayHidden(fn func(hidden bool)) { s.cfg.SetOverlayHidden = fn }

// Render is component.render.
func (s *Session) Render(width int) []string {
	if s.state.Collapsed {
		return []string{s.cfg.Theme.Fg("dim", " "+T("hint.expand_line", CollapsedHint)+" ")}
	}
	return s.b.dialog.render(width)
}

// Invalidate is component.invalidate.
func (s *Session) Invalidate() { s.b.invalidate() }

// HandleInput is component.handleInput (dispatch).
func (s *Session) HandleInput(data string) {
	action := RouteKey(data, s.state, s.runtime())
	if action.Kind == ActIgnore {
		if s.state.InputMode {
			s.b.inlineInput.HandleInput(data)
			s.b.apply(s.state)
		}
		return
	}
	s.commit(action)
}

// ToggleCollapsedExternal is toggleCollapsedExternal.
func (s *Session) ToggleCollapsedExternal() { s.commit(Action{Kind: ActToggleCollapsed}) }

// LastAction routes data without committing (for tests).
func (s *Session) LastAction(data string) Action { return RouteKey(data, s.state, s.runtime()) }

func (s *Session) commit(action Action) {
	next, effects := Reduce(s.state, action, ApplyContext{Questions: s.questions, ItemsByTab: s.itemsByTab})
	s.state = next
	for _, e := range effects {
		s.runEffect(e)
	}
	if draft := s.b.notesInput.Value(); s.state.NotesDraft != draft {
		s.state.NotesDraft = draft
	}
	s.b.apply(s.state)
}

func (s *Session) runEffect(e Effect) {
	switch e.Kind {
	case EffSetInputBuffer:
		s.b.inlineInput.SetValue(e.Value)
		s.b.inlineInput.HandleInput(cursorEnd)
	case EffClearInputBuffer:
		s.b.inlineInput.SetValue("")
	case EffSetNotesValue:
		s.b.notesInput.SetValue(e.Value)
	case EffSetNotesFocused:
		s.b.notesInput.SetFocused(e.Focused)
	case EffForwardNotesKeystroke:
		s.b.notesInput.HandleInput(e.Data)
	case EffSetOverlayHidden:
		if s.cfg.SetOverlayHidden != nil {
			s.cfg.SetOverlayHidden(e.Hidden)
		}
	case EffDone:
		if s.cfg.Done != nil {
			s.cfg.Done(*e.Result)
		}
	}
}

func (s *Session) runtime() Runtime {
	var items []Item
	if s.state.CurrentTab < len(s.itemsByTab) {
		items = s.itemsByTab[s.state.CurrentTab]
	}
	var current *Item
	if s.state.OptionIndex >= 0 && s.state.OptionIndex < len(items) {
		it := items[s.state.OptionIndex]
		current = &it
	}
	return Runtime{
		Keys: s.cfg.Keys, InputBuffer: s.b.inlineInput.Value(), Questions: s.questions, IsMulti: s.isMulti,
		CurrentItem: current, Items: items, CollapseKey: s.cfg.CollapseKey,
	}
}
