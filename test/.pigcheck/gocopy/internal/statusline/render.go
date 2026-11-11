package statusline

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Theme is PiTheme.
type Theme interface {
	Fg(role, text string) string
}

// UsageStats is UsageStats.
type UsageStats struct {
	Input  float64 `json:"input"`
	Output float64 `json:"output"`
	Cost   float64 `json:"cost"`
}

// Status is one extension status, in the footer data's order.
type Status struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ModeMeta is the permission mode's icon, label and theme role.
type ModeMeta struct {
	Icon  string `json:"icon"`
	Label string `json:"label"`
	Role  string `json:"role"`
}

// Model is the model's provider and id (nil for no model).
type Model struct {
	Provider string `json:"provider,omitempty"`
	ID       string `json:"id,omitempty"`
}

// RenderInput is StatusLineRenderInput. GitBranch "" is null; Home is
// process.env.HOME.
type RenderInput struct {
	Width          int
	Theme          Theme
	Config         Config
	Cwd            string
	Model          *Model
	Mode           ModeMeta
	GitBranch      string
	ContextPercent int
	Statuses       []Status
	Usage          UsageStats
	ProviderUsage  []ProviderUsage
	Home           string
	Now            float64
}

var statusKeyOrder = []string{"rtk", "user-bash", "fff", "codex-quota"}

var (
	dedicatedStatusKeys = map[string]bool{"effort": true, "cursor": true, "style": true}
	hiddenStatusKeys    = map[string]bool{"modes": true}
)

const (
	iconPath    = "⌂"
	iconGit     = "⎇"
	iconContext = "◫"
	iconEffort  = "⚡"
	iconCursor  = "◈"
	iconModel   = "◇"
	iconQuota   = "◴"
	iconTokens  = "⊛"
	iconCost    = "$"
)

func labeled(theme Theme, icon, text, role string) string {
	return theme.Fg("dim", icon) + " " + theme.Fg(role, text)
}

var pathSep = regexp.MustCompile(`[/\\]`)

