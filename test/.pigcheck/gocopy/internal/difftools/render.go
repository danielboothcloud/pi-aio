package difftools

// Diff rendering: port of review/hunk-preview.ts (the split and unified
// renderers the tool cards use) and the palette state of hunk-preview.ts
// and index.ts. Both TypeScript modules keep their palette in module
// globals; paletteState is one such module copy.

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsdiff"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Theme is the theme surface the renderers use: chrome's fg/bold/bg plus
// Pi's getFgAnsi/getBgAnsi (sdk.UITheme implements it).
type Theme interface {
	chrome.Theme
	GetFgAnsi(token string) (string, error)
	GetBgAnsi(token string) (string, error)
}

// Highlighter is codeToANSI: ANSI-colored code for a language.
type Highlighter func(code, language string) (string, error)

// DiffColors is hunk-preview.ts DiffColors.
type DiffColors struct{ FgAdd, FgDel, FgCtx string }

// Renderer limits (hunk-preview.ts and index.ts).
const (
	maxHLChars       = 80000
	hlCacheLimit     = 192
	wordDiffMinSim   = 0.15
	defaultRenderW   = 120
	minRenderWidth   = 40
	splitMaxWrapRat  = 0.35
	splitMaxWrapRows = 10
	// MaxPreviewRenderLines is index.ts MAX_PREVIEW_LINES (edit previews).
	MaxPreviewRenderLines = 60
	// MaxRenderLines is index.ts MAX_RENDER_LINES (write previews).
	MaxRenderLines = 150
)

const (
	dim       = "\x1b[2m"
	bgDefault = "\x1b[49m"
)

// DiffPreset is a named color preset.
type DiffPreset struct {
	ShikiTheme                                                                      string
	BgAdd, BgDel, BgAddHighlight, BgDelHighlight, BgGutterAdd, BgGutterDel, BgEmpty string
	FgAdd, FgDel, FgDim, FgLnum, FgRule, FgStripe, FgSafeMuted                      string
}

// DiffPresets is DIFF_PRESETS.
var DiffPresets = map[string]DiffPreset{
	"default":  {BgAdd: "#1a3324", BgDel: "#3d2020", BgAddHighlight: "#2d5c3a", BgDelHighlight: "#5c2d2d", BgGutterAdd: "#16281e", BgGutterDel: "#301c1c", BgEmpty: "#121212", FgDim: "#505050", FgLnum: "#646464", FgRule: "#323232", FgStripe: "#282828", FgSafeMuted: "#8b949e"},
	"midnight": {BgAdd: "#101e15", BgDel: "#1e1010", BgAddHighlight: "#1a3825", BgDelHighlight: "#381a1a", BgGutterAdd: "#0c180c", BgGutterDel: "#180c0c", BgEmpty: "#080808", FgDim: "#404040", FgLnum: "#505050", FgRule: "#282828", FgStripe: "#1e1e1e", FgSafeMuted: "#8b949e"},
	"subtle":   {BgAdd: "#0c160c", BgDel: "#160c0c", BgAddHighlight: "#122818", BgDelHighlight: "#281212", BgGutterAdd: "#080e08", BgGutterDel: "#0e0808", BgEmpty: "#060606", FgDim: "#383838", FgLnum: "#484848", FgRule: "#242424", FgStripe: "#181818", FgSafeMuted: "#8b949e"},
	"neon":     {BgAdd: "#1e3a28", BgDel: "#3a1c18", BgAddHighlight: "#2d5c3a", BgDelHighlight: "#5c2d2d", BgGutterAdd: "#182c1c", BgGutterDel: "#2c1410", BgEmpty: "#141414", FgDim: "#606060", FgLnum: "#787878", FgRule: "#404040", FgStripe: "#303030", FgSafeMuted: "#9da5ae"},
}

var hexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func hexAnsi(hex string, layer int) string {
	if !hexRe.MatchString(hex) {
		return ""
	}
	r, _ := strconv.ParseInt(hex[1:3], 16, 0)
	g, _ := strconv.ParseInt(hex[3:5], 16, 0)
	b, _ := strconv.ParseInt(hex[5:7], 16, 0)
	return "\x1b[" + strconv.Itoa(layer) + ";2;" + strconv.FormatInt(r, 10) + ";" + strconv.FormatInt(g, 10) + ";" + strconv.FormatInt(b, 10) + "m"
}

