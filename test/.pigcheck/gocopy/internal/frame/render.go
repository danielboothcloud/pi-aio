package frame

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Style is FrameStyle.
type Style struct {
	ShowSessionName    bool              `json:"showSessionName"`
	ShowTimer          bool              `json:"showTimer"`
	ShowCost           bool              `json:"showCost"`
	ShowGit            bool              `json:"showGit"`
	PathDisplay        string            `json:"pathDisplay"`
	ContextThresholds  ContextThresholds `json:"contextThresholds"`
	ViewportIndicators bool              `json:"viewportIndicators"`
	ContextGauge       bool              `json:"contextGauge"`
	ASCII              bool              `json:"ascii"`
}

// DefaultStyle is DEFAULT_FRAME_STYLE.
var DefaultStyle = Style{
	ShowSessionName:    true,
	ShowTimer:          true,
	ShowCost:           true,
	ShowGit:            true,
	PathDisplay:        "compact",
	ContextThresholds:  ContextThresholds{Warning: 50, Error: 75},
	ViewportIndicators: true,
}

// Pill is a contributed icon + label + theme role (mode, style, recipe, btw).
type Pill struct {
	Icon  string `json:"icon"`
	Label string `json:"label"`
	Role  string `json:"role"`
}

// Tinted is a pre-joined text with a theme role (quota, codexQuota).
type Tinted struct {
	Text string `json:"text"`
	Role string `json:"role"`
}

// Metadata is FrameMetadata. Pointer fields are optional.
type Metadata struct {
	Cwd             string   `json:"cwd"`
	ProjectRoot     string   `json:"projectRoot,omitempty"`
	Branch          string   `json:"branch,omitempty"`
	Dirty           bool     `json:"dirty,omitempty"`
	Ahead           int      `json:"ahead,omitempty"`
	Behind          int      `json:"behind,omitempty"`
	CostLabel       string   `json:"costLabel,omitempty"`
	ModelLabel      string   `json:"modelLabel,omitempty"`
	ThinkingLevel   string   `json:"thinkingLevel,omitempty"`
	ContextPercent  *float64 `json:"contextPercent,omitempty"`
	SessionName     string   `json:"sessionName,omitempty"`
	AgentDurationMs *float64 `json:"agentDurationMs,omitempty"`
	AgentActive     bool     `json:"agentActive,omitempty"`
	Mode            *Pill    `json:"mode,omitempty"`
	Style           *Pill    `json:"style,omitempty"`
	Recipe          *Pill    `json:"recipe,omitempty"`
	Btw             *Pill    `json:"btw,omitempty"`
	Quota           *Tinted  `json:"quota,omitempty"`
	CodexQuota      *Tinted  `json:"codexQuota,omitempty"`
}

// Contribution is the Partial<FrameMetadata> a feature contributes.
type Contribution struct {
	Mode   *Pill   `json:"mode,omitempty"`
	Style  *Pill   `json:"style,omitempty"`
	Recipe *Pill   `json:"recipe,omitempty"`
	Btw    *Pill   `json:"btw,omitempty"`
	Quota  *Tinted `json:"quota,omitempty"`
}

// Apply is `{...metadata, ...contribution}`: set fields override.
func (m Metadata) Apply(c Contribution) Metadata {
	if c.Mode != nil {
		m.Mode = c.Mode
	}
	if c.Style != nil {
		m.Style = c.Style
	}
	if c.Recipe != nil {
		m.Recipe = c.Recipe
	}
	if c.Btw != nil {
		m.Btw = c.Btw
	}
	if c.Quota != nil {
		m.Quota = c.Quota
	}
	return m
}

var thinkingRoles = map[string]string{
	"minimal": "thinkingMinimal",
	"low":     "thinkingLow",
	"medium":  "thinkingMedium",
	"high":    "thinkingHigh",
	"xhigh":   "thinkingXhigh",
	"max":     "thinkingMax",
}

