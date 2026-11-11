package askuserquestion

// Port of state/key-router.ts.

import "github.com/danielboothcloud/pi-aio/go/internal/jsstr"

// Keys is the key matching the questionnaire needs from pi-tui.
type Keys interface {
	// Matches is getKeybindings().matches(data, keybindingId).
	Matches(data, binding string) bool
	// MatchesKey is matchesKey(data, keyId).
	MatchesKey(data, keyID string) bool
	// DecodeKittyPrintable is decodeKittyPrintable(data).
	DecodeKittyPrintable(data string) (string, bool)
}

// Keybinding ids the questionnaire reads.
const (
	KeybindUp      = "tui.select.up"
	KeybindDown    = "tui.select.down"
	KeybindConfirm = "tui.select.confirm"
	KeybindCancel  = "tui.select.cancel"
)

const (
	notesActivateKey = "n"
	spaceKey         = " "
	vimUp            = "k"
	vimDown          = "j"
	vimTabBack       = "h"
	vimTabForward    = "l"
)

// Runtime is QuestionnaireRuntime.
type Runtime struct {
	Keys        Keys
	InputBuffer string
	Questions   []Question
	IsMulti     bool
	CurrentItem *Item
	Items       []Item
	CollapseKey string
}

func jsTrim(s string) string { return jsstr.Trim(s) }

// WrapTab ports wrapTab.
func WrapTab(index, total int) int {
	if total <= 0 {
		return 0
	}
	return ((index % total) + total) % total
}

func matchesSelectUp(data string, kb Keys) bool { return kb.Matches(data, KeybindUp) || data == vimUp }
func matchesSelectDown(data string, kb Keys) bool {
	return kb.Matches(data, KeybindDown) || data == vimDown
}

func totalTabs(rt Runtime) int {
	if rt.IsMulti {
		return len(rt.Questions) + 1
	}
	return 1
}

func computeAutoAdvanceTab(s State, rt Runtime) *int {
	if !rt.IsMulti {
		return nil
	}
	next := len(rt.Questions)
	if s.CurrentTab < len(rt.Questions)-1 {
		next = s.CurrentTab + 1
	}
	return &next
}

func buildSingleSelectAnswer(s State, rt Runtime) *Answer {
	if s.CurrentTab < 0 || s.CurrentTab >= len(rt.Questions) {
		return nil
	}
	q := rt.Questions[s.CurrentTab]
	if s.InputMode {
		var answer *string
		if rt.InputBuffer != "" {
			answer = strPtr(rt.InputBuffer)
		}
		return &Answer{QuestionIndex: s.CurrentTab, Question: q.Question, Kind: KindCustom, Answer: answer}
	}
	item := rt.CurrentItem
	if item == nil || item.Kind == RowOther || item.Kind == RowNext {
		return nil
	}
	return &Answer{QuestionIndex: s.CurrentTab, Question: q.Question, Kind: KindOption, Answer: strPtr(item.Label)}
}

func buildMultiSelected(s State, rt Runtime) []string {
	out := []string{}
	if s.CurrentTab < 0 || s.CurrentTab >= len(rt.Questions) {
		return out
	}
	for i, o := range rt.Questions[s.CurrentTab].Options {
		if s.MultiSelectChecked[i] {
			out = append(out, o.Label)
		}
	}
	return out
}

func tabSwitchAction(data string, s State, rt Runtime) *Action {
	if !rt.IsMulti {
		return nil
	}
	total := totalTabs(rt)
	kb := rt.Keys
	if kb.MatchesKey(data, "tab") || kb.MatchesKey(data, "right") || data == vimTabForward {
		return &Action{Kind: ActTabSwitch, NextTab: WrapTab(s.CurrentTab+1, total)}
	}
	if kb.MatchesKey(data, "shift+tab") || kb.MatchesKey(data, "left") || data == vimTabBack {
		return &Action{Kind: ActTabSwitch, NextTab: WrapTab(s.CurrentTab-1, total)}
	}
	return nil
}

func nextNavOnDown(s State, rt Runtime) Action {
	return Action{Kind: ActNav, NextIndex: WrapTab(s.OptionIndex+1, max(1, len(rt.Items)))}
}

func prevNavOnUp(s State, rt Runtime) Action {
	return Action{Kind: ActNav, NextIndex: WrapTab(s.OptionIndex-1, max(1, len(rt.Items)))}
}

