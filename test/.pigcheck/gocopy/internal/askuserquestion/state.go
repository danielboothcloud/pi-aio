package askuserquestion

// Port of state/state.ts, state/state-reducer.ts, and
// state/selectors/derivations.ts.

import "sort"

// State is QuestionnaireState. Maps are never modified in place: a change
// replaces the map, as the TypeScript reducer replaces its Map and Set.
type State struct {
	CurrentTab              int
	OptionIndex             int
	InputMode               bool
	NotesVisible            bool
	Answers                 map[int]Answer
	MultiSelectChecked      map[int]bool
	NotesByTab              map[int]string
	FocusedOptionHasPreview bool
	SubmitChoiceIndex       int
	NotesDraft              string
	Collapsed               bool
}

// InitialState is the session's initialState().
func InitialState() State {
	return State{Answers: map[int]Answer{}, MultiSelectChecked: map[int]bool{}, NotesByTab: map[int]string{}}
}

// Action kinds (QuestionnaireAction.kind).
const (
	ActNav             = "nav"
	ActTabSwitch       = "tab_switch"
	ActConfirm         = "confirm"
	ActToggle          = "toggle"
	ActMultiConfirm    = "multi_confirm"
	ActCancel          = "cancel"
	ActNotesEnter      = "notes_enter"
	ActNotesExit       = "notes_exit"
	ActSubmit          = "submit"
	ActSubmitNav       = "submit_nav"
	ActNotesForward    = "notes_forward"
	ActExitInputMode   = "exit_input_mode"
	ActToggleCollapsed = "toggle_collapsed"
	ActIgnore          = "ignore"
)

// Action is QuestionnaireAction. Only the fields of its Kind are set.
type Action struct {
	Kind           string
	NextIndex      int
	NextTab        int
	Index          int
	Answer         *Answer
	AutoAdvanceTab *int
	Selected       []string
	Data           string
}

// Effect kinds.
const (
	EffSetInputBuffer        = "set_input_buffer"
	EffClearInputBuffer      = "clear_input_buffer"
	EffSetNotesValue         = "set_notes_value"
	EffSetNotesFocused       = "set_notes_focused"
	EffForwardNotesKeystroke = "forward_notes_keystroke"
	EffSetOverlayHidden      = "set_overlay_hidden"
	EffDone                  = "done"
)

// Effect is the reducer's Effect.
type Effect struct {
	Kind    string
	Value   string
	Focused bool
	Data    string
	Hidden  bool
	Result  *Result
}

// ApplyContext is the reducer's ApplyContext.
type ApplyContext struct {
	Questions  []Question
	ItemsByTab [][]Item
}

// ComputeFocusedOptionHasPreview ports computeFocusedOptionHasPreview.
func ComputeFocusedOptionHasPreview(questions []Question, currentTab, optionIndex int) bool {
	if currentTab < 0 || currentTab >= len(questions) {
		return false
	}
	q := questions[currentTab]
	if optionIndex < 0 || optionIndex >= len(q.Options) {
		return false
	}
	return q.Options[optionIndex].HasPreview()
}

// Confirmed is selectConfirmedIndicator's value.
type Confirmed struct {
	Index         int
	LabelOverride *string
}

// SelectConfirmedIndicator ports selectConfirmedIndicator.
func SelectConfirmedIndicator(questions []Question, currentTab int, answers map[int]Answer, items []Item) *Confirmed {
	if currentTab < 0 || currentTab >= len(questions) || questions[currentTab].IsMulti() {
		return nil
	}
	prior, ok := answers[currentTab]
	if !ok {
		return nil
	}
	if prior.Kind == KindCustom {
		idx := indexOfKind(items, RowOther)
		if idx < 0 {
			return nil
		}
		label := ""
		if prior.Answer != nil {
			label = *prior.Answer
		}
		return &Confirmed{Index: idx, LabelOverride: &label}
	}
	if prior.Kind != KindOption || prior.Answer == nil {
		return nil
	}
	for i, it := range items {
		if it.Kind == RowOption && it.Label == *prior.Answer {
			return &Confirmed{Index: i}
		}
	}
	return nil
}

// SelectActivePreviewPaneIndex ports selectActivePreviewPaneIndex.
func SelectActivePreviewPaneIndex(currentTab, totalQuestions int) int {
	if totalQuestions <= 0 {
		return 0
	}
	return min(currentTab, totalQuestions-1)
}

// Active views (selectActiveView).
const (
	ViewNotes   = "notes"
	ViewOptions = "options"
	ViewSubmit  = "submit"
)

// SelectActiveView ports selectActiveView.
func SelectActiveView(s State, totalQuestions int) string {
	if s.NotesVisible {
		return ViewNotes
	}
	if s.CurrentTab == totalQuestions {
		return ViewSubmit
	}
	return ViewOptions
}