const (
	colorBorder          = "borderMuted"
	colorModel           = "syntaxKeyword"
	colorThinking        = "warning"
	colorGitBranch       = "bold syntaxKeyword"
	colorGitStatus       = "bold red"
	colorCost            = "bold green"
	colorSessionDuration = "yellow"
	colorContextNormal   = "success"
	colorContextWarning  = "bold yellow"
	colorContextError    = "bold red"
	colorCwd             = "bold cyan"
)

func truncate(text string, width int, ellipsis string) string {
	return tuiwidth.TruncateToWidth(text, width, ellipsis, false)
}

func clampLines(lines []string, width int) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = truncate(line, max(0, width), "")
	}
	return out
}

func joinStyled(parts []string, separator string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, separator)
}

// borderTheme renders every role through the frame's border renderer.
type borderTheme struct{ render func(string) string }

func (b borderTheme) Fg(_, text string) string { return b.render(text) }
func (b borderTheme) Bold(text string) string  { return text }
func (b borderTheme) Bg(_, text string) string { return text }
func (b borderTheme) HasBold() bool            { return false }
func (b borderTheme) HasBg() bool              { return false }

// RenderFramedPanelRows is renderFramedPanelRows: a `├───┤` divider, then
// `│ row │` lines.
func RenderFramedPanelRows(width int, lines []string, renderBorder func(string) string) []string {
	if width <= 4 || len(lines) == 0 {
		return clampLines(lines, width)
	}
	theme := borderTheme{renderBorder}
	out := []string{chrome.FrameRule(theme, width, "divider", "")}
	for _, line := range lines {
		out = append(out, chrome.FrameRow(theme, line, width))
	}
	return out
}

func pill(theme Theme, p *Pill) string {
	return SafeThemeFg(theme, p.Role, p.Icon+" "+p.Label)
}

func renderTopLeft(inputText string, m Metadata, theme Theme, style Style) string {
	muted := func(text string) string { return SafeThemeFg(theme, "muted", text) }
	var parts []string
	if mode := BashModeLabel(inputText); mode != "" {
		if mode == "no-context" {
			parts = append(parts, muted("!! hidden"))
		} else {
			parts = append(parts, SafeThemeFg(theme, "bashMode", "! bash"))
		}
	}
	for _, p := range []*Pill{m.Mode, m.Style, m.Recipe} {
		if p != nil {
			parts = append(parts, pill(theme, p))
		}
	}
	effort := strings.TrimSpace(m.ThinkingLevel)
	effortKey := strings.ToLower(effort)
	if effort != "" && effortKey != "off" {
		role, ok := thinkingRoles[effortKey]
		if !ok {
			role = colorThinking
		}
		parts = append(parts, SafeThemeFg(theme, role, effort))
	}
	if m.ContextPercent != nil && !math.IsNaN(*m.ContextPercent) && !math.IsInf(*m.ContextPercent, 0) {
		percent := jsRound(math.Max(0, math.Min(999, *m.ContextPercent)))
		color := colorContextNormal
		switch ContextColorTier(&percent, style.ContextThresholds) {
		case "error":
			color = colorContextError
		case "warning":
			color = colorContextWarning
		}
		label := strconv.Itoa(int(percent)) + "%"
		if style.ContextGauge {
			label = "[" + BuildContextGauge(percent, 5, style.ASCII) + "] " + label
		}
		parts = append(parts, RenderThemeStyle(theme, color, label))
	}
	if style.ShowTimer && m.AgentDurationMs != nil {
		duration := FormatElapsedDuration(*m.AgentDurationMs)
		if m.AgentActive {
			parts = append(parts, RenderThemeStyle(theme, colorSessionDuration, duration))
		} else {
			parts = append(parts, muted(duration))
		}
	}
	if m.Btw != nil {
		parts = append(parts, pill(theme, m.Btw))
	}
	return joinStyled(parts, muted(" · "))
}

