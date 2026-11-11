package aio

// Session-nav wiring (port of session-nav/index.ts). /rewind (also a
// double Escape on an idle, empty editor) and /sessions (also the exact
// text /resume, the app.session.resume key, and the --sessions flag). The
// models and pickers are in go/internal/sessionnav; the pickers are
// sdk.RemoteComponent overlays.
//
// Difference from TypeScript: the editor-originated commands run through
// the AIO editor's host onSubmit (sdk.Editor.OnSubmit), as if the user
// submitted them. PiG's sendUserMessage drops expandPromptTemplates, so it
// would send the command text to the model (see PIG-LIMITS.md). The
// submitted command is added to the editor history.

import (
	"os"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
	"github.com/danielboothcloud/pi-aio/go/internal/sessionnav"
	"github.com/danielboothcloud/pi-aio/go/internal/ui"
)

func init() { addRegistrar(OrderSessionNav, "session-nav", registerSessionNav) }

type navKeys struct{}

func (navKeys) MatchesKey(data, id string) bool { return sdktui.MatchesKey(data, sdktui.KeyID(id)) }
func (navKeys) DecodeKittyPrintable(data string) (string, bool) {
	return sdktui.DecodeKittyPrintable(data)
}

// rewindComponent shows the rewind picker as an overlay.
type rewindComponent struct {
	mu         sync.Mutex
	picker     *sessionnav.RewindPicker
	result     *sessionnav.RewindResult
	done       bool
	invalidate func()
}

func (c *rewindComponent) Render(width int) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.picker.Render(width)
}

func (c *rewindComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.picker.HandleInput(data)
	if c.done {
		if c.result == nil {
			return sdk.RemoteComponentResult{Done: true}, nil
		}
		return sdk.RemoteComponentResult{Done: true, Value: map[string]any{"id": c.result.Checkpoint.ID, "action": c.result.Action}}, nil
	}
	return sdk.RemoteComponentResult{}, nil
}

// resumeComponent shows the resume picker as an overlay; its loads repaint
// through the invalidate callback.
type resumeComponent struct {
	mu         sync.Mutex
	picker     *sessionnav.ResumePicker
	path       string
	done       bool
	invalidate func()
}

func (c *resumeComponent) Render(width int) []string { return c.picker.Render(width) }

func (c *resumeComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	c.picker.HandleInput(data)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		if c.path == "" {
			return sdk.RemoteComponentResult{Done: true}, nil
		}
		return sdk.RemoteComponentResult{Done: true, Value: c.path}, nil
	}
	return sdk.RemoteComponentResult{}, nil
}

func (c *resumeComponent) SetInvalidate(fn func()) {
	c.mu.Lock()
	c.invalidate = fn
	c.mu.Unlock()
}

func (c *resumeComponent) requestRender() {
	c.mu.Lock()
	fn := c.invalidate
	c.mu.Unlock()
	if fn != nil {
		fn()
	}
}

func overlayOptions() sdk.RemoteOverlayOptions {
	margin := 1
	return sdk.RemoteOverlayOptions{Overlay: true, OverlayOptions: &sdk.OverlayOptions{
		Anchor: "center", Margin: &sdk.OverlayMargin{All: &margin}, MaxHeight: sdk.OverlayPercent(90), MinWidth: 40, Width: sdk.OverlayPercent(85),
	}}
}

func toTree(nodes []sdk.SessionTreeNode) []sessionnav.TreeNode {
	out := make([]sessionnav.TreeNode, len(nodes))
	for i, n := range nodes {
		out[i] = sessionnav.TreeNode{Entry: n.Entry, Children: toTree(n.Children), Label: n.Label}
	}
	return out
}

func toSessions(list []sdk.SessionInfo) []sessionnav.Session {
	out := make([]sessionnav.Session, len(list))
	for i, s := range list {
		name := ""
		if s.Name != nil {
			name = *s.Name
		}
		out[i] = sessionnav.Session{
			Path: s.Path, ID: s.ID, Cwd: s.Cwd, Name: name, Created: float64(s.Created.UnixMilli()),
			Modified: float64(s.Modified.UnixMilli()), MessageCount: s.MessageCount, FirstMessage: s.FirstMessage,
			AllMessagesText: s.AllMessagesText,
		}
	}
	return out
}

