// Package prettytools is the Go port of pretty-tools/: the read, bash, ls,
// find, and grep tool overrides with their result formatting, the colored
// tool cards, the bash grep guard, and the @-mention autocomplete provider.
// FFF (@ff-labs/fff-node) is not ported: the tools take the path TypeScript
// takes when FFF does not load (rtk first, then the host's built-in tool).
// This package does not import the PiG SDK; the host calls (rtk runs, the
// built-in tools, highlighting, the terminal width) are injected.
package prettytools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ToolResultIndent is TOOL_RESULT_INDENT.
const ToolResultIndent = " "

// ANSI colors of config.ts.
const (
	RST       = "\x1b[0m"
	FgLnum    = "\x1b[38;2;100;100;100m"
	FgDim     = "\x1b[38;2;80;80;80m"
	FgRule    = "\x1b[38;2;50;50;50m"
	FgGreen   = "\x1b[38;2;100;180;120m"
	FgRed     = "\x1b[38;2;200;100;100m"
	FgYellow  = "\x1b[38;2;220;180;80m"
	FgBlue    = "\x1b[38;2;100;140;220m"
	FgMuted   = "\x1b[38;2;139;148;158m"
	bgDefault = "\x1b[49m"
)

// Theme is the ThemeLike the renderers use. sdk.UITheme implements it. A
// theme may also implement BgAnsiTheme; chrome.Optional's HasBg reports a
// theme without bg.
type Theme interface {
	Fg(role, text string) string
	Bold(text string) string
	Bg(role, text string) string
}

// BgAnsiTheme is a theme with getBgAnsi. An error is a throw.
type BgAnsiTheme interface {
	GetBgAnsi(role string) (string, error)
}

// hasBgFn reports whether the theme has bg (chrome.Optional).
func hasBgFn(t Theme) bool {
	if o, ok := t.(interface{ HasBg() bool }); ok {
		return o.HasBg()
	}
	return true
}

var ansiRgbRe = regexp.MustCompile(`\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m`)

func parseAnsiRgb(ansi string) bool { return ansiRgbRe.MatchString(ansi) }

// getThemeBgAnsi ports getThemeBgAnsi: getBgAnsi when it gives a 24-bit
// color, else the prefix bg puts before a marker. A throw is null.
func getThemeBgAnsi(t Theme, key string) (string, bool) {
	if b, ok := t.(BgAnsiTheme); ok {
		direct, err := b.GetBgAnsi(key)
		if err != nil {
			return "", false
		}
		if direct != "" && parseAnsiRgb(direct) {
			return direct, true
		}
	}
	if !hasBgFn(t) {
		return "", false
	}
	styled := t.Bg(key, "\x00")
	idx := strings.Index(styled, "\x00")
	if idx <= 0 {
		return "", false
	}
	ansi := styled[:idx]
	if !parseAnsiRgb(ansi) {
		return "", false
	}
	return ansi, true
}

var hexRe = regexp.MustCompile(`^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$`)

// hexToAnsiBg ports hexToAnsiBg.
func hexToAnsiBg(hex string) (string, bool) {
	m := hexRe.FindStringSubmatch(hex)
	if m == nil {
		return "", false
	}
	r, _ := strconv.ParseInt(m[1], 16, 0)
	g, _ := strconv.ParseInt(m[2], 16, 0)
	b, _ := strconv.ParseInt(m[3], 16, 0)
	return "\x1b[48;2;" + strconv.FormatInt(r, 10) + ";" + strconv.FormatInt(g, 10) + ";" + strconv.FormatInt(b, 10) + "m", true
}

// readPrettyConfig ports readPrettyConfig: the background colors of
// <dir>/aio-pretty.json, each empty when absent or not a hex color.
func readPrettyConfig(dir string) (tool, errorBg string) {
	if dir == "" {
		return "", ""
	}
	data, err := os.ReadFile(filepath.Join(dir, "aio-pretty.json"))
	if err != nil {
		return "", ""
	}
	var parsed struct {
		Background *struct {
			Tool  any `json:"tool"`
			Error any `json:"error"`
		} `json:"background"`
	}
	if json.Unmarshal(data, &parsed) != nil || parsed.Background == nil {
		return "", ""
	}
	for _, v := range []any{parsed.Background.Tool, parsed.Background.Error} {
		// hexToAnsiBg(value) throws for a truthy value that is not a string,
		// and the catch drops the whole config.
		if _, isString := v.(string); !isString && jsstr.Truthy(v) {
			return "", ""
		}
	}
	tool, _ = parsed.Background.Tool.(string)
	errorBg, _ = parsed.Background.Error.(string)
	if _, ok := hexToAnsiBg(tool); !ok {
		tool = ""
	}
	if _, ok := hexToAnsiBg(errorBg); !ok {
		errorBg = ""
	}
	return tool, errorBg
}

