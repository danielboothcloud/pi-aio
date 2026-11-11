package askuserquestion

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/rpivconfig"
)

// ---------------------------------------------------------------------------
// tool/sanitize-questionnaire.ts
// ---------------------------------------------------------------------------

// SanitizeText ports sanitizeText: CRLF becomes "\n", then C0 controls
// (except tab and newline) and DEL are dropped.
func SanitizeText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.Map(func(r rune) rune {
		if (r <= 0x08) || (r >= 0x0B && r <= 0x1F) || r == 0x7F {
			return -1
		}
		return r
	}, value)
}

// SanitizeQuestionnaire ports sanitizeQuestionnaire: every rendered string
// field is cleaned. The input is not modified.
func SanitizeQuestionnaire(p Params) Params {
	out := Params{Questions: make([]Question, len(p.Questions))}
	for i, q := range p.Questions {
		clean := Question{Question: SanitizeText(q.Question), Header: SanitizeText(q.Header), MultiSelect: q.MultiSelect}
		if q.Options != nil {
			clean.Options = make([]Option, len(q.Options))
			for j, o := range q.Options {
				co := Option{Label: SanitizeText(o.Label), Description: SanitizeText(o.Description)}
				if o.Preview != nil {
					co.Preview = strPtr(SanitizeText(*o.Preview))
				}
				clean.Options[j] = co
			}
		}
		out.Questions[i] = clean
	}
	return out
}

// ---------------------------------------------------------------------------
// state/row-intent.ts
// ---------------------------------------------------------------------------

// Row kinds (WrappingSelectItem.kind).
const (
	RowOption = "option"
	RowOther  = "other"
	RowNext   = "next"
)

// RowIntentMeta ports RowIntentMeta.
type RowIntentMeta struct {
	Label                    string
	Reserved                 bool
	LivesInMainList          bool
	Numbered                 bool
	ActivatesInputMode       bool
	BlocksMultiToggle        bool
	AutoSubmitsInMulti       bool
	AutoAppendOnSingleSelect bool
	AutoAppendOnMultiSelect  bool
}

// RowIntent ports ROW_INTENT_META.
var RowIntent = map[string]RowIntentMeta{
	RowOption: {Label: "", LivesInMainList: true, Numbered: true},
	RowOther:  {Label: "Type something.", Reserved: true, LivesInMainList: true, Numbered: true, ActivatesInputMode: true, AutoAppendOnSingleSelect: true, AutoAppendOnMultiSelect: true},
	RowNext:   {Label: "Next", Reserved: true, LivesInMainList: true, BlocksMultiToggle: true, AutoSubmitsInMulti: true, AutoAppendOnMultiSelect: true},
}

// SentinelKinds ports SENTINEL_KINDS.
var SentinelKinds = []string{RowOther, RowNext}

// ReservedLabels ports RESERVED_LABELS.
var ReservedLabels = []string{"Other", RowIntent[RowOther].Label, RowIntent[RowNext].Label}

// SentinelsToAppend ports sentinelsToAppend.
func SentinelsToAppend(q Question) []string {
	var out []string
	for _, k := range SentinelKinds {
		meta := RowIntent[k]
		if !meta.LivesInMainList {
			continue
		}
		if q.IsMulti() {
			if meta.AutoAppendOnMultiSelect {
				out = append(out, k)
			}
		} else if meta.AutoAppendOnSingleSelect {
			out = append(out, k)
		}
	}
	return out
}

// T is the i18n bridge's t(key, fallback). @juicesharp/rpiv-i18n is not
// available to the Go port, so every call site gets its English fallback.
func T(_ string, fallback string) string { return fallback }

// DisplayLabel ports displayLabel.
func DisplayLabel(kind string) string { return T("sentinel."+kind, RowIntent[kind].Label) }

// Item is WrappingSelectItem. Description "" is absent on sentinel rows;
// option rows always carry the option's description.
type Item struct {
	Kind        string
	Label       string
	Description string
}

// MarshalJSON writes the TypeScript item shape.
func (it Item) MarshalJSON() ([]byte, error) {
	if it.Kind == RowOption || it.Description != "" {
		return json.Marshal(struct {
			Kind        string `json:"kind"`
			Label       string `json:"label"`
			Description string `json:"description"`
		}{it.Kind, it.Label, it.Description})
	}
	return json.Marshal(struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
	}{it.Kind, it.Label})
}