func runRewind(ctx sdk.Context) error {
	idle, _ := ctx.IsIdle()
	tree, _ := ctx.SessionManager().GetTree()
	leaf, _ := ctx.SessionManager().GetLeafID()
	leafID := ""
	if leaf != nil {
		leafID = *leaf
	}
	checkpoints := sessionnav.BuildCheckpoints(toTree(tree), leafID)
	if msg, level, ok := sessionnav.RewindGuard(ctx.Mode() == "tui", idle, len(checkpoints)); !ok {
		ctx.Notify(msg, level)
		return nil
	}
	component := &rewindComponent{}
	component.picker = sessionnav.NewRewindPicker(sessionnav.RewindPickerOptions{
		Theme: ctx.UITheme(), Keys: navKeys{}, Checkpoints: checkpoints,
		MaxRows: func() int { return sessionnav.MaxPickerRows(ctx.Height()) },
		Done: func(r *sessionnav.RewindResult) {
			component.result, component.done = r, true
		},
		RequestRender: func() {},
	})
	value, err := ctx.Custom(component, overlayOptions())
	if err != nil || value == nil {
		return nil
	}
	choice, _ := value.(map[string]any)
	id, _ := choice["id"].(string)
	action, _ := choice["action"].(string)
	var picked *sessionnav.Checkpoint
	for i := range checkpoints {
		if checkpoints[i].ID == id {
			picked = &checkpoints[i]
		}
	}
	if picked == nil {
		return nil
	}
	call := sessionnav.ApplyRewind(sessionnav.RewindResult{Checkpoint: *picked, Action: action})
	if call.Notice != "" {
		ctx.Notify(call.Notice, "info")
	}
	if call.Op == "fork" {
		_, err = ctx.Fork(call.TargetID, map[string]any{"position": "before"})
	} else {
		_, err = ctx.NavigateTree(call.TargetID, map[string]any{"summarize": call.Summarize})
	}
	if err != nil {
		ctx.Notify("Rewind failed: "+err.Error(), "error")
	}
	return nil
}

func runSessions(ctx sdk.Context) error {
	if msg, level, ok := sessionnav.SessionsGuard(ctx.Mode() == "tui"); !ok {
		ctx.Notify(msg, level)
		return nil
	}
	sm := ctx.SessionManager()
	cwd, _ := sm.GetCwd()
	sessionDir, _ := sm.GetSessionDir()
	current := ""
	if file, err := sm.GetSessionFile(); err == nil && file != nil {
		current = *file
	}
	agentDir, _ := agentDirAndConfig()
	home, _ := os.UserHomeDir()
	component := &resumeComponent{}
	component.picker = sessionnav.NewResumePicker(sessionnav.ResumePickerOptions{
		Theme: ctx.UITheme(), Keys: navKeys{}, Cwd: cwd, CurrentPath: current, HomeDir: home,
		LoadSessions: func(scope string) ([]sessionnav.Session, error) {
			var list []sdk.SessionInfo
			var err error
			switch {
			case scope == "folder":
				list, err = sdk.SessionManagerList(ctx, cwd, &sessionDir, nil)
			case sessionnav.UsesDefaultSessionDir(sessionDir, agentDir):
				list, err = sdk.SessionManagerListAll(ctx, nil, nil)
			default:
				list, err = sdk.SessionManagerListAll(ctx, &sessionDir, nil)
			}
			return toSessions(list), err
		},
		LoadPreview: func(path string) (sessionnav.LastExchange, error) {
			return sessionnav.ReadLastExchange(path, 256*1024)
		},
		MaxRows: func() int { return sessionnav.MaxPickerRows(ctx.Height()) },
		Done: func(path string) {
			component.mu.Lock()
			component.path, component.done = path, true
			component.mu.Unlock()
		},
		RequestRender: func() { component.requestRender() },
	})
	value, err := ctx.Custom(component, overlayOptions())
	path, _ := value.(string)
	if err != nil || path == "" {
		return nil
	}
	if path == current {
		ctx.Notify("That session is already open.", "info")
		return nil
	}
	if _, err := ctx.SwitchSession(path, nil); err != nil {
		ctx.Notify("Could not open the session: "+err.Error(), "error")
	}
	return nil
}