func envColor(env func(string) string, name, fallback string, layer int) string {
	if v := hexAnsi(env(name), layer); v != "" {
		return v
	}
	return fallback
}

type rgb struct{ r, g, b int }

var ansiRgbRe = regexp.MustCompile(`\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m`)

func parseAnsiRgb(ansi string) (rgb, bool) {
	m := ansiRgbRe.FindStringSubmatch(ansi)
	if m == nil {
		return rgb{}, false
	}
	r, _ := strconv.Atoi(m[1])
	g, _ := strconv.Atoi(m[2])
	b, _ := strconv.Atoi(m[3])
	return rgb{r, g, b}, true
}

func jsRound(x float64) int { return int(math.Floor(x + 0.5)) }

func mixBg(base, accent rgb, k float64) string {
	mix := func(b, a int) string { return strconv.Itoa(jsRound(float64(b) + float64(a-b)*k)) }
	return "\x1b[48;2;" + mix(base.r, accent.r) + ";" + mix(base.g, accent.g) + ";" + mix(base.b, accent.b) + "m"
}

// paletteState is one TypeScript module's palette globals.
type paletteState struct {
	rst, bgBase                                                     string
	bgAdd, bgDel, bgAddW, bgDelW, bgGutterAdd, bgGutterDel, bgEmpty string
	fgAdd, fgDel, fgDim, fgLnum, fgRule, fgSafeMuted, fgStripe      string
	defaultColors                                                   DiffColors
	lastThemeKey                                                    string
	autoDerivePending, hasExplicitBg                                bool
	shikiTheme                                                      string
}

func newPaletteState(env func(string) string) *paletteState {
	s := &paletteState{
		rst:               "\x1b[0m",
		bgBase:            bgDefault,
		bgAdd:             envColor(env, "DIFF_BG_ADD", "\x1b[48;2;30;52;40m", 48),
		bgDel:             envColor(env, "DIFF_BG_DEL", "\x1b[48;2;60;30;30m", 48),
		bgAddW:            envColor(env, "DIFF_BG_ADD_HL", "\x1b[48;2;45;90;60m", 48),
		bgDelW:            envColor(env, "DIFF_BG_DEL_HL", "\x1b[48;2;100;45;45m", 48),
		bgGutterAdd:       envColor(env, "DIFF_BG_GUTTER_ADD", "\x1b[48;2;24;42;32m", 48),
		bgGutterDel:       envColor(env, "DIFF_BG_GUTTER_DEL", "\x1b[48;2;48;28;28m", 48),
		bgEmpty:           "\x1b[48;2;18;18;18m",
		fgAdd:             envColor(env, "DIFF_FG_ADD", "\x1b[38;2;100;180;120m", 38),
		fgDel:             envColor(env, "DIFF_FG_DEL", "\x1b[38;2;200;100;100m", 38),
		fgDim:             "\x1b[38;2;80;80;80m",
		fgLnum:            "\x1b[38;2;100;100;100m",
		fgRule:            "\x1b[38;2;50;50;50m",
		fgSafeMuted:       "\x1b[38;2;139;148;158m",
		fgStripe:          "\x1b[38;2;40;40;40m",
		autoDerivePending: true,
		shikiTheme:        "github-dark",
	}
	if t := env("DIFF_THEME"); t != "" {
		s.shikiTheme = t
	}
	s.defaultColors = DiffColors{s.fgAdd, s.fgDel, s.fgDim}
	return s
}

// DiffUserConfig is the diffTheme/diffColors pair from Pi settings.
type DiffUserConfig struct {
	DiffTheme  string
	DiffColors map[string]string
}

