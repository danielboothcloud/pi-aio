package askuserquestion

// Port of rpc-fallback.ts: the select/input dialog walker for hosts that
// cannot render the overlay.

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// RPC fallback texts.
const (
	MultiSelectInstructions = `Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.`
	CustomAnswerTitle       = "Type your answer:"
	MultiSelectPlaceholder  = "1,3"
	MaxPreviewChars         = 600
)

// DialogUI is the dialog-primitive slice of the UI context. ok false is
// undefined (dismissed); a nil value with ok true is null.
type DialogUI interface {
	Select(title string, options []string) (value any, ok bool)
	Input(title, placeholder string) (value any, ok bool)
}

func formatOptionLine(o Option, index int) string {
	return strconv.Itoa(index+1) + ". " + o.Label + " — " + o.Description
}

// jsString is String(value) for the JSON values a dialog answers with.
func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return jsstr.NumberJS(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	return "[object Object]"
}

// parseIntJS is Number.parseInt(token, 10); ok false is NaN.
func parseIntJS(token string) (int, bool) {
	s := strings.TrimLeftFunc(token, jsstr.IsJSSpace)
	sign := 1
	if strings.HasPrefix(s, "-") {
		sign, s = -1, s[1:]
	} else if strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	n, digits := 0, 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		if n < 1<<40 {
			n = n*10 + int(s[digits]-'0')
		}
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	return sign * n, true
}

func parseIndex(token string, count int) (int, bool) {
	n, ok := parseIntJS(token)
	if !ok {
		return 0, false
	}
	i := n - 1
	return i, i >= 0 && i < count
}

func buildPreviewBlock(q Question) string {
	var blocks []string
	for i, o := range q.Options {
		if o.HasPreview() {
			blocks = append(blocks, "--- "+strconv.Itoa(i+1)+". "+o.Label+" preview ---\n"+jsstr.Slice16(*o.Preview, MaxPreviewChars))
		}
	}
	if len(blocks) == 0 {
		return ""
	}
	return "\n\n" + strings.Join(blocks, "\n\n")
}

// RunRPCQuestionnaire ports runRpcQuestionnaire.
func RunRPCQuestionnaire(ui DialogUI, p Params) Result {
	answers := []Answer{}
	for qi, q := range p.Questions {
		header := ""
		if q.Header != "" {
			header = "[" + q.Header + "] "
		}
		var answer *Answer
		if q.IsMulti() {
			answer = askMultiSelect(ui, q, qi, header)
		} else {
			answer = askSingleSelect(ui, q, qi, header)
		}
		if answer == nil {
			return Result{Answers: answers, Cancelled: true}
		}
		answers = append(answers, *answer)
	}
	return Result{Answers: answers, Cancelled: false}
}

func askSingleSelect(ui DialogUI, q Question, qi int, header string) *Answer {
	options := make([]string, 0, len(q.Options)+1)
	for i, o := range q.Options {
		options = append(options, formatOptionLine(o, i))
	}
	options = append(options, strconv.Itoa(len(q.Options)+1)+". "+DisplayLabel(RowOther))
	chosen, ok := ui.Select(header+q.Question+buildPreviewBlock(q), options)
	if !ok || chosen == nil {
		return nil
	}
	idx, ok := parseIndex(jsString(chosen), len(options))
	if !ok {
		return nil
	}
	if idx < len(q.Options) {
		o := q.Options[idx]
		a := &Answer{QuestionIndex: qi, Question: q.Question, Kind: KindOption, Answer: strPtr(o.Label)}
		if o.HasPreview() {
			a.Preview = strPtr(*o.Preview)
		}
		return a
	}
	typed, ok := ui.Input(header+q.Question+"\n\n"+T("rpc.custom_answer_title", CustomAnswerTitle), "")
	if !ok || typed == nil {
		return nil
	}
	return &Answer{QuestionIndex: qi, Question: q.Question, Kind: KindCustom, Answer: strPtr(jsString(typed))}
}

var (
	tokenSplit = regexp.MustCompile(`[,\s\x0b\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	indexToken = regexp.MustCompile(`^[0-9]+\.?$`)
)

func askMultiSelect(ui DialogUI, q Question, qi int, header string) *Answer {
	lines := make([]string, len(q.Options))
	for i, o := range q.Options {
		lines[i] = formatOptionLine(o, i)
	}
	value, ok := ui.Input(header+q.Question+"\n\n"+strings.Join(lines, "\n")+"\n\n"+T("rpc.multi_instructions", MultiSelectInstructions), MultiSelectPlaceholder)
	if !ok || value == nil {
		return nil
	}
	trimmed := jsstr.Trim(jsString(value))
	if trimmed == "" {
		return &Answer{QuestionIndex: qi, Question: q.Question, Kind: KindMulti, Selected: []string{}}
	}
	var tokens []string
	for _, tok := range tokenSplit.Split(trimmed, -1) {
		if tok != "" {
			tokens = append(tokens, tok)
		}
	}
	indices := make([]int, 0, len(tokens))
	all := true
	for _, tok := range tokens {
		if !indexToken.MatchString(tok) {
			all = false
			break
		}
		i, ok := parseIndex(tok, len(q.Options))
		if !ok {
			all = false
			break
		}
		indices = append(indices, i)
	}
	if all {
		selected := []string{}
		for _, i := range indices {
			label := q.Options[i].Label
			dup := false
			for _, s := range selected {
				if s == label {
					dup = true
					break
				}
			}
			if !dup {
				selected = append(selected, label)
			}
		}
		return &Answer{QuestionIndex: qi, Question: q.Question, Kind: KindMulti, Selected: selected}
	}
	return &Answer{QuestionIndex: qi, Question: q.Question, Kind: KindCustom, Answer: strPtr(trimmed)}
}
