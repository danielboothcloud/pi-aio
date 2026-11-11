package prettytools

// Lifecycle ports index.ts' session_start, ctrl+shift+o, and /fff-* handlers
// without FFF.

// UICall is one ctx.ui call a handler makes.
type UICall struct {
	Fn      string // "setToolsExpanded" or "notify"
	Value   bool
	Message string
	Level   string
}

// Lifecycle returns the UI calls of a handler step ("session_start",
// "shortcut", "fff-health", "fff-rescan", "session_shutdown") in a mode.
func Lifecycle(step, mode string) []UICall {
	switch step {
	case "session_start":
		if mode == "tui" {
			return []UICall{{Fn: "setToolsExpanded", Value: false}}
		}
	case "shortcut":
		if mode == "tui" {
			return []UICall{{Fn: "setToolsExpanded", Value: true}}
		}
	case "fff-health", "fff-rescan":
		return []UICall{{Fn: "notify", Message: FFFNotInitialized, Level: "warning"}}
	}
	return nil
}
