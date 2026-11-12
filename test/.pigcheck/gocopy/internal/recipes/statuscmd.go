package recipes

// StatusHost is what showRecipeStatus needs from the session.
type StatusHost interface {
	Mode() string
	AppendEntry(customType string, data any)
	Notify(message, level string)
	// Stderr writes to the process's stderr (print and JSON modes).
	Stderr(text string)
}

// ShowStatus is showRecipeStatus: it persists the report as a custom entry
// (outside model context), then writes it to stderr in print and JSON
// modes, or notifies it for --json and in RPC. The TUI renders the entry.
func ShowStatus(h StatusHost, report StatusReport, json bool) {
	h.AppendEntry(StatusEntry, report)
	switch mode := h.Mode(); {
	case mode == "print" || mode == "json":
		if json {
			h.Stderr("recipe-status: " + StatusJSON(report, "") + "\n")
		} else {
			h.Stderr(FormatStatus(report, true) + "\n")
		}
	case json:
		h.Notify(StatusJSON(report, "  "), "info")
	case mode == "rpc":
		h.Notify(FormatStatus(report, true), "info")
	}
}

// StatusUsage is /recipe-status's argument error.
const StatusUsage = "Use /recipe-status [--json]"
