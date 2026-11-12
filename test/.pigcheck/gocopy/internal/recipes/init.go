package recipes

// `/recipe init` (port of recipes/index.ts initDirectoryRecipe and its
// helpers suggestRecipeName, recipeScaffold, parseInitArgs). The command
// writes a self-contained `.pi-recipe` in the cwd and trusts it.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ReservedNames are the `/recipe <word>` subcommands (RESERVED_NAMES); a
// recipe literally named one keeps switching, but init never creates one.
var ReservedNames = []string{"off", "none", "status", "trust", "untrust", "init"}

var (
	recipeNameRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	nonWordRunRe  = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)
	leadingJunkRe = regexp.MustCompile(`^[^a-z0-9]+`)
)

func reserved(name string) bool { return contains(ReservedNames, name) }

// jsBasename is Node's path.basename: "" for "" and "/".
func jsBasename(path string) string {
	trimmed := strings.TrimRight(path, "/")
	if trimmed == "" {
		return ""
	}
	return filepath.Base(trimmed)
}

// SuggestName is suggestRecipeName: the cwd's folder name, lowercased, with
// runs of other characters as "-" and no leading non-alphanumerics; else
// "project".
func SuggestName(cwd string) string {
	base := strings.ToLower(jsBasename(cwd))
	base = nonWordRunRe.ReplaceAllString(base, "-")
	base = leadingJunkRe.ReplaceAllString(base, "")
	if base != "" && !reserved(base) {
		return base
	}
	return "project"
}

// ValidName is validRecipeName.
func ValidName(name string) bool {
	return recipeNameRe.MatchString(name) && !reserved(strings.ToLower(name))
}

// InvalidNameMessage is notifyInvalidName's text.
func InvalidNameMessage(name string) string {
	return fmt.Sprintf(`Invalid recipe name "%s" — use letters, digits, ".", "_" or "-" (not %s)`, name, strings.Join(ReservedNames, "/"))
}

// InitArgs is parseInitArgs' result. From "" means no template.
type InitArgs struct {
	Name  string
	From  string
	Error string
}

// ParseInitArgs parses `init [name] [--from <recipe>]` (the text after "init").
func ParseInitArgs(arg string) InitArgs {
	tokens := strings.FieldsFunc(jsTrim(arg), jsstr.IsJSSpace)
	var out InitArgs
	var rest []string
	for i := 0; i < len(tokens); i++ {
		token := tokens[i]
		switch {
		case token == "--from":
			i++
			if i >= len(tokens) {
				return InitArgs{Error: "--from needs one of your recipe names"}
			}
			out.From = tokens[i]
		case strings.HasPrefix(token, "--from="):
			out.From = token[len("--from="):]
		default:
			rest = append(rest, token)
		}
	}
	out.Name = strings.Join(rest, " ")
	return out
}

// Seed is the live session state a blank scaffold starts from.
type Seed struct {
	Description   string
	Model         string // "provider/id", or ""
	ThinkingLevel string // a valid level, or ""
}

// Scaffold is recipeScaffold: the `.pi-recipe` text with every key present.
// A template (a home recipe) is copied: its model, scope, MCP servers,
// extensions, blocklist, and its permissionMode and style. A blank scaffold
// is seeded from the live model and never picks a mode or style.
func Scaffold(name string, seed Seed, template *Definition) string {
	q := jsstr.QuoteJS
	description := seed.Description
	if description == "" {
		description = "Recipe for " + name
	}
	model, thinking := seed.Model, seed.ThinkingLevel
	if template != nil {
		if template.Config.Description != "" {
			description = template.Config.Description
		}
		model, thinking = template.Config.Model, template.Config.ThinkingLevel
	}
	fields := []string{`"description":` + q(description)}
	if model != "" {
		fields = append(fields, `"model":`+q(model))
	}
	if thinking != "" {
		fields = append(fields, `"thinkingLevel":`+q(thinking))
	}
	// An empty `models` means "no scope", so the scaffold scopes itself to
	// its own model and the file alone decides what is available.
	var models []string
	switch {
	case template != nil && len(template.Config.Models) > 0:
		models = template.Config.Models
	case model != "":
		parsed, _ := ParseModelSpec(model)
		models = []string{parsed}
	}
	fields = append(fields, `"models":`+stringList(models))
	mcp, extensions, entries := "{}", []string(nil), []string(nil)
	if template != nil {
		if template.copy.mcpServers != "" {
			mcp = template.copy.mcpServers
		}
		extensions, entries = template.Config.Extensions, template.copy.blocklist
	}
	fields = append(fields,
		`"mcpServers":`+mcp,
		`"extensions":`+stringList(extensions),
		`"blocklist":{"entries":[`+strings.Join(entries, ",")+`]}`)
	if template != nil && template.Config.PermissionMode != "" {
		fields = append(fields, `"permissionMode":`+q(template.Config.PermissionMode))
	}
	if template != nil && template.Config.Style != "" {
		fields = append(fields, `"style":`+q(template.Config.Style))
	}
	doc := `{"defaultRecipe":` + q(name) + `,"recipes":{` + q(name) + `:{` + strings.Join(fields, ",") + `}}}`
	return jsstr.StringifyIndent([]byte(doc), "  ") + "\n"
}

func stringList(items []string) string {
	quoted := make([]string, len(items))
	for i, item := range items {
		quoted[i] = jsstr.QuoteJS(item)
	}
	return "[" + strings.Join(quoted, ",") + "]"
}