// BuildItemsForQuestion ports buildItemsForQuestion.
func BuildItemsForQuestion(q Question) []Item {
	items := make([]Item, 0, len(q.Options)+2)
	for _, o := range q.Options {
		items = append(items, Item{Kind: RowOption, Label: o.Label, Description: o.Description})
	}
	for _, kind := range SentinelsToAppend(q) {
		items = append(items, Item{Kind: kind, Label: DisplayLabel(kind)})
	}
	return items
}

// ---------------------------------------------------------------------------
// tool/validate-questionnaire.ts
// ---------------------------------------------------------------------------

// Validation messages.
var (
	ErrorNoQuestions          = "Error: At least one question is required"
	ErrorTooManyQuestions     = "Error: At most 4 questions are allowed per invocation"
	ErrorDuplicateQuestion    = "Error: Question text must be unique within an invocation"
	ErrorTooFewOptions        = "Error: Each question requires at least 2 options"
	ErrorReservedLabel        = "Error: Option label is reserved (" + strings.Join(ReservedLabels, ", ") + ")"
	ErrorDuplicateOptionLabel = "Error: Option labels must be unique within a question"
)

// Validation is ValidationResult; OK true has no error.
type Validation struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

// ValidateQuestionnaire ports validateQuestionnaire.
func ValidateQuestionnaire(p Params) Validation {
	if len(p.Questions) == 0 {
		return Validation{Error: ErrNoQuestions, Message: ErrorNoQuestions}
	}
	if len(p.Questions) > MaxQuestions {
		return Validation{Error: ErrTooManyQuestions, Message: ErrorTooManyQuestions}
	}
	seen := map[string]bool{}
	for _, q := range p.Questions {
		if seen[q.Question] {
			return Validation{Error: ErrDuplicateQuestion, Message: ErrorDuplicateQuestion}
		}
		seen[q.Question] = true
	}
	reserved := map[string]bool{}
	for _, l := range ReservedLabels {
		reserved[l] = true
	}
	for _, q := range p.Questions {
		if len(q.Options) < MinOptions {
			return Validation{Error: ErrEmptyOptions, Message: ErrorTooFewOptions}
		}
		labels := map[string]bool{}
		for _, o := range q.Options {
			if reserved[o.Label] {
				return Validation{Error: ErrReservedLabel, Message: ErrorReservedLabel}
			}
			if labels[o.Label] {
				return Validation{Error: ErrDuplicateOptionLabel, Message: ErrorDuplicateOptionLabel}
			}
			labels[o.Label] = true
		}
	}
	return Validation{OK: true}
}

// ---------------------------------------------------------------------------
// tool/format-answer.ts and tool/response-envelope.ts
// ---------------------------------------------------------------------------

// NoInputPlaceholder ports NO_INPUT_PLACEHOLDER.
const NoInputPlaceholder = "(no input)"

// FormatAnswerScalar ports formatAnswerScalar (the variant is unused).
func FormatAnswerScalar(a Answer) string {
	switch a.Kind {
	case KindMulti:
		if len(a.Selected) > 0 {
			return strings.Join(a.Selected, ", ")
		}
		return NoInputPlaceholder
	case KindCustom:
		if a.Answer != nil && *a.Answer != "" {
			return *a.Answer
		}
		return NoInputPlaceholder
	default:
		if a.Answer != nil {
			return *a.Answer
		}
		return NoInputPlaceholder
	}
}

// Envelope texts.
const (
	DeclineMessage = "User declined to answer questions"
	EnvelopePrefix = "User has answered your questions:"
	EnvelopeSuffix = "You can now continue with the user's answers in mind."
)

// ToolResult is buildToolResult's value: one text block and the details.
type ToolResult struct {
	Text    string
	Details Result
}

// BuildToolResult ports buildToolResult.
func BuildToolResult(text string, details Result) ToolResult {
	return ToolResult{Text: text, Details: details}
}