// applyDiffPalette ports hunk-preview.ts applyDiffPalette.
func (s *paletteState) applyDiffPalette(cfg DiffUserConfig, env func(string) string) {
	preset, hasPreset := DiffPresets[cfg.DiffTheme]
	if cfg.DiffTheme != "" && hasPreset {
		s.hasExplicitBg = true
	}
	ov := cfg.DiffColors
	if len(ov) > 0 {
		s.hasExplicitBg = true
	}
	apply := func(envName, key, presetValue string, layer int, set *string) {
		if envName != "" && env(envName) != "" {
			return
		}
		hex, ok := ov[key]
		if !ok {
			hex = presetValue
		}
		if hex != "" {
			if a := hexAnsi(hex, layer); a != "" {
				*set = a
			}
		}
	}
	apply("DIFF_BG_ADD", "bgAdd", preset.BgAdd, 48, &s.bgAdd)
	apply("DIFF_BG_DEL", "bgDel", preset.BgDel, 48, &s.bgDel)
	apply("DIFF_BG_ADD_HL", "bgAddHighlight", preset.BgAddHighlight, 48, &s.bgAddW)
	apply("DIFF_BG_DEL_HL", "bgDelHighlight", preset.BgDelHighlight, 48, &s.bgDelW)
	apply("DIFF_BG_GUTTER_ADD", "bgGutterAdd", preset.BgGutterAdd, 48, &s.bgGutterAdd)
	apply("DIFF_BG_GUTTER_DEL", "bgGutterDel", preset.BgGutterDel, 48, &s.bgGutterDel)
	apply("", "bgEmpty", preset.BgEmpty, 48, &s.bgEmpty)
	apply("DIFF_FG_ADD", "fgAdd", preset.FgAdd, 38, &s.fgAdd)
	apply("DIFF_FG_DEL", "fgDel", preset.FgDel, 38, &s.fgDel)
	apply("", "fgDim", preset.FgDim, 38, &s.fgDim)
	apply("", "fgLnum", preset.FgLnum, 38, &s.fgLnum)
	apply("", "fgRule", preset.FgRule, 38, &s.fgRule)
	apply("", "fgStripe", preset.FgStripe, 38, &s.fgStripe)
	apply("", "fgSafeMuted", preset.FgSafeMuted, 38, &s.fgSafeMuted)
	if shiki, ok := ov["shikiTheme"]; ok && shiki != "" {
		s.shikiTheme = shiki
	} else if preset.ShikiTheme != "" {
		s.shikiTheme = preset.ShikiTheme
	}
	s.defaultColors = DiffColors{s.fgAdd, s.fgDel, s.fgDim}
	s.autoDerivePending = !s.hasExplicitBg
}

// ThemeCacheKey ports themeCacheKey.
func ThemeCacheKey(t Theme) string {
	if t == nil {
		return "no-theme"
	}
	var parts []string
	for _, key := range []string{"toolTitle", "accent", "muted", "success", "error", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext"} {
		parts = append(parts, t.Fg(key, key))
	}
	for _, key := range []string{"toolSuccessBg", "toolErrorBg"} {
		parts = append(parts, t.Bg(key, key))
	}
	return strings.Join(parts, "|")
}

// autoDerive ports autoDeriveBgFromTheme.
func (s *paletteState) autoDerive(t Theme) {
	fgAdd, err1 := t.GetFgAnsi("toolDiffAdded")
	fgDel, err2 := t.GetFgAnsi("toolDiffRemoved")
	if err1 != nil || err2 != nil {
		return
	}
	addRgb, ok1 := parseAnsiRgb(fgAdd)
	delRgb, ok2 := parseAnsiRgb(fgDel)
	if !ok1 || !ok2 {
		return
	}
	addBase := rgb{}
	delBase := addBase
	if success, err := t.GetBgAnsi("toolSuccessBg"); err == nil {
		if parsed, ok := parseAnsiRgb(success); ok {
			addBase, delBase = parsed, parsed
			s.bgBase = success
		}
	}
	if errBg, err := t.GetBgAnsi("toolErrorBg"); err == nil {
		if parsed, ok := parseAnsiRgb(errBg); ok {
			delBase = parsed
		}
	}
	s.bgAdd = mixBg(addBase, addRgb, 0.15)
	s.bgDel = mixBg(delBase, delRgb, 0.18)
	s.bgAddW = mixBg(addBase, addRgb, 0.3)
	s.bgDelW = mixBg(delBase, delRgb, 0.35)
	s.bgGutterAdd = mixBg(addBase, addRgb, 0.1)
	s.bgGutterDel = mixBg(delBase, delRgb, 0.12)
	s.bgEmpty = s.bgBase
	s.rst = "\x1b[0m" + s.bgBase
}