// Backgrounds holds BG_BASE and BG_ERROR, which resolveBaseBackground
// updates as module state.
type Backgrounds struct {
	mu    sync.Mutex
	base  string
	error string
}

// NewBackgrounds starts with the terminal default background.
func NewBackgrounds() *Backgrounds { return &Backgrounds{base: bgDefault, error: bgDefault} }

// Get returns BG_BASE and BG_ERROR.
func (b *Backgrounds) Get() (base, errorBg string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.base, b.error
}

// Resolve ports resolveBaseBackground: aio-pretty.json in configDir wins;
// otherwise the theme's tool backgrounds. A theme without getBgAnsi and bg
// leaves the colors as they are.
func (b *Backgrounds) Resolve(t Theme, configDir string) {
	tool, errorHex := readPrettyConfig(configDir)
	b.mu.Lock()
	defer b.mu.Unlock()
	if tool != "" {
		toolBg, _ := hexToAnsiBg(tool)
		b.base, b.error = toolBg, toolBg
		if errorHex != "" {
			b.error, _ = hexToAnsiBg(errorHex)
		}
		return
	}
	_, hasGet := t.(BgAnsiTheme)
	if !hasGet && !hasBgFn(t) {
		return
	}
	b.base = bgDefault
	for _, key := range []string{"toolSuccessBg", "toolBg", "background"} {
		if v, ok := getThemeBgAnsi(t, key); ok {
			b.base = v
			break
		}
	}
	b.error = b.base
	if v, ok := getThemeBgAnsi(t, "toolErrorBg"); ok {
		b.error = v
	}
}

// ---- icons and languages ----

const (
	nfDir     = FgBlue + "\ue5ff" + RST
	nfDefault = FgDim + "\uf15b" + RST
)

func icon(rgb, glyph string) string { return "\x1b[38;2;" + rgb + "m" + glyph + RST }

var extIcon = map[string]string{
	"ts": icon("49;120;198", "\ue628"), "tsx": icon("49;120;198", "\ue7ba"),
	"js": icon("241;224;90", "\ue74e"), "jsx": icon("97;218;251", "\ue7ba"),
	"mjs": icon("241;224;90", "\ue74e"), "cjs": icon("241;224;90", "\ue74e"),
	"py": icon("55;118;171", "\ue73c"), "rs": icon("222;165;132", "\ue7a8"),
	"go": icon("0;173;216", "\ue724"), "java": icon("204;62;68", "\ue738"),
	"swift": icon("255;172;77", "\ue755"), "rb": icon("204;52;45", "\ue739"),
	"kt": icon("126;103;200", "\ue634"), "c": icon("85;154;211", "\ue61e"),
	"cpp": icon("85;154;211", "\ue61d"), "cs": icon("104;33;122", "\ue648"),
	"html": icon("228;77;38", "\ue736"), "css": icon("66;165;245", "\ue749"),
	"scss": icon("207;100;154", "\ue749"), "vue": icon("65;184;131", "\ue6a0"),
	"svelte": icon("255;62;0", "\ue697"), "json": icon("241;224;90", "\ue60b"),
	"yaml": icon("160;116;196", "\ue6a8"), "yml": icon("160;116;196", "\ue6a8"),
	"toml": icon("160;116;196", "\ue6b2"), "xml": icon("228;77;38", "\ue619"),
	"md": icon("66;165;245", "\ue73e"), "mdx": icon("66;165;245", "\ue73e"),
	"sql": icon("218;218;218", "\ue706"), "sh": icon("137;180;130", "\ue795"),
	"bash": icon("137;180;130", "\ue795"), "zsh": icon("137;180;130", "\ue795"),
	"lua": icon("81;160;207", "\ue620"), "php": icon("137;147;186", "\ue73d"),
	"dart": icon("87;182;240", "\ue798"), "png": icon("160;116;196", "\uf1c5"),
	"jpg": icon("160;116;196", "\uf1c5"), "svg": icon("255;180;50", "\uf1c5"),
	"webp": icon("160;116;196", "\uf1c5"), "lock": icon("130;130;130", "\uf023"),
	"env": icon("241;224;90", "\ue615"), "graphql": icon("224;51;144", "\ue662"),
	"dockerfile": icon("56;152;236", "\ue7b0"),
}

var nameIcon = map[string]string{
	"package.json":      icon("137;180;130", "\ue71e"),
	"package-lock.json": icon("130;130;130", "\ue71e"),
	"tsconfig.json":     icon("49;120;198", "\ue628"),
	".gitignore":        icon("222;165;132", "\ue702"),
	".env":              icon("241;224;90", "\ue615"),
	"dockerfile":        icon("56;152;236", "\ue7b0"),
	"makefile":          icon("130;130;130", "\ue615"),
	"readme.md":         icon("66;165;245", "\ue73e"),
	"license":           icon("218;218;218", "\ue60a"),
}

