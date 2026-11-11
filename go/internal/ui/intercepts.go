// Package ui is the Go port of ui/editor-intercepts.ts: the editor key and
// submit interceptors that AIO features register and the AIO queue editor
// consults before the host handles a key. Absent an AIO editor, the host's
// behavior is untouched. (ui/chrome.ts is in go/internal/chrome.)
package ui

import "sync"

// Intercepts is EditorIntercepts. A nil function is not registered.
type Intercepts struct {
	// Escape runs on Escape with an empty editor and no autocomplete; true
	// consumes the key.
	Escape func() bool
	// Submit runs with the submitted text; true consumes it.
	Submit func(text string) bool
	// Action runs for an app action such as "app.session.resume"; true
	// consumes it.
	Action func(action string) bool
}

// InterceptedActions is INTERCEPTED_ACTIONS.
var InterceptedActions = []string{"app.session.resume"}

var (
	mu      sync.Mutex
	current Intercepts
)

// SetEditorIntercepts is setEditorIntercepts (nil clears).
func SetEditorIntercepts(intercepts *Intercepts) {
	mu.Lock()
	defer mu.Unlock()
	if intercepts == nil {
		current = Intercepts{}
		return
	}
	current = *intercepts
}

// EditorIntercepts is getEditorIntercepts.
func EditorIntercepts() Intercepts {
	mu.Lock()
	defer mu.Unlock()
	return current
}
