// Package piargs is the Go port of Pi's CLI parser (`parseArgs`), as
// vendored in recipes/pig-launch/args.ts (MIT, Earendil Works). Go features
// use it to read pig's own argv from PIG_HARNESS_ARGV_FILE.
package piargs

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
)

// Diagnostic is a parser warning or error.
type Diagnostic struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// Args is the parsed command line. Unset optional values are nil.
type Args struct {
	Provider             *string       `json:"provider,omitempty"`
	Model                *string       `json:"model,omitempty"`
	APIKey               *string       `json:"apiKey,omitempty"`
	SystemPrompt         *string       `json:"systemPrompt,omitempty"`
	AppendSystemPrompt   []string      `json:"appendSystemPrompt,omitempty"`
	Thinking             *string       `json:"thinking,omitempty"`
	Continue             bool          `json:"continue,omitempty"`
	Resume               bool          `json:"resume,omitempty"`
	Help                 bool          `json:"help,omitempty"`
	Version              bool          `json:"version,omitempty"`
	Mode                 *string       `json:"mode,omitempty"`
	Name                 *string       `json:"name,omitempty"`
	NoSession            bool          `json:"noSession,omitempty"`
	Session              *string       `json:"session,omitempty"`
	SessionID            *string       `json:"sessionId,omitempty"`
	Fork                 *string       `json:"fork,omitempty"`
	SessionDir           *string       `json:"sessionDir,omitempty"`
	Models               []string      `json:"models,omitempty"`
	Tools                []string      `json:"tools,omitempty"`
	ExcludeTools         []string      `json:"excludeTools,omitempty"`
	NoTools              bool          `json:"noTools,omitempty"`
	NoBuiltinTools       bool          `json:"noBuiltinTools,omitempty"`
	Extensions           []string      `json:"extensions,omitempty"`
	NoExtensions         bool          `json:"noExtensions,omitempty"`
	NoMcp                bool          `json:"noMcp,omitempty"`
	Print                bool          `json:"print,omitempty"`
	Export               *string       `json:"export,omitempty"`
	NoSkills             bool          `json:"noSkills,omitempty"`
	Skills               []string      `json:"skills,omitempty"`
	PromptTemplates      []string      `json:"promptTemplates,omitempty"`
	NoPromptTemplates    bool          `json:"noPromptTemplates,omitempty"`
	Themes               []string      `json:"themes,omitempty"`
	UseTheme             *string       `json:"useTheme,omitempty"`
	NoThemes             bool          `json:"noThemes,omitempty"`
	NoContextFiles       bool          `json:"noContextFiles,omitempty"`
	ListModels           any           `json:"listModels,omitempty"` // string or true
	TuiMode              *string       `json:"tuiMode,omitempty"`
	Verbose              bool          `json:"verbose,omitempty"`
	ProjectTrustOverride *bool         `json:"projectTrustOverride,omitempty"`
	Offline              bool          `json:"offline,omitempty"`
	Messages             []string      `json:"messages"`
	FileArgs             []string      `json:"fileArgs"`
	UnknownFlags         []UnknownFlag `json:"unknownFlags"`
	Diagnostics          []Diagnostic  `json:"diagnostics"`
}

// UnknownFlag is one entry of the unknownFlags Map, in insertion order. A
// repeated flag keeps its first position and its last value.
type UnknownFlag struct {
	Name  string `json:"name"`
	Value any    `json:"value"` // string or true
}

var thinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func splitList(value string) []string {
	out := []string{}
	for _, entry := range strings.Split(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			out = append(out, entry)
		}
	}
	return out
}

func ptr(s string) *string { return &s }

func (a *Args) setUnknown(name string, value any) {
	for i := range a.UnknownFlags {
		if a.UnknownFlags[i].Name == name {
			a.UnknownFlags[i].Value = value
			return
		}
	}
	a.UnknownFlags = append(a.UnknownFlags, UnknownFlag{name, value})
}

func (a *Args) diag(kind, message string) {
	a.Diagnostics = append(a.Diagnostics, Diagnostic{kind, message})
}

