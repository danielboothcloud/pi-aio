package frame

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// BashModeLabel is bashModeLabel: "" for normal input, "shell" for `!`,
// "no-context" for `!!`.
func BashModeLabel(text string) string {
	trimmed := strings.TrimLeftFunc(text, jsstr.IsJSSpace)
	switch {
	case strings.HasPrefix(trimmed, "!!"):
		return "no-context"
	case strings.HasPrefix(trimmed, "!"):
		return "shell"
	}
	return ""
}

// jsRound is Math.round.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// FormatCount is formatCount.
func FormatCount(value float64) string {
	if value < 1000 {
		return jsstr.NumberString(value)
	}
	if value < 1_000_000 {
		if value < 10_000 {
			return jsstr.ToFixed(value/1000, 1) + "k"
		}
		return jsstr.NumberString(jsRound(value/1000)) + "k"
	}
	if value < 10_000_000 {
		return jsstr.ToFixed(value/1_000_000, 1) + "M"
	}
	return jsstr.NumberString(jsRound(value/1_000_000)) + "M"
}

// FormatElapsedDuration is formatElapsedDuration: whole seconds.
func FormatElapsedDuration(durationMs float64) string {
	total := int64(math.Max(0, math.Floor(durationMs/1000)))
	hours := total / 3600
	minutes := (total % 3600) / 60
	seconds := total % 60
	switch {
	case hours > 0:
		return strconv.FormatInt(hours, 10) + "h " + strconv.FormatInt(minutes, 10) + "m"
	case minutes > 0:
		return strconv.FormatInt(minutes, 10) + "m " + strconv.FormatInt(seconds, 10) + "s"
	}
	return strconv.FormatInt(seconds, 10) + "s"
}

// ContextThresholds is ContextThresholds.
type ContextThresholds struct {
	Warning float64 `json:"warning"`
	Error   float64 `json:"error"`
}

// ContextColorTier is contextColorTier; nil percent is "normal".
func ContextColorTier(percent *float64, thresholds ContextThresholds) string {
	if percent == nil || math.IsNaN(*percent) || math.IsInf(*percent, 0) {
		return "normal"
	}
	if *percent >= thresholds.Error {
		return "error"
	}
	if *percent >= thresholds.Warning {
		return "warning"
	}
	return "normal"
}

// BuildContextGauge is buildContextGauge.
func BuildContextGauge(percent float64, width int, ascii bool) string {
	clamped := math.Max(0, math.Min(100, percent))
	filled := int(jsRound(clamped / 100 * float64(width)))
	on, off := "█", "░"
	if ascii {
		on, off = "#", "-"
	}
	return strings.Repeat(on, filled) + strings.Repeat(off, max(0, width-filled))
}

// UsageTotals is UsageTotals.
type UsageTotals struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Cost       float64 `json:"cost"`
}

func normalizeUsageNumber(value any) float64 {
	f, ok := numberValue(value)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0
	}
	return f
}

func numberValue(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	}
	return 0, false
}

func usageCostTotal(usage map[string]any) float64 {
	cost, ok := usage["cost"].(map[string]any)
	if !ok {
		return 0
	}
	return normalizeUsageNumber(cost["total"])
}

func addUsageTotal(total, value float64) float64 {
	sum := total + value
	if math.IsInf(sum, 0) || math.IsNaN(sum) {
		return 9007199254740991
	}
	return sum
}

func usageForEntry(entry map[string]any) (map[string]any, bool) {
	switch entry["type"] {
	case "message":
		message, _ := entry["message"].(map[string]any)
		role, _ := message["role"].(string)
		if role != "assistant" && role != "toolResult" {
			return nil, false
		}
		usage, _ := message["usage"].(map[string]any)
		return usage, true
	case "compaction", "branch_summary":
		usage, _ := entry["usage"].(map[string]any)
		return usage, true
	}
	return nil, false
}

// ComputeUsageTotals is computeUsageTotals (the value getUsageTotals caches
// by an entry fingerprint).
func ComputeUsageTotals(entries []map[string]any) UsageTotals {
	var t UsageTotals
	for _, entry := range entries {
		usage, ok := usageForEntry(entry)
		if !ok {
			continue
		}
		t.Input = addUsageTotal(t.Input, normalizeUsageNumber(usage["input"]))
		t.Output = addUsageTotal(t.Output, normalizeUsageNumber(usage["output"]))
		t.CacheRead = addUsageTotal(t.CacheRead, normalizeUsageNumber(usage["cacheRead"]))
		t.CacheWrite = addUsageTotal(t.CacheWrite, normalizeUsageNumber(usage["cacheWrite"]))
		t.Cost = addUsageTotal(t.Cost, usageCostTotal(usage))
	}
	return t
}

// BuildCostLabel is buildCostLabel.
func BuildCostLabel(t UsageTotals) string { return "$" + jsstr.ToFixed(t.Cost, 3) }

func toHomePath(path, home string) string {
	if home != "" && (path == home || strings.HasPrefix(path, home+"/") || strings.HasPrefix(path, home+string(filepath.Separator))) {
		return "~" + path[len(home):]
	}
	return path
}

// FormatCwdLabel is formatCwdLabel with the home directory passed in:
// "compact" is the basename, "project" is root-relative, "full" is
// home-abbreviated.
func FormatCwdLabel(cwd, mode, projectRoot, home string) string {
	full := func() string { return toHomePath(cwd, home) }
	if mode == "full" {
		return full()
	}
	if mode == "compact" {
		parts := nonEmpty(strings.Split(cwd, "/"))
		if len(parts) == 0 {
			return cwd
		}
		return parts[len(parts)-1]
	}
	if projectRoot == "" {
		return full()
	}
	rel, err := filepath.Rel(projectRoot, cwd)
	if err != nil {
		return full()
	}
	if rel == "." {
		rel = ""
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return full()
	}
	parts := nonEmpty(strings.Split(projectRoot, "/"))
	project := projectRoot
	if len(parts) > 0 {
		project = parts[len(parts)-1]
	}
	if rel != "" {
		return project + "/" + rel
	}
	return project
}

func nonEmpty(parts []string) []string {
	out := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
