package aio

// Effort wiring (port of effort/). The frame shows the thinking level, so
// the "effort" footer status is set only without the frame; every change
// emits the aio:ui-state event. Difference from TypeScript: print mode
// notices go through ctx.Notify, not stdout/stderr.

import (
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/effort"
	"github.com/danielboothcloud/pi-aio/go/internal/frame"
)

func init() { addRegistrar(OrderEffort, "effort", registerEffort) }

// effortState holds the effective level. The mutex guards only the field:
// never hold it across a host call, because SetThinkingLevel makes the host
// send thinking_level_select back to this extension while the call runs.
type effortState struct {
	mu     sync.Mutex
	active string // "" is unknown
}

func (s *effortState) get() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

func (s *effortState) set(level string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if level == "unknown" {
		level = ""
	}
	s.active = level
}

func currentLevel(ctx sdk.Context) string {
	level, err := ctx.GetThinkingLevel()
	if err != nil || !effort.IsLevel(level) {
		return "unknown"
	}
	return level
}

func currentModel(ctx sdk.Context) *effort.Model {
	provider, id := ctx.ModelProvider(), ctx.Model()
	if provider == "" || id == "" {
		return nil
	}
	model, err := ctx.ModelRegistry().Find(provider, id)
	if err != nil {
		return nil
	}
	return effort.ModelFrom(model)
}

func (s *effortState) effective(ctx sdk.Context) string {
	if active := s.get(); active != "" {
		return active
	}
	return currentLevel(ctx)
}

// showEffort is updateEffortStatus: the aio:ui-state event, then the
// footer status only without the frame (the frame shows the thinking level
// itself).
func showEffort(ctx sdk.Context, level string) {
	_ = ctx.Events().Emit(frame.UIStateEvent, map[string]any{"effort": level})
	if !ctx.HasUI() || frame.Probe().Supported {
		return
	}
	ctx.SetStatus(effort.StatusKey, effortStatusText(ctx, level))
}

// effortStatusText is formatEffortStatus.
func effortStatusText(ctx sdk.Context, level string) string {
	theme, text := ctx.UITheme(), "effort:"+level
	switch level {
	case "off":
		return theme.Fg("dim", text)
	case "minimal", "low":
		return theme.Fg("muted", text)
	case "high", "xhigh":
		return theme.Fg("accent", text)
	}
	return text
}

// setLevel is setThinkingEffort.
func (s *effortState) setLevel(ctx sdk.Context, level string, announce bool) string {
	ctx.SetThinkingLevel(level)
	actual := currentLevel(ctx)
	if level == "max" && actual == "off" {
		ctx.SetThinkingLevel("xhigh")
		actual = currentLevel(ctx)
	}
	effective := actual
	if actual != "unknown" {
		effective = effort.EffectiveLevel(currentModel(ctx), level, actual)
	}
	s.set(effective)
	showEffort(ctx, effective)
	if announce {
		text, kind := effort.SetNotice(level, effective)
		ctx.Notify(text, kind)
	}
	return effective
}

func ensureToolActive(ctx sdk.Context, name string) bool {
	active, err := ctx.GetActiveTools()
	if err != nil {
		return false
	}
	for _, tool := range active {
		if tool == name {
			return true
		}
	}
	all, err := ctx.GetAllTools()
	if err != nil {
		return false
	}
	for _, tool := range all {
		if tool.Name == name {
			ctx.SetActiveTools(append(active, name))
			return true
		}
	}
	return false
}

func registerEffort(e *sdk.Extension) {
	s := &effortState{}
	e.RegisterCommand("effort", sdk.CommandOptions{
		Description: "Set thinking effort: off|minimal|low|medium|high|xhigh|max|ultracode",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			var items []sdk.AutocompleteItem
			for _, option := range effort.Completions(prefix) {
				items = append(items, sdk.AutocompleteItem{Value: option.Value, Label: option.Value, Description: option.Description})
			}
			return items, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			value := strings.TrimSpace(args)
			if value == "" && ctx.HasUI() {
				value = "status"
				if choice, ok := (ctxUI{ctx}).Select("Select thinking effort", effort.SelectLabels()); ok {
					value = strings.Fields(choice)[0]
				}
			}
			switch target := effort.ParseTarget(value); target.Kind {
			case "status":
				current := s.effective(ctx)
				showEffort(ctx, current)
				ctx.Notify(effort.Usage(current), "info")
			case "invalid":
				ctx.Notify(`Unknown effort "`+target.Value+`". `+effort.Usage(currentLevel(ctx)), "warning")
			case "level":
				s.setLevel(ctx, target.Level, true)
			default:
				actual := s.setLevel(ctx, "xhigh", false)
				router := ensureToolActive(ctx, "dynamic_workflow")
				_ = ctx.Events().Emit(effort.UltracodeEvent, map[string]any{"enabled": true, "source": "/effort"})
				text, kind := effort.UltracodeNotice(actual, router)
				ctx.Notify(text, kind)
			}
			return nil
		},
	})
	e.OnEvent("thinking_level_select", func(ctx sdk.Context, data map[string]any) (any, error) {
		requested, _ := data["level"].(string)
		clamped := currentLevel(ctx)
		effective := clamped
		if clamped != "unknown" {
			effective = effort.EffectiveLevel(currentModel(ctx), requested, clamped)
		}
		s.set(effective)
		showEffort(ctx, effective)
		return nil, nil
	})
	e.OnEvent("model_select", func(ctx sdk.Context, _ map[string]any) (any, error) {
		// The host reports the clamped level for the new model; follow it
		// until the user asks for a level again.
		s.set(currentLevel(ctx))
		showEffort(ctx, s.effective(ctx))
		return nil, nil
	})
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		showEffort(ctx, s.effective(ctx))
		return nil, nil
	})
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.HasUI() {
			ctx.ClearStatus(effort.StatusKey)
		}
		return nil, nil
	})
	// Re-inject a requested xhigh/max that the host clamped down, when the
	// model is reasoning-capable and the payload uses reasoning_effort.
	e.OnEvent("before_provider_request", func(ctx sdk.Context, data map[string]any) (any, error) {
		desired := s.get()
		payload, _ := data["payload"].(map[string]any)
		if out, changed := effort.ApplyOverride(currentModel(ctx), desired, payload); changed {
			return out, nil
		}
		return nil, nil
	})
}