func registerSessionNav(e *sdk.Extension) {
	var (
		mu      sync.Mutex
		loaded  *sdk.Context
		esc     sessionnav.EscapeState
		tuiMode bool
		shown   bool
	)
	e.Flag(sessionnav.SessionsFlag, sdk.FlagOptions{
		Description: "Start with AIO's session picker open (a friendlier --resume)",
		Type:        sdk.FlagBoolean,
		Default:     false,
	})
	e.OnLoaded(func(ctx sdk.Context) { loaded = &ctx })
	runCommand := func(name string) {
		if !submitThroughEditor("/" + name) {
			if loaded != nil {
				loaded.Notify("Could not open /"+name+": no AIO editor is installed", "error")
			}
		}
	}
	onEscape := func() bool {
		mu.Lock()
		isTUI := tuiMode
		mu.Unlock()
		if loaded == nil {
			return false
		}
		idle, err := loaded.IsIdle()
		if err != nil {
			idle = false
		}
		pending, _ := loaded.HasPendingMessages()
		if esc.OnEscape(isTUI, idle, pending, nowMillis()) {
			runCommand(sessionnav.RewindCommand)
			return true
		}
		return false
	}
	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		esc.Reset()
		mu.Lock()
		tuiMode = ctx.Mode() == "tui"
		mu.Unlock()
		if ctx.Mode() != "tui" {
			return nil, nil
		}
		agentDir, configDir := agentDirAndConfig()
		trusted, _ := ctx.IsProjectTrusted()
		esc.DoubleEscape = sessionnav.ReadDoubleEscapeAction(agentDir, ctx.Cwd(), configDir, trusted)
		ui.SetEditorIntercepts(&ui.Intercepts{
			Escape: onEscape,
			Submit: func(text string) bool {
				if !sessionnav.IsResumeText(text) {
					return false
				}
				runCommand(sessionnav.SessionsCommand)
				return true
			},
			Action: func(action string) bool {
				if action != "app.session.resume" {
					return false
				}
				runCommand(sessionnav.SessionsCommand)
				return true
			},
		})
		reason, _ := data["reason"].(string)
		flag, _ := ctx.GetFlag(sessionnav.SessionsFlag)
		args, _ := piargs.HarnessArgv()
		mu.Lock()
		open := sessionnav.OpensStartupPicker(reason, shown, flag == true, args)
		if open {
			shown = true
		}
		mu.Unlock()
		if open {
			go func() {
				// setTimeout(…, 0): after the session_start handlers; the
				// frame wraps the editor last.
				for i := 0; i < 50; i++ {
					time.Sleep(20 * time.Millisecond)
					if editorOwner.get() == "frame" || i > 10 {
						break
					}
				}
				runCommand(sessionnav.SessionsCommand)
			}()
		}
		return nil, nil
	})
	e.OnSessionShutdown(func(_ sdk.Context, _ map[string]any) (any, error) {
		ui.SetEditorIntercepts(nil)
		return nil, nil
	})
	e.RegisterCommand(sessionnav.RewindCommand, sdk.CommandOptions{
		Description: "Go back to an earlier prompt in this session (double-Esc)",
		Handler:     func(ctx sdk.Context, _ string) error { return runRewind(ctx) },
	})
	e.RegisterCommand(sessionnav.SessionsCommand, sdk.CommandOptions{
		Description: "Resume another session (replaces /resume's picker; pi --sessions opens it at startup)",
		Handler:     func(ctx sdk.Context, _ string) error { return runSessions(ctx) },
	})
}