// jsBasename is node:path basename for POSIX paths.
func jsBasename(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// jsExtname is node:path extname: "" for a leading-dot name without another dot.
func jsExtname(p string) string {
	base := jsBasename(p)
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}

// jsDirname is node:path dirname for POSIX paths.
func jsDirname(p string) string {
	if p == "" {
		return "."
	}
	trimmed := strings.TrimRight(p, "/")
	if trimmed == "" {
		return "/"
	}
	i := strings.LastIndex(trimmed, "/")
	if i < 0 {
		return "."
	}
	dir := strings.TrimRight(trimmed[:i], "/")
	if dir == "" {
		return "/"
	}
	return dir
}

// FileIcon ports fileIcon.
func (p *Pretty) FileIcon(fp string) string {
	if !p.UseIcons {
		return ""
	}
	base := strings.ToLower(jsBasename(fp))
	if i, ok := nameIcon[base]; ok {
		return i + " "
	}
	ext := strings.ToLower(strings.TrimPrefix(jsExtname(fp), "."))
	if i, ok := extIcon[ext]; ok {
		return i + " "
	}
	return nfDefault + " "
}

// DirIcon ports dirIcon.
func (p *Pretty) DirIcon() string {
	if !p.UseIcons {
		return ""
	}
	return nfDir + " "
}

var extLang = map[string]string{
	"ts": "typescript", "tsx": "tsx", "js": "javascript", "jsx": "jsx", "mjs": "javascript", "cjs": "javascript",
	"py": "python", "rb": "ruby", "rs": "rust", "go": "go", "java": "java", "c": "c", "cpp": "cpp", "h": "c",
	"hpp": "cpp", "cs": "csharp", "swift": "swift", "kt": "kotlin", "html": "html", "css": "css", "scss": "scss",
	"less": "css", "json": "json", "jsonc": "jsonc", "yaml": "yaml", "yml": "yaml", "toml": "toml", "md": "markdown",
	"mdx": "mdx", "sql": "sql", "sh": "bash", "bash": "bash", "zsh": "bash", "lua": "lua", "php": "php",
	"dart": "dart", "xml": "xml", "graphql": "graphql", "svelte": "svelte", "vue": "vue", "dockerfile": "dockerfile",
	"makefile": "make", "zig": "zig", "nim": "nim", "elixir": "elixir",
}

// DetectLang ports detectLang: the Shiki language of a path, or "".
func DetectLang(fp string) string {
	base := strings.ToLower(jsBasename(fp))
	if base == "dockerfile" {
		return "dockerfile"
	}
	if base == "makefile" || base == "gnumakefile" {
		return "make"
	}
	return extLang[strings.ToLower(strings.TrimPrefix(jsExtname(fp), "."))]
}

// EnvInt ports envInt: a positive integer from the env, else fallback.
func EnvInt(getenv func(string) string, name string, fallback int) int {
	v, ok := parseIntPrefix(getenv(name))
	if ok && v > 0 {
		return v
	}
	return fallback
}

// parseIntPrefix is Number.parseInt(s, 10) for finite results.
func parseIntPrefix(s string) (int, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	end := 0
	if end < len(s) && (s[end] == '-' || s[end] == '+') {
		end++
	}
	digits := end
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == digits {
		return 0, false
	}
	v, err := strconv.Atoi(s[:end])
	return v, err == nil
}

// BashGrepGuardEnabled ports bashGrepGuardEnabled.
func BashGrepGuardEnabled(getenv func(string) string) bool {
	switch strings.ToLower(getenv("PRETTY_BASH_GREP_GUARD")) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// Pretty holds the settings config.ts reads at load and the injected host
// parts.
type Pretty struct {
	UseIcons        bool
	MaxHLChars      int
	MaxPreviewLines int
	// Highlight is codeToANSI: ANSI-colored code for a Shiki language.
	Highlight func(code, language string) (string, error)
	// TermWidth is termWidth().
	TermWidth func() int
	// ConfigDir is PRETTY_CONFIG_DIR ?? the agent directory, read per render.
	ConfigDir func() string
	BG        *Backgrounds
}

// NewPretty reads PRETTY_ICONS and the PRETTY_* limits as config.ts does
// at load.
func NewPretty(getenv func(string) string) *Pretty {
	icons := strings.ToLower(getenv("PRETTY_ICONS"))
	if icons == "" {
		icons = "nerd"
	}
	return &Pretty{
		UseIcons:        icons != "none" && icons != "off",
		MaxHLChars:      EnvInt(getenv, "PRETTY_MAX_HL_CHARS", 80_000),
		MaxPreviewLines: EnvInt(getenv, "PRETTY_MAX_PREVIEW_LINES", 80),
		TermWidth:       func() int { return 200 },
		ConfigDir:       func() string { return "" },
		BG:              NewBackgrounds(),
	}
}

// resolve is resolveBaseBackground(theme).
func (p *Pretty) resolve(t Theme) { p.BG.Resolve(t, p.ConfigDir()) }
