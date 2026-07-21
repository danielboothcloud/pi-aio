# Follow-ups panel semantics

Cursor CLI–style follow-ups UI for Pi. These choices govern upstream core behavior.

## Enter while streaming

**Keep Pi defaults:** Enter queues **steering** (delivered after the current tool batch). Alt+Enter queues **follow-up** (delivered when the agent fully settles).

The panel displays the **follow-up** queue only. Steering messages stay as dim `Steering: …` lines above the panel.

## Send now

**Steer promotion:** "Send now" removes the selected follow-up from the follow-up queue and re-queues it as steering (same delivery boundary as Enter while streaming). Does not abort the current run.

## Panel keyboard (editor empty, follow-ups visible)

| Key | Action |
|-----|--------|
| Enter | Send now — promote selected follow-up to steering |
| ↑ | Move selection up; at top, restore selected item to editor |
| ↓ | Move selection down |
| Esc | Remove selected follow-up from queue (cancel one) |
| Alt+Up | Restore **all** queued messages to editor (existing) |

When the editor has text, normal submit and keybindings apply.

## Scope

Implemented in **pi-mono** (`interactive-mode`, `FollowUpsPanel`, `AgentSession` queue APIs). This aio repo documents semantics only; no extension shim required once upstream ships.