// BuildAnswerSegment ports buildAnswerSegment.
func BuildAnswerSegment(a Answer) string {
	parts := []string{`"` + a.Question + `"="` + FormatAnswerScalar(a) + `"`}
	if a.Preview != nil && *a.Preview != "" {
		parts = append(parts, "selected preview: "+*a.Preview)
	}
	if a.Notes != nil && *a.Notes != "" {
		parts = append(parts, "user notes: "+*a.Notes)
	}
	return strings.Join(parts, ". ") + "."
}

// BuildQuestionnaireResponse ports buildQuestionnaireResponse. A nil result
// is undefined.
func BuildQuestionnaireResponse(result *Result, p Params) ToolResult {
	if result == nil || result.Cancelled {
		answers := []Answer{}
		if result != nil && result.Answers != nil {
			answers = result.Answers
		}
		return BuildToolResult(DeclineMessage, Result{Answers: answers, Cancelled: true})
	}
	var segments []string
	for i := range p.Questions {
		for _, a := range result.Answers {
			if a.QuestionIndex == i {
				segments = append(segments, BuildAnswerSegment(a))
				break
			}
		}
	}
	if len(segments) == 0 {
		return BuildToolResult(DeclineMessage, Result{Answers: result.Answers, Cancelled: true})
	}
	return BuildToolResult(EnvelopePrefix+" "+strings.Join(segments, " ")+" "+EnvelopeSuffix, *result)
}

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

// ConfigName is the config namespace (~/.config/rpiv-ask-user-question).
const ConfigName = "rpiv-ask-user-question"

// Collapse key defaults.
const (
	DefaultCollapseKey = "ctrl+]"
	CollapseKeyOff     = "off"
)

// Config is AskUserQuestionConfig as loaded JSON.
type Config map[string]any

// LoadConfig ports loadConfig.
func LoadConfig(env rpivconfig.Env, warn func(string)) Config {
	return Config(rpivconfig.LoadJSONConfigWithLegacyFallback(env, ConfigName, "", warn))
}

var specialKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range []string{"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageup", "pagedown", "up", "down", "left", "right"} {
		m[k] = true
	}
	for i := 1; i <= 12; i++ {
		m["f"+strconv.Itoa(i)] = true
	}
	return m
}()

var modifiers = map[string]bool{"ctrl": true, "shift": true, "alt": true, "super": true}

var printableKey = regexp.MustCompile(`[a-z0-9_\-!@#$%^&*()|~` + "`" + `'":;,./<>?\[\]{}=\\]`)

// isValidCollapseKeySpec ports isValidCollapseKeySpec.
func isValidCollapseKeySpec(spec string) bool {
	if spec == "" {
		return false
	}
	if strings.HasPrefix(spec, "+") || strings.HasSuffix(spec, "+") || strings.Contains(spec, "++") {
		return false
	}
	parts := strings.Split(spec, "+")
	base := parts[len(parts)-1]
	mods := parts[:len(parts)-1]
	seen := map[string]bool{}
	for _, m := range mods {
		if seen[m] {
			return false
		}
		seen[m] = true
	}
	for _, m := range mods {
		if !modifiers[m] {
			return false
		}
	}
	if jsstr.Len16(base) == 1 {
		return printableKey.MatchString(base)
	}
	return specialKeys[base]
}

// CollapseKeyTypeError is the TypeError TypeScript throws when collapseKey
// is set to a value that is not a string.
const CollapseKeyTypeError = "config.collapseKey?.trim is not a function"

// ResolveCollapseKey ports resolveCollapseKey. A collapseKey that is set but
// not a string makes TypeScript throw; ok is false then.
func ResolveCollapseKey(c Config) (key string, ok bool) {
	rawValue, present := c["collapseKey"]
	if !present || rawValue == nil {
		return DefaultCollapseKey, true
	}
	s, isString := rawValue.(string)
	if !isString {
		return "", false
	}
	raw := strings.ToLower(jsstr.Trim(s))
	if raw == "" {
		return DefaultCollapseKey, true
	}
	if raw == CollapseKeyOff {
		return CollapseKeyOff, true
	}
	if isValidCollapseKeySpec(raw) {
		return raw, true
	}
	return DefaultCollapseKey, true
}
