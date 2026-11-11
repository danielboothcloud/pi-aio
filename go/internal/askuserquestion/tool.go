package askuserquestion

// Port of ask-user-question.ts (tool registration and execute), events.ts,
// and reconcile.ts.

import (
	"strconv"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
	"github.com/danielboothcloud/pi-aio/go/internal/rpivconfig"
)

// ToolName is ASK_USER_QUESTION_TOOL_NAME.
const ToolName = "ask_user_question"

// ToolLabel is the tool's label.
const ToolLabel = "Ask User Question"

// PromptEvent is ASK_USER_PROMPT_EVENT.
const PromptEvent = "rpiv:ask-user:prompt"

// Error texts of execute.
const (
	ErrorNoUI       = "Error: UI not available (running in non-interactive mode)"
	ErrorNoCustomUI = "Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool."
)

// DefaultPromptSnippet ports DEFAULT_PROMPT_SNIPPET.
var DefaultPromptSnippet = "Ask the user up to " + strconv.Itoa(MaxQuestions) + " structured questions (" + strconv.Itoa(MinOptions) + "-" + strconv.Itoa(MaxOptions) + " options each) when requirements are ambiguous"

// DefaultPromptGuidelines ports DEFAULT_PROMPT_GUIDELINES.
var DefaultPromptGuidelines = []string{
	"Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to " + strconv.Itoa(MaxQuestions) + " questions per invocation.",
	"Each question MUST have " + strconv.Itoa(MinOptions) + "-" + strconv.Itoa(MaxOptions) + ` options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to every question) or press Esc to abandon the questionnaire.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every single-select question regardless of whether any option carries a preview; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
}

// ToolDescription is the tool description.
const ToolDescription = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every question) or press Esc to abandon the questionnaire. Do NOT author "Other" / "Type something." labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. It is always available on every question (even when options carry a ` + "`preview`" + `), expanding to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional ` + "`preview`" + ` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`

// ExecutionMode is the tool's executionMode.
const ExecutionMode = "sequential"

// Schema is QuestionParamsSchema as JSON Schema (TypeBox output).
func Schema() map[string]any {
	str := func(extra map[string]any) map[string]any {
		out := map[string]any{"type": "string"}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	option := map[string]any{
		"type":     "object",
		"required": []any{"label", "description"},
		"properties": map[string]any{
			"label":       str(map[string]any{"maxLength": MaxLabelLength, "description": "MAX " + strconv.Itoa(MaxLabelLength) + " CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."}),
			"description": str(map[string]any{"description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."}),
			"preview":     str(map[string]any{"description": "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format."}),
		},
	}
	question := map[string]any{
		"type":     "object",
		"required": []any{"question", "header", "options"},
		"properties": map[string]any{
			"question": str(map[string]any{"description": `The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"`}),
			"header":   str(map[string]any{"maxLength": MaxHeaderLength, "description": "MAX " + strconv.Itoa(MaxHeaderLength) + ` CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`}),
			"options": map[string]any{
				"type":        "array",
				"items":       option,
				"minItems":    MinOptions,
				"maxItems":    MaxOptions,
				"description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
			},
			"multiSelect": map[string]any{
				"type":        "boolean",
				"default":     false,
				"description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
			},
		},
	}
	return map[string]any{
		"type":     "object",
		"required": []any{"questions"},
		"properties": map[string]any{
			"questions": map[string]any{
				"type":        "array",
				"items":       question,
				"minItems":    1,
				"maxItems":    MaxQuestions,
				"description": "Questions to ask the user (1-4 questions)",
			},
		},
	}
}

// Guidance is the registered promptSnippet and promptGuidelines: the
// config's guidance fields, else the defaults.
func Guidance(c Config) (snippet string, guidelines []string) {
	g := rpivconfig.ValidateGuidanceFields(c["guidance"])
	snippet, guidelines = DefaultPromptSnippet, DefaultPromptGuidelines
	if g.PromptSnippet != nil {
		snippet = *g.PromptSnippet
	}
	if g.PromptGuidelines != nil {
		guidelines = g.PromptGuidelines
	}
	return snippet, guidelines
}

// PromptEventOption is AskUserPromptOption.
type PromptEventOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
	HasPreview  bool   `json:"hasPreview"`
}

// PromptEventQuestion is AskUserPromptQuestion.
type PromptEventQuestion struct {
	Question    string              `json:"question"`
	Header      string              `json:"header"`
	MultiSelect bool                `json:"multiSelect"`
	Options     []PromptEventOption `json:"options"`
}

// PromptEventPayload is AskUserPromptEventPayload.
type PromptEventPayload struct {
	Questions []PromptEventQuestion `json:"questions"`
}

// BuildPromptEvent ports emitAskUserPromptEvent's payload.
func BuildPromptEvent(p Params) PromptEventPayload {
	out := PromptEventPayload{Questions: []PromptEventQuestion{}}
	for _, q := range p.Questions {
		eq := PromptEventQuestion{Question: q.Question, Header: q.Header, MultiSelect: q.IsMulti(), Options: []PromptEventOption{}}
		for _, o := range q.Options {
			eq.Options = append(eq.Options, PromptEventOption{Label: o.Label, Description: o.Description, HasPreview: o.HasPreview()})
		}
		out.Questions = append(out.Questions, eq)
	}
	return out
}

// AgentPromptEvent is notifications/protocol.ts AGENT_PROMPT_EVENT.
const AgentPromptEvent = "aio:notification:agent-prompt"

// AgentPrompt is the withAgentPrompt payload.
type AgentPrompt struct {
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Preview   string `json:"preview"`
	ID        int    `json:"id"`
	SessionID string `json:"sessionId"`
	Active    bool   `json:"active"`
}

// Overlay layout of ctx.ui.custom: bottom-anchored, full width and height,
// no side or bottom margin.
const (
	OverlayAnchor    = "bottom-center"
	OverlayWidth     = 100 // percent
	OverlayMaxHeight = 100 // percent
)

// OverlayOptionsJSON is the overlayOptions object TypeScript passes.
func OverlayOptionsJSON() map[string]any {
	return map[string]any{
		"anchor": OverlayAnchor, "width": strconv.Itoa(OverlayWidth) + "%", "maxHeight": strconv.Itoa(OverlayMaxHeight) + "%",
		"margin": map[string]any{"left": 0, "right": 0, "bottom": 0},
	}
}

// OverlayHandle is the slice of pi-tui's OverlayHandle the session uses.
type OverlayHandle interface {
	IsHidden() bool
	IsFocused() bool
	SetHidden(hidden bool)
}

// Host is the PiG host as execute sees it.
type Host interface {
	DialogUI
	HasUI() bool
	Mode() string
	// HasDialogUI is hasDialogUI(ctx.ui).
	HasDialogUI() bool
	EmitEvent(channel string, payload any)
	SessionID() string
	// NextPromptID is withAgentPrompt's ++nextPromptId.
	NextPromptID() int
	// ShowOverlay is ctx.ui.custom with the overlay options: it returns
	// once the overlay closed, or at once when the host cannot render it
	// (custom() resolved undefined). onHandle receives the handle.
	ShowOverlay(o *Overlay, onHandle func(OverlayHandle)) error
	// OnTerminalInput is ctx.ui.onTerminalInput; ok false when absent. The
	// handler returns true to consume.
	OnTerminalInput(handler func(data string) bool) (unsubscribe func(), ok bool)
	Notify(message, level string)
	Theme() Theme
	Markdown() copywidget.MarkdownTheme
	Keys() Keys
	Columns() int
	Rows() int
}

// Overlay is the questionnaire component the host shows. Every method is
// safe to call from any goroutine.
type Overlay struct {
	mu         sync.Mutex
	session    *Session
	mounted    bool
	done       bool
	result     Result
	invalidate func()
}

func (o *Overlay) requestRender() {
	if o.invalidate != nil {
		o.invalidate()
	}
}

// Render is component.render.
func (o *Overlay) Render(width int) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.mounted = true
	return o.session.Render(width)
}

