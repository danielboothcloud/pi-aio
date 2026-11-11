// Package askuserquestion is the Go port of ask-user-question/ (vendored
// from @juicesharp/rpiv-ask-user-question 2.0.0, MIT): the
// ask_user_question tool, its tabbed questionnaire overlay, the RPC dialog
// fallback, the rpiv:ask-user:prompt event, and the tool reconciler. The
// package does not import the SDK; go/aio/askuserquestion.go connects it to
// the PiG host.
package askuserquestion

import (
	"encoding/json"
)

// Limits from tool/types.ts.
const (
	MaxQuestions    = 4
	MinOptions      = 2
	MaxOptions      = 4
	MaxHeaderLength = 16
	MaxLabelLength  = 60
)

// Option is OptionData. Preview nil is an absent preview.
type Option struct {
	Label       string
	Description string
	Preview     *string
}

// HasPreview is `typeof preview === "string" && preview.length > 0`.
func (o Option) HasPreview() bool { return o.Preview != nil && *o.Preview != "" }

// Question is QuestionData. MultiSelect nil is absent (false).
type Question struct {
	Question    string
	Header      string
	Options     []Option
	MultiSelect *bool
}

// IsMulti is `multiSelect === true`.
func (q Question) IsMulti() bool { return q.MultiSelect != nil && *q.MultiSelect }

// Params is QuestionParams.
type Params struct {
	Questions []Question
}

// Answer kinds (QuestionAnswer.kind).
const (
	KindOption = "option"
	KindCustom = "custom"
	KindMulti  = "multi"
)

// Answer is QuestionAnswer. Answer nil is null; Selected nil is absent (an
// empty non-nil slice is `[]`); Notes and Preview nil are absent.
type Answer struct {
	QuestionIndex int
	Question      string
	Kind          string
	Answer        *string
	Selected      []string
	Notes         *string
	Preview       *string
}

// MarshalJSON writes the TypeScript shape with absent fields omitted.
func (a Answer) MarshalJSON() ([]byte, error) {
	type field struct {
		key   string
		value any
	}
	fields := []field{{"questionIndex", a.QuestionIndex}, {"question", a.Question}, {"kind", a.Kind}, {"answer", a.Answer}}
	if a.Selected != nil {
		fields = append(fields, field{"selected", a.Selected})
	}
	if a.Notes != nil {
		fields = append(fields, field{"notes", *a.Notes})
	}
	if a.Preview != nil {
		fields = append(fields, field{"preview", *a.Preview})
	}
	out := []byte{'{'}
	for i, f := range fields {
		if i > 0 {
			out = append(out, ',')
		}
		k, _ := json.Marshal(f.key)
		v, err := json.Marshal(f.value)
		if err != nil {
			return nil, err
		}
		out = append(append(append(out, k...), ':'), v...)
	}
	return append(out, '}'), nil
}

// UnmarshalJSON reads the TypeScript shape (golden data).
func (a *Answer) UnmarshalJSON(data []byte) error {
	var raw struct {
		QuestionIndex int       `json:"questionIndex"`
		Question      string    `json:"question"`
		Kind          string    `json:"kind"`
		Answer        *string   `json:"answer"`
		Selected      *[]string `json:"selected"`
		Notes         *string   `json:"notes"`
		Preview       *string   `json:"preview"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*a = Answer{QuestionIndex: raw.QuestionIndex, Question: raw.Question, Kind: raw.Kind, Answer: raw.Answer, Notes: raw.Notes, Preview: raw.Preview}
	if raw.Selected != nil {
		a.Selected = append([]string{}, (*raw.Selected)...)
	}
	return nil
}

// Error codes (QuestionnaireError).
const (
	ErrNoUI                 = "no_ui"
	ErrNoCustomUI           = "no_custom_ui"
	ErrNoQuestions          = "no_questions"
	ErrEmptyOptions         = "empty_options"
	ErrTooManyQuestions     = "too_many_questions"
	ErrDuplicateQuestion    = "duplicate_question"
	ErrDuplicateOptionLabel = "duplicate_option_label"
	ErrReservedLabel        = "reserved_label"
)

// Result is QuestionnaireResult.
type Result struct {
	Answers   []Answer `json:"answers"`
	Cancelled bool     `json:"cancelled"`
	Error     string   `json:"error,omitempty"`
}

// MarshalJSON writes answers as [] rather than null.
func (r Result) MarshalJSON() ([]byte, error) {
	type plain Result
	if r.Answers == nil {
		r.Answers = []Answer{}
	}
	return json.Marshal(plain(r))
}

func strPtr(s string) *string { return &s }

// DecodeParams reads the tool arguments (validated by the host against
// the schema) into Params. Missing strings are "".
func DecodeParams(raw map[string]any) Params {
	var p Params
	questions, _ := raw["questions"].([]any)
	for _, rq := range questions {
		m, _ := rq.(map[string]any)
		var q Question
		q.Question, _ = m["question"].(string)
		q.Header, _ = m["header"].(string)
		if b, ok := m["multiSelect"].(bool); ok {
			q.MultiSelect = &b
		}
		options, _ := m["options"].([]any)
		for _, ro := range options {
			om, _ := ro.(map[string]any)
			var o Option
			o.Label, _ = om["label"].(string)
			o.Description, _ = om["description"].(string)
			if s, ok := om["preview"].(string); ok {
				o.Preview = &s
			}
			q.Options = append(q.Options, o)
		}
		p.Questions = append(p.Questions, q)
	}
	return p
}