// resolve ports resolveDiffColors.
func (s *paletteState) resolve(t Theme) DiffColors {
	key := ThemeCacheKey(t)
	if !s.hasExplicitBg && s.lastThemeKey != "" && s.lastThemeKey != key {
		s.bgBase = bgDefault
		s.rst = "\x1b[0m"
		s.autoDerivePending = true
	}
	s.lastThemeKey = key
	if t != nil && s.bgBase == bgDefault {
		if bg, err := t.GetBgAnsi("toolSuccessBg"); err == nil {
			if _, ok := parseAnsiRgb(bg); ok {
				s.bgBase = bg
				s.rst = "\x1b[0m" + bg
			}
		}
	}
	if s.autoDerivePending && t != nil {
		s.autoDerive(t)
		s.autoDerivePending = false
	}
	if t == nil {
		return s.defaultColors
	}
	add, err1 := t.GetFgAnsi("toolDiffAdded")
	del, err2 := t.GetFgAnsi("toolDiffRemoved")
	ctx, err3 := t.GetFgAnsi("toolDiffContext")
	if err1 != nil || err2 != nil || err3 != nil {
		return s.defaultColors
	}
	or := func(v, fallback string) string {
		if v == "" {
			return fallback
		}
		return v
	}
	return DiffColors{or(add, s.fgAdd), or(del, s.fgDel), or(ctx, s.fgDim)}
}

// ExtLang is hunk-preview.ts EXT_LANG (Shiki language names).
var ExtLang = map[string]string{
	"ts": "typescript", "tsx": "tsx", "js": "javascript", "jsx": "jsx", "mjs": "javascript", "cjs": "javascript",
	"py": "python", "rb": "ruby", "rs": "rust", "go": "go", "java": "java", "c": "c", "cpp": "cpp", "h": "c",
	"hpp": "cpp", "cs": "csharp", "swift": "swift", "kt": "kotlin", "html": "html", "css": "css", "scss": "scss",
	"json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml", "md": "markdown", "sql": "sql", "sh": "bash",
	"bash": "bash", "zsh": "bash", "lua": "lua", "php": "php", "dart": "dart", "xml": "xml", "graphql": "graphql",
	"svelte": "svelte", "vue": "vue",
}

// Lang ports lang: the Shiki language of a path, or "".
func Lang(filePath string) string {
	return ExtLang[strings.ToLower(strings.TrimPrefix(jsExtname(filePath), "."))]
}

// jsExtname is Node's path.extname.
func jsExtname(p string) string {
	base := p
	if i := strings.LastIndex(p, "/"); i >= 0 {
		base = p[i+1:]
	}
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}

// Palette holds both module palettes, the render options, and the
// highlight cache. Its methods are safe for concurrent use.
type Palette struct {
	mu sync.Mutex
	hp *paletteState // review/hunk-preview.ts
	ix *paletteState // index.ts
	// IndicatorStyle is pi-diff.json indicatorStyle.
	IndicatorStyle string
	// SepStyle is resolveSepStyle's value.
	SepStyle string
	// Highlight is codeToANSI; nil leaves code plain.
	Highlight      Highlighter
	cache          map[string][]string
	order          []string
	env            func(string) string
	cfg            DiffUserConfig
	paletteApplied bool
	// splitMin and splitMinCode are DIFF_SPLIT_MIN_WIDTH and DIFF_SPLIT_MIN_CODE_WIDTH.
	splitMin, splitMinCode int
}

// NewPalette builds the palettes as the TypeScript modules load, then
// applies the settings' diffTheme/diffColors (applySharedDiffPalette).
func NewPalette(env func(string) string, cfg DiffUserConfig, indicatorStyle string, highlight Highlighter) *Palette {
	p := &Palette{hp: newPaletteState(env), ix: newPaletteState(env), IndicatorStyle: indicatorStyle, SepStyle: ResolveSepStyle(env("PI_DIFF_SEP_STYLE")), Highlight: highlight, cache: map[string][]string{},
		splitMin: envInt(env, "DIFF_SPLIT_MIN_WIDTH", 80), splitMinCode: envInt(env, "DIFF_SPLIT_MIN_CODE_WIDTH", 24)}
	p.env, p.cfg = env, cfg
	p.hp.applyDiffPalette(cfg, env)
	return p
}