// HandleInput is component.handleInput; done reports the session finished.
func (o *Overlay) HandleInput(data string) (done bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.done {
		o.session.HandleInput(data)
	}
	return o.done
}

// Invalidate is component.invalidate.
func (o *Overlay) Invalidate() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.session.Invalidate()
}

// SetInvalidate installs the host's render request (nil detaches).
func (o *Overlay) SetInvalidate(fn func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.invalidate = fn
}

// Result is the finished result; mounted reports that the host rendered
// the overlay at least once.
func (o *Overlay) Result() (result Result, done, mounted bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.result, o.done, o.mounted
}

func (o *Overlay) toggleCollapsed() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.done {
		o.session.ToggleCollapsedExternal()
	}
}

func (o *Overlay) setHandle(h OverlayHandle, hidden func(bool)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.session.SetOverlayHidden(func(v bool) {
		h.SetHidden(v)
		hidden(v)
	})
}

// Execute ports the tool's execute. params are the sanitized-before
// arguments; config is loadConfig() at call time. A non-nil error is a
// thrown error (the collapseKey TypeError).
func Execute(h Host, raw Params, config Config) (ToolResult, error) {
	typed := SanitizeQuestionnaire(raw)
	if !h.HasUI() {
		return BuildToolResult(ErrorNoUI, Result{Answers: []Answer{}, Cancelled: true, Error: ErrNoUI}), nil
	}
	if v := ValidateQuestionnaire(typed); !v.OK {
		return BuildToolResult(v.Message, Result{Answers: []Answer{}, Cancelled: true, Error: v.Error}), nil
	}
	h.EmitEvent(PromptEvent, BuildPromptEvent(typed))
	if h.Mode() == "rpc" && h.HasDialogUI() {
		result := RunRPCQuestionnaire(h, typed)
		return BuildQuestionnaireResponse(&result, typed), nil
	}
	itemsByTab := make([][]Item, len(typed.Questions))
	for i, q := range typed.Questions {
		itemsByTab[i] = BuildItemsForQuestion(q)
	}
	collapseKey, ok := ResolveCollapseKey(config)
	if !ok {
		return ToolResult{}, errorString(CollapseKeyTypeError)
	}

	overlay := &Overlay{}
	var handleMu sync.Mutex
	var handle OverlayHandle
	announced := false
	var unsubscribe func()
	// announceHidden is the listener's one-time "hidden" notice. PiG sends
	// a key to the focused overlay before the terminal-input listeners, so
	// the first collapse key reaches routeKey, not the listener. The notice
	// is therefore also sent when the overlay hides itself while the
	// listener is subscribed: the user sees it once, as in TypeScript.
	announceHidden := func() {
		handleMu.Lock()
		announce := !announced
		announced = true
		handleMu.Unlock()
		if announce {
			h.Notify("ask_user_question hidden — press "+collapseKey+" to reopen", "info")
		}
	}
	if collapseKey != CollapseKeyOff {
		keys := h.Keys()
		if unsub, ok := h.OnTerminalInput(func(data string) bool {
			handleMu.Lock()
			current := handle
			handleMu.Unlock()
			if current == nil {
				return false
			}
			if !current.IsHidden() && !current.IsFocused() {
				return false
			}
			if !keys.MatchesKey(data, collapseKey) {
				return false
			}
			overlay.toggleCollapsed()
			if current.IsHidden() {
				announceHidden()
			}
			return true
		}); ok {
			unsubscribe = unsub
		}
	}
	defer func() {
		if unsubscribe != nil {
			unsubscribe()
		}
	}()

	id := h.NextPromptID()
	emitPrompt := func(active bool) {
		defer func() { _ = recover() }()
		preview := ""
		if len(typed.Questions) > 0 {
			preview = typed.Questions[0].Question
		}
		h.EmitEvent(AgentPromptEvent, AgentPrompt{
			Kind: "custom", Title: "Question waiting", Body: "The agent needs your answer to continue.",
			Preview: preview, ID: id, SessionID: h.SessionID(), Active: active,
		})
	}
	emitPrompt(true)
	overlay.session = NewSession(SessionConfig{
		Theme: h.Theme(), Markdown: h.Markdown(), Keys: h.Keys(), Params: typed, ItemsByTab: itemsByTab,
		Columns: h.Columns, Rows: h.Rows, RequestRender: overlay.requestRender, CollapseKey: collapseKey,
		Done: func(r Result) {
			overlay.done = true
			overlay.result = r
		},
	})
	err := h.ShowOverlay(overlay, func(oh OverlayHandle) {
		handleMu.Lock()
		handle = oh
		handleMu.Unlock()
		overlay.setHandle(oh, func(hidden bool) {
			if hidden && unsubscribe != nil {
				announceHidden()
			}
		})
	})
	emitPrompt(false)
	if err != nil {
		return ToolResult{}, err
	}
	result, done, mounted := overlay.Result()
	if !done && mounted {
		// The host closed a shown overlay without a result (a teardown).
		// TypeScript's custom() never resolves then; it is a cancel here.
		return BuildQuestionnaireResponse(&Result{Answers: []Answer{}, Cancelled: true}, typed), nil
	}
	if !done {
		if h.HasDialogUI() {
			r := RunRPCQuestionnaire(h, typed)
			return BuildQuestionnaireResponse(&r, typed), nil
		}
		return BuildToolResult(ErrorNoCustomUI, Result{Answers: []Answer{}, Cancelled: true, Error: ErrNoCustomUI}), nil
	}
	return BuildQuestionnaireResponse(&result, typed), nil
}

type errorString string

func (e errorString) Error() string { return string(e) }

// ReconcileActiveTools ports reconcileAskUserQuestionTool: the new active
// tool list, and whether it changed.
func ReconcileActiveTools(hasUI bool, active []string) ([]string, bool) {
	has := false
	for _, n := range active {
		if n == ToolName {
			has = true
			break
		}
	}
	if !hasUI && has {
		out := []string{}
		for _, n := range active {
			if n != ToolName {
				out = append(out, n)
			}
		}
		return out, true
	}
	if hasUI && !has {
		return append(append([]string{}, active...), ToolName), true
	}
	return active, false
}

// LoadToolConfig is loadConfig() for the process environment.
func LoadToolConfig(warn func(string)) Config { return LoadConfig(rpivconfig.OSEnv(), warn) }
