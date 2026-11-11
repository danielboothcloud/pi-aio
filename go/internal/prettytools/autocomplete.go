package prettytools

// Port of autocomplete.ts (the FFF @-mention provider) and the FFF parts of
// index.ts. The Go port has no FFF finder, so it registers no provider and
// the /fff-* commands report FFF as not initialized, as TypeScript does when
// @ff-labs/fff-node does not load. The provider logic stays as tested
// library code for a finder that a later host may offer.

import (
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// FFFNotInitialized is the /fff-health and /fff-rescan notice without FFF.
const FFFNotInitialized = "FFF not initialized"

// FFF commands and the expand shortcut of index.ts.
const (
	FFFHealthDescription  = "Show FFF file finder health and indexer status"
	FFFRescanDescription  = "Trigger FFF to rescan files"
	ExpandShortcut        = "ctrl+shift+o"
	ExpandShortcutSummary = "Expand all tool output"
)

// MaxSuggestions is MAX_SUGGESTIONS.
const MaxSuggestions = 20

// AutocompleteItem is pi-tui's AutocompleteItem.
type AutocompleteItem struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// FileItem is the part of an FFF search item the provider reads.
type FileItem struct {
	RelativePath string
	FileName     string
}

// Finder is the FFF finder's fileSearch. ok=false is a failed search; an
// error is a throw.
type Finder interface {
	FileSearch(query string, pageSize int) (items []FileItem, ok bool, err error)
}

var atPrefixRe = regexp.MustCompile(`(?:^|[ \t])@([^` + jsS + `@]*)$`)

// ExtractAtPrefix ports extractAtPrefix: the query after an @ before the
// cursor; ok=false when there is no @ trigger.
func ExtractAtPrefix(textBeforeCursor string) (string, bool) {
	m := atPrefixRe.FindStringSubmatch(textBeforeCursor)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// ToMentionValue ports toMentionValue: @path, quoted when it has spaces.
func ToMentionValue(path string) string {
	if strings.IndexFunc(path, jsstr.IsJSSpace) >= 0 {
		return `@"` + strings.ReplaceAll(path, `"`, `\"`) + `"`
	}
	return "@" + path
}

// FffSuggestions ports the provider's getSuggestions: the FFF items for an
// @-mention, or delegate=true when the built-in provider answers.
func FffSuggestions(lines []string, cursorLine, cursorCol int, finder Finder) (items []AutocompleteItem, prefix string, delegate bool) {
	line := ""
	if cursorLine >= 0 && cursorLine < len(lines) {
		line = lines[cursorLine]
	}
	query, ok := ExtractAtPrefix(jsstr.Slice(line, 0, cursorCol))
	if !ok || finder == nil {
		return nil, "", true
	}
	found, ok, err := finder.FileSearch(query, MaxSuggestions)
	if err != nil || !ok || len(found) == 0 {
		return nil, "", true
	}
	for _, item := range found {
		items = append(items, AutocompleteItem{
			Value:       ToMentionValue(item.RelativePath),
			Label:       item.FileName,
			Description: jsstr.Slice(item.RelativePath, 0, -(jsstr.Len16(item.FileName) + 1)),
		})
	}
	return items, "@" + query, false
}