func renderTopRight(inputText string, m Metadata, theme Theme, style Style, available int, renderBorder func(string) string, fit bool) string {
	var parts []string
	if BashModeLabel(inputText) != "" {
		parts = append(parts, SafeThemeFg(theme, "dim", "Enter to run"))
	}
	if style.ShowCost {
		if cost := strings.TrimSpace(m.CostLabel); cost != "" {
			parts = append(parts, RenderThemeStyle(theme, colorCost, cost))
		}
	}
	if model := strings.TrimSpace(m.ModelLabel); model != "" {
		parts = append(parts, RenderThemeStyle(theme, colorModel, model))
	}
	if m.CodexQuota != nil {
		parts = append(parts, SafeThemeFg(theme, m.CodexQuota.Role, m.CodexQuota.Text))
	}
	if m.Quota != nil {
		parts = append(parts, SafeThemeFg(theme, m.Quota.Role, m.Quota.Text))
	}
	var b strings.Builder
	for i, part := range parts {
		if i > 0 {
			b.WriteString(renderBorder(" – "))
		}
		b.WriteString(part)
	}
	if fit {
		return truncate(b.String(), available, "…")
	}
	return b.String()
}

func renderBottomLeft(m Metadata, theme Theme, style Style) string {
	if !style.ShowGit {
		return ""
	}
	var parts []string
	if branch := strings.TrimSpace(m.Branch); branch != "" {
		parts = append(parts, RenderThemeStyle(theme, colorGitBranch, branch))
	}
	if m.Dirty {
		parts = append(parts, RenderThemeStyle(theme, colorGitStatus, "*"))
	}
	if m.Ahead > 0 {
		parts = append(parts, SafeThemeFg(theme, "success", "↑"+strconv.Itoa(m.Ahead)))
	}
	if m.Behind > 0 {
		parts = append(parts, SafeThemeFg(theme, "error", "↓"+strconv.Itoa(m.Behind)))
	}
	return strings.Join(parts, " ")
}

func renderBottomRight(m Metadata, theme Theme, style Style, home string) string {
	cwd := strings.TrimSpace(FormatCwdLabel(m.Cwd, style.PathDisplay, m.ProjectRoot, home))
	if cwd == "" {
		return ""
	}
	return RenderThemeStyle(theme, colorCwd, cwd)
}

type labeledBorder struct {
	width                   int
	left                    string
	leftFallbacks           []string
	right                   string
	fitRight                func(int) string
	leftCorner, rightCorner string
	renderBorder            func(string) string
}

func renderLabeledBorder(o labeledBorder) string {
	vw := tuiwidth.VisibleWidth
	innerWidth := max(0, o.width-2)
	left, right := o.left, o.right
	fitLabels := func() bool {
		overhead := 1
		if left != "" {
			overhead = 3
		}
		if right != "" {
			overhead += 3
		} else {
			overhead++
		}
		budget := max(0, innerWidth-overhead)
		leftNatural, rightNatural := vw(left), vw(right)
		if leftNatural+rightNatural <= budget {
			return false
		}
		leftBudget, rightBudget := 0, 0
		if left != "" {
			leftBudget = budget
		}
		if right != "" {
			rightBudget = budget
		}
		if left != "" && right != "" {
			leftBudget = (budget + 1) / 2
			rightBudget = budget - leftBudget
			if leftNatural < leftBudget {
				leftBudget = leftNatural
				rightBudget = budget - leftBudget
			} else if rightNatural < rightBudget {
				rightBudget = rightNatural
				leftBudget = budget - rightBudget
			}
		}
		if leftBudget > 0 {
			left = truncate(left, leftBudget, "…")
		} else {
			left = ""
		}
		if rightBudget > 0 {
			if o.fitRight != nil {
				right = o.fitRight(rightBudget)
			} else {
				right = truncate(right, rightBudget, "…")
			}
		} else {
			right = ""
		}
		return leftBudget < leftNatural
	}
	leftTruncated := fitLabels()
	for _, fallback := range o.leftFallbacks {
		if !leftTruncated {
			break
		}
		left = fallback
		right = o.right
		leftTruncated = fitLabels()
	}
	partWidth := func(label string) int {
		if label == "" {
			return 1
		}
		return vw(label) + 3
	}
	leftWidth, rightWidth := partWidth(left), partWidth(right)
	if leftWidth+rightWidth > innerWidth {
		left, right = "", ""
		leftWidth, rightWidth = 1, 1
	}
	fill := max(0, innerWidth-leftWidth-rightWidth)
	leftPart := o.renderBorder("─")
	if left != "" {
		leftPart = o.renderBorder("─ ") + left + o.renderBorder(" ")
	}
	rightPart := o.renderBorder("─")
	if right != "" {
		rightPart = o.renderBorder(" ") + right + o.renderBorder(" ─")
	}
	return o.renderBorder(o.leftCorner) + leftPart + o.renderBorder(strings.Repeat("─", fill)) + rightPart + o.renderBorder(o.rightCorner)
}