func confirmAction(s State, rt Runtime) Action {
	answer := buildSingleSelectAnswer(s, rt)
	if answer == nil {
		return Action{Kind: ActIgnore}
	}
	return Action{Kind: ActConfirm, Answer: answer, AutoAdvanceTab: computeAutoAdvanceTab(s, rt)}
}

// RouteKey ports routeKey: one keystroke to one action.
func RouteKey(data string, s State, rt Runtime) Action {
	kb := rt.Keys
	if rt.CollapseKey != CollapseKeyOff && kb.MatchesKey(data, rt.CollapseKey) {
		return Action{Kind: ActToggleCollapsed}
	}
	if s.Collapsed {
		if kb.Matches(data, KeybindCancel) {
			return Action{Kind: ActCancel}
		}
		return Action{Kind: ActIgnore}
	}
	if s.NotesVisible {
		if kb.Matches(data, KeybindCancel) || kb.Matches(data, KeybindConfirm) {
			return Action{Kind: ActNotesExit}
		}
		return Action{Kind: ActNotesForward, Data: data}
	}
	if s.InputMode {
		if kb.Matches(data, KeybindConfirm) {
			return confirmAction(s, rt)
		}
		if kb.Matches(data, KeybindCancel) {
			return Action{Kind: ActExitInputMode}
		}
		if kb.Matches(data, KeybindUp) {
			return prevNavOnUp(s, rt)
		}
		if kb.Matches(data, KeybindDown) {
			return nextNavOnDown(s, rt)
		}
		return Action{Kind: ActIgnore}
	}
	if rt.IsMulti && s.CurrentTab == len(rt.Questions) {
		if kb.Matches(data, KeybindCancel) {
			return Action{Kind: ActCancel}
		}
		if tab := tabSwitchAction(data, s, rt); tab != nil {
			return *tab
		}
		if matchesSelectUp(data, kb) || matchesSelectDown(data, kb) {
			delta := -1
			if matchesSelectDown(data, kb) {
				delta = 1
			}
			next := 0
			if WrapTab(s.SubmitChoiceIndex+delta, 2) == 1 {
				next = 1
			}
			return Action{Kind: ActSubmitNav, NextIndex: next}
		}
		if kb.Matches(data, KeybindConfirm) {
			if s.SubmitChoiceIndex == 1 {
				return Action{Kind: ActCancel}
			}
			return Action{Kind: ActSubmit}
		}
		return Action{Kind: ActIgnore}
	}
	if tab := tabSwitchAction(data, s, rt); tab != nil {
		return *tab
	}
	if s.CurrentTab < 0 || s.CurrentTab >= len(rt.Questions) {
		return Action{Kind: ActIgnore}
	}
	q := rt.Questions[s.CurrentTab]
	if data == notesActivateKey && !q.IsMulti() && s.FocusedOptionHasPreview {
		return Action{Kind: ActNotesEnter}
	}
	if matchesSelectUp(data, kb) {
		return prevNavOnUp(s, rt)
	}
	if matchesSelectDown(data, kb) {
		return nextNavOnDown(s, rt)
	}
	if q.IsMulti() {
		var meta *RowIntentMeta
		if rt.CurrentItem != nil {
			m := RowIntent[rt.CurrentItem.Kind]
			meta = &m
		}
		if data == spaceKey {
			if meta != nil && (meta.BlocksMultiToggle || meta.ActivatesInputMode) {
				return Action{Kind: ActIgnore}
			}
			return Action{Kind: ActToggle, Index: s.OptionIndex}
		}
		if kb.Matches(data, KeybindConfirm) {
			if meta != nil && meta.ActivatesInputMode {
				return Action{Kind: ActIgnore}
			}
			if meta == nil || !meta.AutoSubmitsInMulti {
				return Action{Kind: ActToggle, Index: s.OptionIndex}
			}
			return Action{Kind: ActMultiConfirm, Selected: buildMultiSelected(s, rt), AutoAdvanceTab: computeAutoAdvanceTab(s, rt)}
		}
		if kb.Matches(data, KeybindCancel) {
			return Action{Kind: ActCancel}
		}
		return Action{Kind: ActIgnore}
	}
	if kb.Matches(data, KeybindConfirm) {
		return confirmAction(s, rt)
	}
	if kb.Matches(data, KeybindCancel) {
		return Action{Kind: ActCancel}
	}
	return Action{Kind: ActIgnore}
}