// ResolveColors is resolvePreviewDiffColors: both modules resolve the theme.
func (p *Palette) ResolveColors(t Theme) DiffColors {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.resolveLocked(t)
}

func (p *Palette) resolveLocked(t Theme) DiffColors {
	p.ix.resolve(t)
	return p.hp.resolve(t)
}

func (p *Palette) borderBar() string {
	if p.IndicatorStyle == "none" {
		return " "
	}
	return "▌"
}

// ---- JavaScript string-walk helpers over UTF-16 units ----

func units(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

var (
	ansiRe        = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	ansiCaptureRe = regexp.MustCompile(`\x1b\[([^m]*)m`)
)

func stripAnsi(s string) string { return ansiRe.ReplaceAllString(s, "") }

func tabs(s string) string { return strings.ReplaceAll(s, "\t", "  ") }

func adaptiveWrapRows(width int) int {
	switch {
	case width >= 180:
		return 3
	case width >= 120:
		return 2
	}
	return 1
}

// skipEscape returns the index after an escape that starts at i (up to the
// next "m", as indexOf("m", i) finds it), or -1.
func skipEscape(s string, i int) int {
	if s[i] != 0x1b {
		return -1
	}
	if e := strings.IndexByte(s[i:], 'm'); e >= 0 {
		return i + e + 1
	}
	return -1
}

// fit ports hunk-preview.ts fit.
func (s *paletteState) fit(content string, width int) string {
	if width <= 0 {
		return ""
	}
	plain := jsstr.Len16(stripAnsi(content))
	if plain <= width {
		return content + strings.Repeat(" ", width-plain)
	}
	show := width
	if width > 2 {
		show = width - 1
	}
	vis, i := 0, 0
	for i < len(content) && vis < show {
		if j := skipEscape(content, i); j >= 0 {
			i = j
			continue
		}
		r, size := decodeRune(content[i:])
		vis += units(r)
		i += size
	}
	if width > 2 {
		return content[:i] + s.rst + s.fgDim + "›" + s.rst
	}
	return content[:i] + s.rst
}

func decodeRune(s string) (rune, int) { return utf8.DecodeRuneInString(s) }

// ansiState ports ansiState: the last active fg and bg codes.
func ansiState(s string) string {
	fg, bg := "", ""
	for _, m := range ansiCaptureRe.FindAllStringSubmatch(s, -1) {
		switch p := m[1]; {
		case p == "0":
			fg, bg = "", ""
		case p == "39":
			fg = ""
		case strings.HasPrefix(p, "38;"):
			fg = m[0]
		case strings.HasPrefix(p, "48;"):
			bg = m[0]
		}
	}
	return bg + fg
}

var ansiParamRe = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

func isLowContrastFg(params string) bool {
	switch params {
	case "30", "90", "38;5;0", "38;5;8":
		return true
	}
	if !strings.HasPrefix(params, "38;2;") {
		return false
	}
	parts := strings.Split(params, ";")
	if len(parts) != 5 {
		return false
	}
	var v [5]float64
	for i, part := range parts {
		n, err := strconv.ParseFloat(part, 64)
		if part == "" {
			n, err = 0, nil
		}
		if err != nil {
			return false
		}
		v[i] = n
	}
	return 0.2126*v[2]+0.7152*v[3]+0.0722*v[4] < 72
}

func (s *paletteState) normalizeContrast(ansi string) string {
	return ansiParamRe.ReplaceAllStringFunc(ansi, func(seq string) string {
		if isLowContrastFg(seq[2 : len(seq)-1]) {
			return s.fgSafeMuted
		}
		return seq
	})
}

// wrapAnsi ports wrapAnsi.
func (s *paletteState) wrapAnsi(content string, width, maxRows int, fillBg string) []string {
	if width <= 0 {
		return []string{""}
	}
	plain := jsstr.Len16(stripAnsi(content))
	if plain <= width {
		pad := width - plain
		if pad > 0 {
			tail := ""
			if fillBg != "" {
				tail = s.rst
			}
			return []string{content + fillBg + strings.Repeat(" ", pad) + tail}
		}
		return []string{content}
	}
	var rows []string
	var row strings.Builder
	vis, i := 0, 0
	onLast := false
	eff := width
	lastWidth := func() int {
		if width > 2 {
			return width - 1
		}
		return width
	}
	for i < len(content) {
		if !onLast && len(rows) >= maxRows-1 {
			onLast, eff = true, lastWidth()
		}
		if j := skipEscape(content, i); j >= 0 {
			row.WriteString(content[i:j])
			i = j
			continue
		}
		if vis >= eff {
			if onLast {
				hasMore := false
				for k := i; k < len(content); {
					if j := skipEscape(content, k); j >= 0 {
						k = j
						continue
					}
					hasMore = true
					break
				}
				if hasMore && width > 2 {
					row.WriteString(s.rst + s.fgDim + "›" + s.rst)
				} else {
					row.WriteString(fillBg + strings.Repeat(" ", max(0, width-vis)) + s.rst)
				}
				return append(rows, row.String())
			}
			state := ansiState(row.String())
			rows = append(rows, row.String()+s.rst)
			row.Reset()
			row.WriteString(state + fillBg)
			vis = 0
			if len(rows) >= maxRows-1 {
				onLast, eff = true, lastWidth()
			}
		}
		r, size := decodeRune(content[i:])
		row.WriteString(content[i : i+size])
		vis += units(r)
		i += size
	}
	if row.Len() > 0 || len(rows) == 0 {
		rows = append(rows, row.String()+fillBg+strings.Repeat(" ", max(0, width-vis))+s.rst)
	}
	return rows
}

func (s *paletteState) lnum(n *int, width int, fg string) string {
	if n == nil {
		return strings.Repeat(" ", width)
	}
	v := strconv.Itoa(*n)
	return fg + strings.Repeat(" ", max(0, width-len(v))) + v + s.rst
}

// injectBg ports injectBg: baseBg on unchanged spans, hlBg on the ranges.
func (s *paletteState) injectBg(line string, ranges [][2]int, baseBg, hlBg string) string {
	var out strings.Builder
	out.WriteString(baseBg)
	vis, ri, inHL := 0, 0, false
	for i := 0; i < len(line); {
		if j := skipEscape(line, i); j >= 0 {
			seq := line[i:j]
			out.WriteString(seq)
			if seq == "\x1b[0m" || seq == "\x1b[39m" || seq == "\x1b[49m" {
				if inHL {
					out.WriteString(hlBg)
				} else {
					out.WriteString(baseBg)
				}
			}
			i = j
			continue
		}
		for ri < len(ranges) && vis >= ranges[ri][1] {
			ri++
		}
		want := ri < len(ranges) && vis >= ranges[ri][0] && vis < ranges[ri][1]
		if want != inHL {
			inHL = want
			if inHL {
				out.WriteString(hlBg)
			} else {
				out.WriteString(baseBg)
			}
		}
		r, size := decodeRune(line[i:])
		out.WriteString(line[i : i+size])
		vis += units(r)
		i += size
	}
	out.WriteString(s.rst)
	return out.String()
}

type wordDiffResult struct {
	similarity         float64
	oldRanges, newRang [][2]int
}

// wordDiffAnalysis ports wordDiffAnalysis.
func wordDiffAnalysis(a, b string) wordDiffResult {
	if a == "" && b == "" {
		return wordDiffResult{similarity: 1}
	}
	var r wordDiffResult
	oPos, nPos, same := 0, 0, 0
	for _, p := range jsdiff.DiffWords(a, b) {
		n := jsstr.Len16(p.Value)
		switch {
		case p.Removed:
			r.oldRanges = append(r.oldRanges, [2]int{oPos, oPos + n})
			oPos += n
		case p.Added:
			r.newRang = append(r.newRang, [2]int{nPos, nPos + n})
			nPos += n
		default:
			same += n
			oPos += n
			nPos += n
		}
	}
	maxLen := max(jsstr.Len16(a), jsstr.Len16(b))
	r.similarity = 1
	if maxLen > 0 {
		r.similarity = float64(same) / float64(maxLen)
	}
	return r
}

// plainWordDiff ports plainWordDiff.
func (s *paletteState) plainWordDiff(oldText, newText string) (string, string) {
	var o, n strings.Builder
	for _, p := range jsdiff.DiffWords(oldText, newText) {
		switch {
		case p.Removed:
			o.WriteString(s.bgDelW + p.Value + s.rst + s.bgDel)
		case p.Added:
			n.WriteString(s.bgAddW + p.Value + s.rst + s.bgAdd)
		default:
			o.WriteString(p.Value)
			n.WriteString(p.Value)
		}
	}
	return o.String(), n.String()
}

// hlBlock ports hunk-preview.ts hlBlock (with its LRU cache).
func (p *Palette) hlBlock(code, language string) []string { return p.hlBlockWith(p.hp, code, language) }

// hlBlockWith is hlBlock of one module: index.ts has its own copy, with its
// own Shiki theme and contrast color.
func (p *Palette) hlBlockWith(s *paletteState, code, language string) []string {
	if code == "" {
		return []string{""}
	}
	if language == "" || jsstr.Len16(code) > maxHLChars || p.Highlight == nil {
		return strings.Split(code, "\n")
	}
	key := s.shikiTheme + "\x00" + language + "\x00" + code + "\x00" + s.fgSafeMuted
	if hit, ok := p.cache[key]; ok {
		return hit
	}
	ansi, err := p.Highlight(code, language)
	if err != nil {
		return strings.Split(code, "\n")
	}
	ansi = strings.TrimSuffix(s.normalizeContrast(ansi), "\n")
	out := strings.Split(ansi, "\n")
	p.cache[key] = out
	p.order = append(p.order, key)
	for len(p.order) > hlCacheLimit {
		delete(p.cache, p.order[0])
		p.order = p.order[1:]
	}
	return out
}

func lineNum(l DiffLine) int {
	if l.OldNum != nil {
		return *l.OldNum
	}
	if l.NewNum != nil {
		return *l.NewNum
	}
	return 0
}

func numberWidth(lines []DiffLine) int {
	m := 0
	for _, l := range lines {
		m = max(m, lineNum(l))
	}
	return max(2, len(strconv.Itoa(m)))
}

// RenderOptions is DiffRenderOptions.
type RenderOptions struct{ CompactGutter bool }

// envInt ports envInt (Number.parseInt with a positive check).
func envInt(env func(string) string, name string, fallback int) int {
	raw := strings.TrimLeft(env(name), " \t\n\r")
	end := 0
	for end < len(raw) && (raw[end] >= '0' && raw[end] <= '9' || (end == 0 && (raw[end] == '-' || raw[end] == '+'))) {
		end++
	}
	if v, err := strconv.Atoi(raw[:end]); err == nil && v > 0 {
		return v
	}
	return fallback
}

// shouldUseSplit ports shouldUseSplit.
func (p *Palette) shouldUseSplit(diff ParsedDiff, width, maxRows int, o RenderOptions) bool {
	if len(diff.Lines) == 0 || width < p.splitMin {
		return false
	}
	half := width / 2
	gutter := numberWidth(diff.Lines) + 4
	if o.CompactGutter {
		gutter--
	}
	codeWidth := max(12, half-gutter)
	if codeWidth < p.splitMinCode {
		return false
	}
	vis := diff.Lines[:min(maxRows, len(diff.Lines))]
	adds, dels := 0, 0
	for _, l := range vis {
		switch l.Type {
		case "add":
			adds++
		case "del":
			dels++
		}
	}
	if adds == 0 || dels == 0 || max(adds, dels) > min(adds, dels)*2 {
		return false
	}
	content, wraps := 0, 0
	for _, l := range vis {
		if l.Type == "sep" {
			continue
		}
		content++
		if jsstr.Len16(tabs(l.Content)) > codeWidth {
			wraps++
		}
	}
	if content == 0 {
		return true
	}
	if wraps >= splitMaxWrapRows || float64(wraps)/float64(content) >= splitMaxWrapRat {
		return false
	}
	return true
}