func splitPath(path string) []string {
	var parts []string
	for _, p := range pathSep.Split(path, -1) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

// FormatPath is formatPath.
func FormatPath(cwd, display, home string) string {
	if cwd == "" {
		return ""
	}
	if display == "full" {
		return cwd
	}
	if display == "abbreviated" {
		normalized := cwd
		if home != "" && strings.HasPrefix(cwd, home) {
			normalized = "~" + cwd[len(home):]
		}
		parts := splitPath(normalized)
		if len(parts) <= 2 {
			return normalized
		}
		return "…/" + strings.Join(parts[len(parts)-2:], "/")
	}
	parts := splitPath(cwd)
	if len(parts) == 0 {
		return cwd
	}
	return parts[len(parts)-1]
}

func contextRole(percent int) string {
	switch {
	case percent >= 90:
		return "error"
	case percent >= 70:
		return "warning"
	}
	return "muted"
}

func quotaRole(percent *float64) string {
	if percent != nil && *percent <= 10 {
		return "error"
	}
	if percent != nil && *percent <= 25 {
		return "warning"
	}
	return "muted"
}

func formatModel(model *Model) string {
	if model == nil || model.ID == "" {
		return "no-model"
	}
	if model.Provider != "" {
		return model.Provider + "/" + model.ID
	}
	return model.ID
}

// localeCompare approximates String.prototype.localeCompare.
func localeCompare(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

func orderedStatusEntries(statuses []Status, statusKeys []string) []Status {
	var entries []Status
	for _, s := range statuses {
		if !hiddenStatusKeys[s.Key] && !dedicatedStatusKeys[s.Key] && s.Value != "" {
			entries = append(entries, s)
		}
	}
	if len(statusKeys) > 0 {
		allow := map[string]bool{}
		for _, k := range statusKeys {
			allow[k] = true
		}
		var kept []Status
		for _, e := range entries {
			if allow[e.Key] {
				kept = append(kept, e)
			}
		}
		return kept
	}
	rank := map[string]int{}
	for i, k := range statusKeyOrder {
		rank[k] = i
	}
	sort.SliceStable(entries, func(i, j int) bool {
		ra, aok := rank[entries[i].Key]
		rb, bok := rank[entries[j].Key]
		switch {
		case aok && bok:
			return ra < rb
		case aok:
			return true
		case bok:
			return false
		}
		return localeCompare(entries[i].Key, entries[j].Key) < 0
	})
	return entries
}

func statusValue(statuses []Status, key string) string {
	for _, s := range statuses {
		if s.Key == key {
			return s.Value
		}
	}
	return ""
}

// FormatCountPM is permission-modes/utils formatCount.
func FormatCountPM(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return "0"
	}
	abs := math.Abs(n)
	switch {
	case abs < 1000:
		return jsstr.NumberJS(n)
	case abs < 10_000:
		return jsstr.ToFixed(n/1000, 1) + "k"
	case abs < 1_000_000:
		return jsstr.NumberJS(math.Floor(n/1000+0.5)) + "k"
	}
	return jsstr.ToFixed(n/1_000_000, 1) + "M"
}

func renderSegment(segment string, in RenderInput) string {
	theme := in.Theme
	switch segment {
	case "mode":
		modeText := theme.Fg(in.Mode.Role, in.Mode.Icon+" "+in.Mode.Label)
		if in.Mode.Icon == "" {
			modeText = theme.Fg(in.Mode.Role, in.Mode.Label)
		}
		if style := statusValue(in.Statuses, "style"); style != "" {
			return modeText + theme.Fg("muted", " · ") + style
		}
		return modeText
	case "path":
		if path := FormatPath(in.Cwd, in.Config.Path, in.Home); path != "" {
			return labeled(theme, iconPath, path, "muted")
		}
	case "git":
		if in.GitBranch != "" {
			return labeled(theme, iconGit, in.GitBranch, "accent")
		}
	case "context":
		return labeled(theme, iconContext, strconv.Itoa(in.ContextPercent)+"%", contextRole(in.ContextPercent))
	case "effort":
		if value := statusValue(in.Statuses, "effort"); value != "" {
			return theme.Fg("dim", iconEffort) + " " + value
		}
	case "statuses":
		entries := orderedStatusEntries(in.Statuses, in.Config.StatusKeys)
		if len(entries) == 0 {
			return ""
		}
		values := make([]string, len(entries))
		for i, e := range entries {
			values[i] = e.Value
		}
		return strings.Join(values, theme.Fg("muted", " · "))
	case "cursor":
		if value := statusValue(in.Statuses, "cursor"); value != "" {
			return labeled(theme, iconCursor, value, "muted")
		}
	case "model":
		return labeled(theme, iconModel, formatModel(in.Model), "accent")
	case "quota":
		if len(in.ProviderUsage) == 0 {
			return ""
		}
		var lowest *float64
		for _, u := range in.ProviderUsage {
			if u.RemainingPercent != nil && (lowest == nil || *u.RemainingPercent < *lowest) {
				v := *u.RemainingPercent
				lowest = &v
			}
		}
		role := quotaRole(lowest)
		parts := make([]string, len(in.ProviderUsage))
		for i, u := range in.ProviderUsage {
			parts[i] = theme.Fg(role, FormatProviderUsage(u, in.Now))
		}
		return theme.Fg("dim", iconQuota) + " " + strings.Join(parts, theme.Fg("muted", " · "))
	case "tokens":
		return labeled(theme, iconTokens, "↑"+FormatCountPM(in.Usage.Input)+" ↓"+FormatCountPM(in.Usage.Output), "muted")
	case "cost":
		return labeled(theme, iconCost, jsstr.ToFixed(in.Usage.Cost, 3), "muted")
	}
	return ""
}

// Render is renderStatusLine: the segments in one dim-separated row,
// truncated to width.
func Render(in RenderInput) []string {
	var parts []string
	for _, segment := range in.Config.Segments {
		if rendered := renderSegment(segment, in); rendered != "" {
			parts = append(parts, rendered)
		}
	}
	if len(parts) == 0 {
		return []string{""}
	}
	line := strings.Join(parts, in.Theme.Fg("muted", " · "))
	return []string{tuiwidth.TruncateToWidth(line, in.Width, "...", false)}
}

// ContextPercent is computeContextPercent.
func ContextPercent(tokens, contextWindow *float64) int {
	t, w := 0.0, 0.0
	if tokens != nil {
		t = *tokens
	}
	if contextWindow != nil {
		w = *contextWindow
	}
	if t <= 0 || w <= 0 {
		return 0
	}
	return int(math.Floor(t/w*100 + 0.5))
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

// ComputeUsageStats is computeUsageStats over the branch entries.
func ComputeUsageStats(branch []map[string]any) UsageStats {
	var s UsageStats
	for _, entry := range branch {
		if entry["type"] != "message" {
			continue
		}
		message, _ := entry["message"].(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		usage, _ := message["usage"].(map[string]any)
		s.Input += num(usage["input"])
		s.Output += num(usage["output"])
		cost, _ := usage["cost"].(map[string]any)
		s.Cost += num(cost["total"])
	}
	return s
}

// WorkingStats are the formatWorkingMessage inputs.
type WorkingStats struct {
	UsageStats
	ContextPercent int
	ElapsedSec     float64
	TPS            float64
}

// FormatWorkingMessage is formatWorkingMessage; ok is false for "off".
func FormatWorkingMessage(mode string, s WorkingStats) (string, bool) {
	switch mode {
	case "off":
		return "", false
	case "minimal":
		return "Working…", true
	}
	return "Working (" + jsstr.ToFixed(s.ElapsedSec, 1) + "s  ↑" + FormatCountPM(s.Input) + " ↓" + FormatCountPM(s.Output) + " " +
		jsstr.ToFixed(s.TPS, 1) + " tok/s  " + strconv.Itoa(s.ContextPercent) + "% ctx)", true
}

// nowMs is Date.now().
func nowMs() float64 { return float64(time.Now().UnixMilli()) }