// InitHost is what `/recipe init` needs from the session.
type InitHost interface {
	Cwd() string
	HasUI() bool
	// Select returns the chosen option, ok=false when cancelled.
	Select(title string, options []string) (string, bool)
	// Input returns the typed text, ok=false when cancelled.
	Input(title, placeholder string) (string, bool)
	Notify(message, level string)
	// Model is the live model as "provider/id", or "".
	Model() string
	ThinkingLevel() string
	// Refresh reloads the session's recipes after the file is written.
	Refresh()
}

// BlankTemplateLabel is the picker's first option.
const BlankTemplateLabel = "Blank recipe (current model)"

// Init is initDirectoryRecipe. paths locate the home (global) recipes and
// store is the trust store. It returns the created file, or "".
func Init(h InitHost, paths Paths, store, arg string) string {
	cwd := h.Cwd()
	if existing := DirectoryPath(cwd); existing != "" {
		h.Notify(fmt.Sprintf("%s already exists in %s — edit it, or delete it to start over", filepath.Base(existing), cwd), "warning")
		return ""
	}
	parsed := ParseInitArgs(arg)
	if parsed.Error != "" {
		h.Notify("recipes: "+parsed.Error, "error")
		return ""
	}
	if parsed.Name != "" && !ValidName(parsed.Name) {
		h.Notify(InvalidNameMessage(parsed.Name), "error")
		return ""
	}
	templates := Load(paths, "", false, false).Recipes
	var template *Definition
	if parsed.From != "" {
		template = templates[parsed.From]
		if template == nil {
			names := make([]string, 0, len(templates))
			for name := range templates {
				names = append(names, name)
			}
			sortCodeUnits(names)
			list := strings.Join(names, ", ")
			if list == "" {
				list = "none configured"
			}
			h.Notify(fmt.Sprintf(`Unknown home recipe "%s". Available: %s`, parsed.From, list), "error")
			return ""
		}
	} else if h.HasUI() && len(templates) > 0 {
		names, labels := SelectionLabels(templates)
		options := []string{BlankTemplateLabel}
		for _, label := range labels {
			options = append(options, "Copy "+label)
		}
		choice, ok := h.Select("Create .pi-recipe — start from:", options)
		if !ok || choice == "" {
			return ""
		}
		if choice != BlankTemplateLabel {
			picked := strings.TrimPrefix(choice, "Copy ")
			for i, label := range labels {
				if label == picked {
					template = templates[names[i]]
					break
				}
			}
		}
	}

	suggestion := SuggestName(cwd)
	name := parsed.Name
	if name == "" && h.HasUI() {
		typed, ok := h.Input("Recipe name for this folder's .pi-recipe", suggestion)
		if !ok {
			return ""
		}
		name = jsTrim(typed)
	}
	if name == "" {
		name = suggestion
	}
	if !ValidName(name) {
		h.Notify(InvalidNameMessage(name), "error")
		return ""
	}

	seedName := jsBasename(cwd)
	if seedName == "" {
		seedName = name
	}
	seed := Seed{Description: "Recipe for " + seedName, Model: h.Model()}
	if level := h.ThinkingLevel(); contains(ThinkingLevels, level) {
		seed.ThinkingLevel = level
	}
	content := Scaffold(name, seed, template)
	file := filepath.Join(cwd, DirectoryFileNames[0])
	if err := writeExclusive(file, content); err != nil {
		h.Notify(fmt.Sprintf("recipes: could not create %s: %s", file, nodeOpenError(err, file)), "error")
		return ""
	}
	// You created it yourself: this exact version is trusted.
	trusted := RecordTrust(file, store, true) == nil
	h.Refresh()
	trustNote := "trusted"
	if !trusted {
		trustNote = "trust not saved — run /recipe trust"
	}
	seeded := "seeded from the current model"
	if template != nil {
		seeded = fmt.Sprintf(`copied from your "%s" recipe`, template.Name)
	}
	h.Notify(fmt.Sprintf(`Created %s with recipe "%s" %s (%s). Fill in the fields you need; after you edit it, the next start asks once to trust the new version. /recipe %s switches now.`,
		file, name, seeded, trustNote, name), "info")
	if template != nil && len(template.Config.McpServers) > 0 {
		h.Notify(fmt.Sprintf(`%s includes MCP server configs copied verbatim from "%s" — remove any tokens or headers before committing it`,
			filepath.Base(file), template.Name), "warning")
	}
	return file
}

// writeExclusive is writeFileSync(file, content, { flag: "wx" }).
func writeExclusive(file, content string) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// nodeOpenError rebuilds Node's message for a failed open of path.
func nodeOpenError(err error, path string) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		if errors.Is(err, fs.ErrNotExist) {
			errno = syscall.ENOENT
		} else {
			return err.Error()
		}
	}
	codes := map[syscall.Errno][2]string{
		syscall.ENOENT:  {"ENOENT", "no such file or directory"},
		syscall.EACCES:  {"EACCES", "permission denied"},
		syscall.EISDIR:  {"EISDIR", "illegal operation on a directory"},
		syscall.ENOTDIR: {"ENOTDIR", "not a directory"},
		syscall.EEXIST:  {"EEXIST", "file already exists"},
		syscall.EPERM:   {"EPERM", "operation not permitted"},
		syscall.EROFS:   {"EROFS", "read-only file system"},
	}
	code, ok := codes[errno]
	if !ok {
		return err.Error()
	}
	return fmt.Sprintf("%s: %s, open '%s'", code[0], code[1], path)
}

// sortCodeUnits is Array.prototype.sort without a comparator (UTF-16 code
// unit order).
func sortCodeUnits(names []string) {
	sort.Slice(names, func(i, j int) bool { return lessCodeUnits(names[i], names[j]) })
}

func lessCodeUnits(a, b string) bool {
	ua, ub := jsstr.Units(a), jsstr.Units(b)
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