var viewportCount = regexp.MustCompile(`^[1-9]\d*$`)

// Viewport is the scroll counts lifted from the base editor's rules.
type Viewport struct {
	Above string `json:"above,omitempty"`
	Below string `json:"below,omitempty"`
}

// RenderInput is the argument object of renderMinimalistFrame. Home is the
// home directory formatCwdLabel reads.
type RenderInput struct {
	Width       int
	EditorLines []string
	PanelLines  []string
	Viewport    *Viewport
	InputText   string
	Metadata    Metadata
	Theme       Theme
	Style       Style
	Home        string
}

// RenderMinimalistFrame is renderMinimalistFrame.
func RenderMinimalistFrame(in RenderInput) []string {
	width, theme, style, m := in.Width, in.Theme, in.Style, in.Metadata
	if width <= 4 {
		return clampLines(in.EditorLines, width)
	}
	renderBorder := func(text string) string { return RenderThemeStyle(theme, colorBorder, text) }
	separator := SafeThemeFg(theme, "muted", " · ")
	viewportLabel := func(above bool, count string) string {
		if count == "" || !viewportCount.MatchString(count) {
			return ""
		}
		arrow := "↓"
		if above {
			arrow = "↑"
		}
		return SafeThemeFg(theme, "muted", arrow+" "+count+" more")
	}
	var vp Viewport
	if in.Viewport != nil {
		vp = *in.Viewport
	}
	topMetadata := renderTopLeft(in.InputText, m, theme, style)
	topViewport := viewportLabel(true, vp.Above)
	topLeft := joinStyled([]string{topViewport, topMetadata}, separator)
	topRightBudget := max(0, width-8-tuiwidth.VisibleWidth(topLeft))
	top := renderLabeledBorder(labeledBorder{
		width: width,
		left:  topLeft,
		right: renderTopRight(in.InputText, m, theme, style, topRightBudget, renderBorder, false),
		fitRight: func(budget int) string {
			return renderTopRight(in.InputText, m, theme, style, budget, renderBorder, true)
		},
		leftCorner: "╭", rightCorner: "╮",
		renderBorder: renderBorder,
	})
	bottomMetadata := renderBottomLeft(m, theme, style)
	bottomViewport := viewportLabel(false, vp.Below)
	sessionLabel := ""
	if style.ShowSessionName {
		sessionLabel = strings.TrimSpace(m.SessionName)
	}
	bottomLeft := joinStyled([]string{bottomViewport, bottomMetadata, sessionLabel}, separator)
	var fallbacks []string
	if bottomViewport != "" {
		for _, s := range []string{bottomMetadata, sessionLabel} {
			if s != "" {
				fallbacks = append(fallbacks, s)
			}
		}
		if fallbacks == nil {
			fallbacks = []string{}
		}
	}
	bottom := renderLabeledBorder(labeledBorder{
		width:         width,
		left:          bottomLeft,
		leftFallbacks: fallbacks,
		right:         renderBottomRight(m, theme, style, in.Home),
		leftCorner:    "╰", rightCorner: "╯",
		renderBorder: renderBorder,
	})
	rowTheme := borderTheme{renderBorder}
	lines := []string{top}
	for _, line := range in.EditorLines {
		lines = append(lines, chrome.FrameRow(rowTheme, line, width))
	}
	lines = append(lines, RenderFramedPanelRows(width, in.PanelLines, renderBorder)...)
	lines = append(lines, bottom)
	return clampLines(lines, width)
}
