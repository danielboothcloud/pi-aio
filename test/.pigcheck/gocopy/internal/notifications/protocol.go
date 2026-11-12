package notifications

import "os"

// Producer side of the notification protocol (port of
// notifications/protocol.ts). Features build the event payloads here and
// emit them on the event bus; the engine in this package listens.

// AgentPromptPayload is the payload withAgentPrompt emits around an
// agent-owned dialog: once with active true before the dialog, once with
// active false after it. preview is omitted when nil, as an undefined
// TypeScript field is.
func AgentPromptPayload(kind, title, body string, preview *string, id int, sessionID string, active bool) map[string]any {
	payload := map[string]any{"kind": kind, "title": title, "body": body, "id": id, "sessionId": sessionID, "active": active}
	if preview != nil {
		payload["preview"] = *preview
	}
	return payload
}

// SignalPayload is the payload emitNotification emits. preview and
// replacesCompletion are omitted when nil, as undefined TypeScript fields are.
func SignalPayload(category, id, sessionID, title, body string, preview *string, replaces *bool) map[string]any {
	payload := map[string]any{"category": category, "id": id, "sessionId": sessionID, "title": title, "body": body}
	if preview != nil {
		payload["preview"] = *preview
	}
	if replaces != nil {
		payload["replacesCompletion"] = *replaces
	}
	return payload
}

// SignalAllowed is emitNotification's guard: signals go out only in the TUI
// and never from a subagent child.
func SignalAllowed(mode string) bool {
	return mode == "tui" && os.Getenv("AIO_SUBAGENT_CHILD") != "1"
}

// GoalActivityPayload is emitGoalActivity's payload: a goal counts as
// active while its status is "active" or "auditing".
func GoalActivityPayload(sessionID, status string, quietSettle bool) map[string]any {
	return map[string]any{"sessionId": sessionID, "active": status == "active" || status == "auditing", "quietSettle": quietSettle}
}