func indexOfKind(items []Item, kind string) int {
	for i, it := range items {
		if it.Kind == kind {
			return i
		}
	}
	return -1
}

func cloneAnswers(m map[int]Answer) map[int]Answer {
	out := make(map[int]Answer, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneNotes(m map[int]string) map[int]string {
	out := make(map[int]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func orderedAnswers(s State, questions []Question) []Answer {
	out := []Answer{}
	for i := range questions {
		if a, ok := s.Answers[i]; ok {
			out = append(out, a)
		}
	}
	return out
}

func withFocusedOptionHasPreview(s State, questions []Question) State {
	s.FocusedOptionHasPreview = ComputeFocusedOptionHasPreview(questions, s.CurrentTab, s.OptionIndex)
	return s
}

func syncMultiSelectFromAnswers(answers map[int]Answer, questions []Question, tab int) map[int]bool {
	out := map[int]bool{}
	if tab < 0 || tab >= len(questions) || !questions[tab].IsMulti() {
		return out
	}
	saved := answers[tab]
	for i, o := range questions[tab].Options {
		for _, l := range saved.Selected {
			if l == o.Label {
				out[i] = true
				break
			}
		}
	}
	return out
}

func pendingNotes(s State, tab int) *string {
	if n, ok := s.NotesByTab[tab]; ok && n != "" {
		return strPtr(n)
	}
	return nil
}

func persistMultiSelectAnswer(s State, ctx ApplyContext) map[int]Answer {
	if s.CurrentTab >= len(ctx.Questions) || !ctx.Questions[s.CurrentTab].IsMulti() {
		return s.Answers
	}
	q := ctx.Questions[s.CurrentTab]
	selected := []string{}
	for i, o := range q.Options {
		if s.MultiSelectChecked[i] {
			selected = append(selected, o.Label)
		}
	}
	out := cloneAnswers(s.Answers)
	if len(selected) == 0 {
		delete(out, s.CurrentTab)
		return out
	}
	out[s.CurrentTab] = Answer{QuestionIndex: s.CurrentTab, Question: q.Question, Kind: KindMulti, Selected: selected, Notes: pendingNotes(s, s.CurrentTab)}
	return out
}

func notesValueFor(s State, tab int) string {
	if n, ok := s.NotesByTab[tab]; ok {
		return n
	}
	if a, ok := s.Answers[tab]; ok && a.Notes != nil {
		return *a.Notes
	}
	return ""
}

func switchTabResult(s State, nextTab int, ctx ApplyContext) (State, []Effect) {
	notesValue := notesValueFor(s, nextTab)
	s.CurrentTab = nextTab
	s.OptionIndex = 0
	s.InputMode = false
	s.NotesVisible = false
	s.SubmitChoiceIndex = 0
	s.MultiSelectChecked = syncMultiSelectFromAnswers(s.Answers, ctx.Questions, nextTab)
	s.NotesDraft = notesValue
	return withFocusedOptionHasPreview(s, ctx.Questions), []Effect{
		{Kind: EffSetNotesFocused, Focused: false},
		{Kind: EffSetNotesValue, Value: notesValue},
	}
}

func doneFor(s State, ctx ApplyContext, cancelled bool) (State, []Effect) {
	return s, []Effect{{Kind: EffDone, Result: &Result{Answers: orderedAnswers(s, ctx.Questions), Cancelled: cancelled}}}
}

// Reduce ports reduce: the pure (state, action) → (state, effects) step.
func Reduce(s State, a Action, ctx ApplyContext) (State, []Effect) {
	switch a.Kind {
	case ActNav:
		var items []Item
		if s.CurrentTab < len(ctx.ItemsByTab) {
			items = ctx.ItemsByTab[s.CurrentTab]
		}
		inputMode := false
		if a.NextIndex >= 0 && a.NextIndex < len(items) {
			inputMode = RowIntent[items[a.NextIndex].Kind].ActivatesInputMode
		}
		prior, hasPrior := s.Answers[s.CurrentTab]
		next := s
		next.OptionIndex = a.NextIndex
		next.InputMode = inputMode
		next = withFocusedOptionHasPreview(next, ctx.Questions)
		if !inputMode {
			return next, []Effect{{Kind: EffClearInputBuffer}}
		}
		if hasPrior && prior.Kind == KindCustom && prior.Answer != nil {
			return next, []Effect{{Kind: EffSetInputBuffer, Value: *prior.Answer}}
		}
		return next, []Effect{}
	case ActTabSwitch:
		return switchTabResult(s, a.NextTab, ctx)
	case ActConfirm:
		answer := *a.Answer
		if answer.Kind == KindOption && answer.Answer != nil && *answer.Answer != "" && answer.QuestionIndex < len(ctx.Questions) {
			for _, o := range ctx.Questions[answer.QuestionIndex].Options {
				if o.Label == *answer.Answer {
					if o.HasPreview() {
						answer.Preview = strPtr(*o.Preview)
					}
					break
				}
			}
		}
		if n := pendingNotes(s, answer.QuestionIndex); n != nil {
			answer.Notes = n
		}
		answers := cloneAnswers(s.Answers)
		answers[answer.QuestionIndex] = answer
		next := s
		next.Answers = answers
		if answer.Kind == KindCustom && answer.QuestionIndex < len(ctx.Questions) && ctx.Questions[answer.QuestionIndex].IsMulti() {
			next.MultiSelectChecked = map[int]bool{}
		}
		if a.AutoAdvanceTab != nil {
			return switchTabResult(next, *a.AutoAdvanceTab, ctx)
		}
		return doneFor(next, ctx, false)
	case ActToggle:
		checked := make(map[int]bool, len(s.MultiSelectChecked)+1)
		for k, v := range s.MultiSelectChecked {
			checked[k] = v
		}
		if checked[a.Index] {
			delete(checked, a.Index)
		} else {
			checked[a.Index] = true
		}
		next := s
		next.MultiSelectChecked = checked
		next.Answers = persistMultiSelectAnswer(next, ctx)
		return next, []Effect{}
	case ActMultiConfirm:
		if s.CurrentTab >= len(ctx.Questions) {
			return s, []Effect{}
		}
		q := ctx.Questions[s.CurrentTab]
		answers := cloneAnswers(s.Answers)
		selected := a.Selected
		if selected == nil {
			selected = []string{}
		}
		answers[s.CurrentTab] = Answer{QuestionIndex: s.CurrentTab, Question: q.Question, Kind: KindMulti, Selected: selected, Notes: pendingNotes(s, s.CurrentTab)}
		next := s
		next.Answers = answers
		next.MultiSelectChecked = syncMultiSelectFromAnswers(answers, ctx.Questions, s.CurrentTab)
		if a.AutoAdvanceTab != nil {
			return switchTabResult(next, *a.AutoAdvanceTab, ctx)
		}
		return doneFor(next, ctx, false)
	case ActNotesEnter:
		value := ""
		if a, ok := s.Answers[s.CurrentTab]; ok && a.Notes != nil {
			value = *a.Notes
		}
		next := s
		next.NotesVisible = true
		next.NotesDraft = value
		return next, []Effect{{Kind: EffSetNotesValue, Value: value}, {Kind: EffSetNotesFocused, Focused: true}}
	case ActNotesExit:
		trimmed := jsTrim(s.NotesDraft)
		notes := cloneNotes(s.NotesByTab)
		answers := cloneAnswers(s.Answers)
		if trimmed == "" {
			delete(notes, s.CurrentTab)
			if prev, ok := answers[s.CurrentTab]; ok && prev.Notes != nil && *prev.Notes != "" {
				prev.Notes = nil
				answers[s.CurrentTab] = prev
			}
		} else {
			notes[s.CurrentTab] = trimmed
			if prev, ok := answers[s.CurrentTab]; ok {
				prev.Notes = strPtr(trimmed)
				answers[s.CurrentTab] = prev
			}
		}
		next := s
		next.NotesByTab = notes
		next.Answers = answers
		next.NotesVisible = false
		return next, []Effect{{Kind: EffSetNotesFocused, Focused: false}}
	case ActCancel:
		return doneFor(s, ctx, true)
	case ActSubmit:
		return doneFor(s, ctx, false)
	case ActSubmitNav:
		next := s
		next.SubmitChoiceIndex = a.NextIndex
		return next, []Effect{}
	case ActExitInputMode:
		var items []Item
		if s.CurrentTab < len(ctx.ItemsByTab) {
			items = ctx.ItemsByTab[s.CurrentTab]
		}
		otherIndex := indexOfKind(items, RowOther)
		target := s.OptionIndex
		if otherIndex > 0 {
			target = otherIndex - 1
		}
		next := s
		next.OptionIndex = target
		next.InputMode = false
		return withFocusedOptionHasPreview(next, ctx.Questions), []Effect{{Kind: EffClearInputBuffer}}
	case ActNotesForward:
		return s, []Effect{{Kind: EffForwardNotesKeystroke, Data: a.Data}}
	case ActToggleCollapsed:
		next := s
		next.Collapsed = !s.Collapsed
		return next, []Effect{{Kind: EffSetOverlayHidden, Hidden: !s.Collapsed}}
	}
	return s, []Effect{}
}

// sortedKeys returns the keys of an int-keyed map in order.
func sortedKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}