// Parse is parseArgs.
func Parse(args []string) Args {
	r := Args{Messages: []string{}, FileArgs: []string{}, UnknownFlags: []UnknownFlag{}, Diagnostics: []Diagnostic{}}
	n := len(args)
	hasNext := func(i int) bool { return i+1 < n }
	for i := 0; i < n; i++ {
		arg := args[i]
		switch {
		case arg == "--":
			for _, p := range args[i+1:] {
				if strings.HasPrefix(p, "@") {
					r.FileArgs = append(r.FileArgs, p[1:])
				} else {
					r.Messages = append(r.Messages, p)
				}
			}
			return r
		case arg == "--help" || arg == "-h":
			r.Help = true
		case arg == "--version" || arg == "-v":
			r.Version = true
		case arg == "--mode":
			if !hasNext(i) || strings.HasPrefix(args[i+1], "-") {
				r.diag("error", "--mode requires text, json, or rpc")
				continue
			}
			i++
			mode := args[i]
			if mode != "text" && mode != "json" && mode != "rpc" {
				r.diag("error", `Invalid mode "`+mode+`". Valid values: text, json, rpc`)
				continue
			}
			r.Mode = ptr(mode)
		case arg == "--continue" || arg == "-c":
			r.Continue = true
		case arg == "--resume" || arg == "-r":
			r.Resume = true
		case arg == "--provider" && hasNext(i):
			i++
			r.Provider = ptr(args[i])
		case arg == "--model" && hasNext(i):
			i++
			r.Model = ptr(args[i])
		case arg == "--api-key" && hasNext(i):
			i++
			r.APIKey = ptr(args[i])
		case arg == "--system-prompt" && hasNext(i):
			i++
			r.SystemPrompt = ptr(args[i])
		case arg == "--append-system-prompt" && hasNext(i):
			i++
			r.AppendSystemPrompt = append(r.AppendSystemPrompt, args[i])
		case arg == "--name" || arg == "-n":
			if hasNext(i) {
				i++
				r.Name = ptr(args[i])
			} else {
				r.diag("error", "--name requires a value")
			}
		case arg == "--no-session":
			r.NoSession = true
		case arg == "--session" && hasNext(i):
			i++
			r.Session = ptr(args[i])
		case arg == "--session-id" && hasNext(i):
			i++
			r.SessionID = ptr(args[i])
		case arg == "--fork" && hasNext(i):
			i++
			r.Fork = ptr(args[i])
		case arg == "--session-dir" && hasNext(i):
			i++
			r.SessionDir = ptr(args[i])
		case arg == "--models" && hasNext(i):
			i++
			r.Models = splitList(args[i])
		case arg == "--no-tools" || arg == "-nt":
			r.NoTools = true
		case arg == "--no-builtin-tools" || arg == "-nbt":
			r.NoBuiltinTools = true
		case (arg == "--tools" || arg == "-t") && hasNext(i):
			i++
			r.Tools = splitList(args[i])
		case (arg == "--exclude-tools" || arg == "-xt") && hasNext(i):
			i++
			r.ExcludeTools = splitList(args[i])
		case arg == "--thinking" && hasNext(i):
			i++
			level := args[i]
			if slices.Contains(thinkingLevels, level) {
				r.Thinking = ptr(level)
			} else {
				r.diag("warning", `Invalid thinking level "`+level+`". Valid values: `+strings.Join(thinkingLevels, ", "))
			}
		case arg == "--print" || arg == "-p":
			r.Print = true
			if hasNext(i) {
				next := args[i+1]
				if !strings.HasPrefix(next, "@") && (!strings.HasPrefix(next, "-") || strings.HasPrefix(next, "---")) {
					r.Messages = append(r.Messages, next)
					i++
				}
			}
		case arg == "--export" && hasNext(i):
			i++
			r.Export = ptr(args[i])
		case (arg == "--extension" || arg == "-e") && hasNext(i):
			i++
			r.Extensions = append(r.Extensions, args[i])
		case arg == "--no-extensions" || arg == "-ne":
			r.NoExtensions = true
		case arg == "--no-mcp":
			r.NoMcp = true
		case arg == "--skill" && hasNext(i):
			i++
			r.Skills = append(r.Skills, args[i])
		case arg == "--prompt-template" && hasNext(i):
			i++
			r.PromptTemplates = append(r.PromptTemplates, args[i])
		case arg == "--theme" && hasNext(i):
			i++
			r.Themes = append(r.Themes, args[i])
		case arg == "--use-theme":
			if !hasNext(i) || strings.HasPrefix(args[i+1], "-") {
				r.diag("error", "--use-theme requires a theme name")
			} else {
				i++
				r.UseTheme = ptr(args[i])
			}
		case arg == "--no-skills" || arg == "-ns":
			r.NoSkills = true
		case arg == "--no-prompt-templates" || arg == "-np":
			r.NoPromptTemplates = true
		case arg == "--no-themes":
			r.NoThemes = true
		case arg == "--no-context-files" || arg == "-nc":
			r.NoContextFiles = true
		case arg == "--list-models":
			if hasNext(i) && !strings.HasPrefix(args[i+1], "-") && !strings.HasPrefix(args[i+1], "@") {
				i++
				r.ListModels = args[i]
			} else {
				r.ListModels = true
			}
		case arg == "--tui-mode":
			if !hasNext(i) {
				r.diag("error", "--tui-mode requires regular or fullscreen")
				continue
			}
			mode := args[i+1]
			switch {
			case mode == "regular" || mode == "fullscreen":
				r.TuiMode = ptr(mode)
				i++
			case strings.HasPrefix(mode, "-"):
				r.diag("error", "--tui-mode requires regular or fullscreen")
			default:
				i++
				r.diag("error", `Invalid TUI mode "`+mode+`". Valid values: regular, fullscreen`)
			}
		case arg == "--verbose":
			r.Verbose = true
		case arg == "--approve" || arg == "-a":
			t := true
			r.ProjectTrustOverride = &t
		case arg == "--no-approve" || arg == "-na":
			f := false
			r.ProjectTrustOverride = &f
		case arg == "--offline":
			r.Offline = true
		case strings.HasPrefix(arg, "@"):
			r.FileArgs = append(r.FileArgs, arg[1:])
		case strings.HasPrefix(arg, "--"):
			if eq := strings.Index(arg, "="); eq != -1 {
				r.setUnknown(arg[2:eq], arg[eq+1:])
			} else if hasNext(i) && !strings.HasPrefix(args[i+1], "-") && !strings.HasPrefix(args[i+1], "@") {
				r.setUnknown(arg[2:], args[i+1])
				i++
			} else {
				r.setUnknown(arg[2:], true)
			}
		case strings.HasPrefix(arg, "-"):
			r.diag("error", "Unknown option: "+arg)
		default:
			r.Messages = append(r.Messages, arg)
		}
	}
	return r
}

// HarnessArgvEnv names the file in which PiG writes the host's argv (after
// the binary) as a JSON string array. PiG sets it in every extension cell.
const HarnessArgvEnv = "PIG_HARNESS_ARGV_FILE"

// HarnessArgv reads pig's argv from PIG_HARNESS_ARGV_FILE. ok is false when
// the variable is unset or the file cannot be read.
func HarnessArgv() (argv []string, ok bool) {
	path := os.Getenv(HarnessArgvEnv)
	if path == "" {
		return nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &argv) != nil {
		return nil, false
	}
	return argv, true
}
