package aio

// Styles wiring (port of styles/index.ts). The style rides the frame's top
// border beside the mode; the "style" footer status is the fallback without
// the frame.

import (
	"fmt"
	"os"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	"github.com/danielboothcloud/pi-aio/go/internal/styles"
)

func init() { addRegistrar(OrderStyles, "styles", registerStyles) }

type stylesState struct {
	mu      sync.Mutex
	current string
}

// stylesAccess lets recipes set the style on a live /recipe switch.
var stylesAccess *stylesState

// syncDisplay is syncDisplay: the frame contribution, then the footer
// status only without the frame.
func (s *stylesState) syncDisplay(ctx sdk.Context) {
	if s.current == "none" {
		frame.SetMetadataContributor(styleFrameKey, nil)
	} else {
		meta := styles.StyleMetadata(s.current)
		pill := &frame.Pill{Icon: meta.Icon, Label: meta.Label, Role: meta.Role}
		frame.SetMetadataContributor(styleFrameKey, func() frame.Contribution { return frame.Contribution{Style: pill} })
	}
	frame.RequestRepaint()
	if !ctx.HasUI() {
		return
	}
	if s.current == "none" || frame.Probe().Supported {
		ctx.ClearStatus(styles.StatusKey)
		return
	}
	meta := styles.StyleMetadata(s.current)
	ctx.SetStatus(styles.StatusKey, ctx.UITheme().Fg(meta.Role, meta.Icon+" "+meta.Label))
}

const styleFrameKey = "style"

// setLocked sets the style and saves it. The caller holds s.mu.
func (s *stylesState) setLocked(ctx sdk.Context, style string, quiet bool) {
	s.current = style
	s.syncDisplay(ctx)
	_ = ctx.AppendEntry(styles.EntryType, map[string]any{"style": style})
	if !quiet {
		ctx.Notify(styles.Notice(style), "info")
	}
}

func (s *stylesState) restore(ctx sdk.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if style, ok := styles.LatestPersisted(branchEntries(ctx)); ok {
		s.current = style
	} else if style := recipeStartStyle(); style != "" {
		s.current = style
	} else {
		s.current = "none"
	}
	s.syncDisplay(ctx)
}

func currentMode() string {
	if modesAccess == nil {
		return "default"
	}
	modesAccess.mu.Lock()
	defer modesAccess.mu.Unlock()
	return string(modesAccess.mode)
}

func registerStyles(e *sdk.Extension) {
	s := &stylesState{current: "none"}
	// Every process: a forked subagent child keeps style "none", so this
	// strips inherited style instructions from its context.
	e.OnEvent("context", func(_ sdk.Context, data map[string]any) (any, error) {
		messages, ok := data["messages"].([]any)
		if !ok {
			return nil, nil
		}
		s.mu.Lock()
		style := s.current
		s.mu.Unlock()
		if filtered, changed := styles.FilterContext(messages, style); changed {
			return map[string]any{"messages": filtered}, nil
		}
		return nil, nil
	})
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	stylesAccess = s
	e.RegisterCommand("style", sdk.CommandOptions{
		Description: fmt.Sprintf("Set an interaction style (%s); off by default", strings.Join(styles.Styles, " | ")),
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			var items []sdk.AutocompleteItem
			wanted := strings.ToLower(strings.TrimSpace(prefix))
			for _, style := range styles.Styles {
				if strings.HasPrefix(style, wanted) {
					items = append(items, sdk.AutocompleteItem{Value: style, Label: style, Description: styles.Summaries[style]})
				}
			}
			return items, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			requested := strings.TrimSpace(args)
			s.mu.Lock()
			defer s.mu.Unlock()
			if requested == "" {
				if !ctx.HasUI() {
					ctx.Notify("Style: "+s.current, "info")
					return nil
				}
				options := make([]string, len(styles.Styles))
				for i, style := range styles.Styles {
					options[i] = style + " — " + styles.Summaries[style]
				}
				title := fmt.Sprintf("Style: %s — switch to:", s.current)
				// The picker waits for the user, so it runs unlocked.
				s.mu.Unlock()
				choice, ok := ctxUI{ctx}.Select(title, options)
				s.mu.Lock()
				for i, option := range options {
					if ok && option == choice {
						s.setLocked(ctx, styles.Styles[i], false)
					}
				}
				return nil
			}
			style, ok := styles.ParseStyle(requested)
			if !ok {
				ctx.Notify(styles.UnknownNotice(requested), "error")
				return nil
			}
			s.setLocked(ctx, style, false)
			return nil
		},
	})
	e.OnEvent("before_agent_start", func(sdk.Context, map[string]any) (any, error) {
		s.mu.Lock()
		style := s.current
		s.mu.Unlock()
		if style == "none" {
			return nil, nil
		}
		return map[string]any{"message": map[string]any{
			"customType": styles.ContextType, "content": styles.BuildContext(style, currentMode()), "display": false,
		}}, nil
	})
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.restore(ctx)
		return nil, nil
	})
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.restore(ctx)
		return nil, nil
	})
	e.OnSessionShutdown(func(sdk.Context, map[string]any) (any, error) {
		frame.SetMetadataContributor(styleFrameKey, nil)
		return nil, nil
	})
}
