package aio

// Status-line wiring (port of status-line/index.ts). The settings, the row
// renderer, and the provider usage fetcher are in go/internal/statusline.
// While the frame is registered the footer is claimed by a quiet, empty
// footer and the provider quota rides the frame's top border; without the
// frame the footer row renders the configured segments.
//
// Differences from TypeScript: the verbose working message refreshes on
// turn_start, before_provider_request, and once per second while the
// agent runs, not on every message_update (each event crosses the process
// boundary in PiG). Provider usage requests go through Go's net/http.

import (
	"context"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
	"github.com/danielboothcloud/pi-aio/go/internal/statusline"
)

func init() { addRegistrar(OrderStatusLine, "status-line", registerStatusLine) }

const providerUsageKey = "aio-provider-usage"

type statusLineState struct {
	mu              sync.Mutex
	config          statusline.Config
	loaded          *sdk.Context
	streamStart     float64
	outputAtTurn    float64
	usage           []statusline.ProviderUsage
	attemptedAt     float64
	attemptProvider string
	cancel          context.CancelFunc
	requesting      bool
	stopTicker      chan struct{}
}

func agentDirAndConfig() (string, string) {
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	return agentDir, configDir
}

func (s *statusLineState) load(ctx sdk.Context) {
	agentDir, configDir := agentDirAndConfig()
	trusted, _ := ctx.IsProjectTrusted()
	config := statusline.Load(ctx.Cwd(), statusline.LoadOptions{ExcludeProject: !trusted, AgentDir: agentDir, ConfigDirName: configDir})
	s.mu.Lock()
	s.config = config
	s.mu.Unlock()
}

// syncUsage is syncProviderUsageStatus.
func (s *statusLineState) syncUsage(ctx sdk.Context) {
	if !ctx.HasUI() {
		return
	}
	s.mu.Lock()
	usage := s.usage
	s.mu.Unlock()
	text, role, ok := statusline.UsageLine(usage, nowMillis())
	if !ok {
		ctx.ClearStatus(providerUsageKey)
		_ = ctx.SetWidget(providerUsageKey, nil)
		frame.SetMetadataContributor("quota", nil)
		return
	}
	if frame.Probe().Supported {
		frame.SetMetadataContributor("quota", func() frame.Contribution {
			return frame.Contribution{Quota: &frame.Tinted{Text: text, Role: role}}
		})
		ctx.ClearStatus(providerUsageKey)
		_ = ctx.SetWidget(providerUsageKey, nil)
		frame.RequestRepaint()
		return
	}
	ctx.SetStatus(providerUsageKey, ctx.UITheme().Fg(role, "◴ "+text))
}

func (s *statusLineState) resetUsage(ctx sdk.Context, clear bool) {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.requesting = false
	if clear {
		s.usage, s.attemptedAt, s.attemptProvider = nil, 0, ""
	}
	s.mu.Unlock()
	if clear {
		s.syncUsage(ctx)
	}
}

func (s *statusLineState) shouldFetch(ctx sdk.Context) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ctx.Mode() == "tui" && s.config.Enabled && s.config.HasSegment("quota")
}

var usageHTTP = &http.Client{}

func usageRequest(ctx context.Context, method, url string, headers map[string]string) (statusline.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return statusline.Response{}, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := usageHTTP.Do(req)
	if err != nil {
		return statusline.Response{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return statusline.Response{Status: resp.StatusCode, Body: body}, err
}

// refreshUsage is refreshProviderUsage. It runs the request on a goroutine
// with the long-lived context.
func (s *statusLineState) refreshUsage(ctx sdk.Context, force bool) {
	provider := ctx.ModelProvider()
	s.mu.Lock()
	cfg := s.config.ProviderUsage
	var endpoint statusline.EndpointConfig
	found := false
	if cfg != nil && provider != "" {
		endpoint, found = cfg.Providers[provider]
	}
	if !found {
		s.usage, s.attemptedAt, s.attemptProvider = nil, 0, ""
		s.mu.Unlock()
		s.syncUsage(ctx)
		return
	}
	if s.requesting {
		s.mu.Unlock()
		return
	}
	interval := cfg.RefreshIntervalMs
	if endpoint.RefreshIntervalMs != nil {
		interval = *endpoint.RefreshIntervalMs
	}
	if !force && s.attemptProvider == provider && nowMillis()-s.attemptedAt < interval {
		s.mu.Unlock()
		return
	}
	s.attemptProvider = provider
	if s.cancel != nil {
		s.cancel()
	}
	reqCtx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.requesting = true
	timeout := cfg.TimeoutMs
	loaded := s.loaded
	s.mu.Unlock()
	agentDir, _ := agentDirAndConfig()
	go func() {
		usage, err := statusline.FetchProviderUsage(reqCtx, provider, endpoint, timeout, statusline.FetchDeps{
			Request:      usageRequest,
			Getenv:       os.LookupEnv,
			ResolveToken: func(account string) string { return statusline.ReadPiOAuthToken(account, agentDir) },
		})
		s.mu.Lock()
		owner := s.cancel != nil && reqCtx.Err() == nil
		if owner {
			s.cancel, s.requesting = nil, false
		}
		aborted := reqCtx.Err() != nil
		s.attemptedAt = nowMillis()
		s.mu.Unlock()
		cancel()
		if err != nil || aborted || loaded == nil || loaded.ModelProvider() != provider {
			return
		}
		s.mu.Lock()
		s.usage = usage
		s.mu.Unlock()
		s.syncUsage(*loaded)
	}()
}

// applyWorkingMessage is applyWorkingMessage.
func (s *statusLineState) applyWorkingMessage(ctx sdk.Context) {
	if frame.Probe().Active || !ctx.HasUI() {
		return
	}
	s.mu.Lock()
	mode, start, outAtTurn := s.config.WorkingMessage, s.streamStart, s.outputAtTurn
	s.mu.Unlock()
	if mode == "off" || start == 0 {
		ctx.ClearWorkingMessage()
		return
	}
	stats := statusline.ComputeUsageStats(sessionBranchEntries(ctx))
	elapsed := math.Max(0.001, (nowMillis()-start)/1000)
	message, ok := statusline.FormatWorkingMessage(mode, statusline.WorkingStats{
		UsageStats:     stats,
		ContextPercent: contextPercent(ctx),
		ElapsedSec:     elapsed,
		TPS:            math.Max(0, stats.Output-outAtTurn) / elapsed,
	})
	if !ok {
		ctx.ClearWorkingMessage()
		return
	}
	ctx.SetWorkingMessage(message)
}

func sessionBranchEntries(ctx sdk.Context) []map[string]any {
	entries, err := ctx.SessionManager().GetBranch(nil)
	if err != nil {
		return nil
	}
	return entries
}

func contextPercent(ctx sdk.Context) int {
	usage, err := ctx.GetContextUsage()
	if err != nil || usage == nil {
		return 0
	}
	var tokens *float64
	if usage.Tokens != nil {
		t := float64(*usage.Tokens)
		tokens = &t
	}
	window := float64(usage.ContextWindow)
	return statusline.ContextPercent(tokens, &window)
}

// installFooter is installFooter.
func (s *statusLineState) installFooter(ctx sdk.Context) {
	if !ctx.HasUI() {
		return
	}
	if frame.Probe().Supported {
		// The frame embeds every session stat; a quiet footer keeps the
		// host's own footer from duplicating it.
		_ = ctx.SetFooterRenderer(func(int) []string { return []string{} })
		return
	}
	s.mu.Lock()
	enabled := s.config.Enabled
	s.mu.Unlock()
	if !enabled {
		_ = ctx.SetFooterRenderer(nil)
		return
	}
	loaded := s.loaded
	if loaded == nil {
		return
	}
	home := os.Getenv("HOME")
	_ = ctx.SetFooterRenderer(func(width int) []string {
		footer := loaded.FooterData()
		statuses := footer.ExtensionStatuses()
		keys := make([]string, 0, len(statuses))
		for k := range statuses {
			keys = append(keys, k)
		}
		sortStrings(keys)
		list := make([]statusline.Status, len(keys))
		for i, k := range keys {
			list[i] = statusline.Status{Key: k, Value: statuses[k]}
		}
		branch, _ := footer.GitBranch()
		mode := pm.ModeDefault
		if modesAccess != nil {
			modesAccess.mu.Lock()
			mode = modesAccess.mode
			modesAccess.mu.Unlock()
		}
		meta := pm.ModeMetadata(mode)
		var model *statusline.Model
		if id := loaded.Model(); id != "" {
			model = &statusline.Model{Provider: loaded.ModelProvider(), ID: id}
		}
		s.mu.Lock()
		config, usage := s.config, s.usage
		s.mu.Unlock()
		return statusline.Render(statusline.RenderInput{
			Width: width, Theme: loaded.UITheme(), Config: config, Cwd: loaded.Cwd(), Model: model,
			Mode:      statusline.ModeMeta{Icon: meta.Icon, Label: meta.Label, Role: meta.Role},
			GitBranch: branch, ContextPercent: contextPercent(*loaded), Statuses: list,
			Usage: statusline.ComputeUsageStats(sessionBranchEntries(*loaded)), ProviderUsage: usage, Home: home, Now: nowMillis(),
		})
	})
}

func sortStrings(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j] < list[j-1]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

func (s *statusLineState) startTicker(ctx sdk.Context) {
	s.mu.Lock()
	if s.stopTicker != nil {
		close(s.stopTicker)
	}
	stop := make(chan struct{})
	s.stopTicker = stop
	verbose := s.config.WorkingMessage == "verbose"
	loaded := s.loaded
	s.mu.Unlock()
	if !verbose || loaded == nil || frame.Probe().Active {
		return
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				s.applyWorkingMessage(*loaded)
			}
		}
	}()
}

func (s *statusLineState) stopTickerNow() {
	s.mu.Lock()
	if s.stopTicker != nil {
		close(s.stopTicker)
		s.stopTicker = nil
	}
	s.mu.Unlock()
}

func registerStatusLine(e *sdk.Extension) {
	s := &statusLineState{config: statusline.DefaultConfig()}
	e.OnLoaded(func(ctx sdk.Context) { s.loaded = &ctx })

	setEnabled := func(ctx sdk.Context, enabled bool) {
		s.mu.Lock()
		s.config.Enabled = enabled
		s.mu.Unlock()
		s.installFooter(ctx)
		if enabled && s.shouldFetch(ctx) {
			s.refreshUsage(ctx, true)
		} else if !enabled {
			s.resetUsage(ctx, true)
		}
		owner := ""
		if frame.Probe().Supported {
			owner = " data (frame owns the visuals)"
		}
		state := "disabled"
		if enabled {
			state = "enabled"
		}
		ctx.Notify("Status line"+owner+" "+state, "info")
	}
	setWorking := func(ctx sdk.Context, mode string) {
		s.mu.Lock()
		s.config.WorkingMessage = mode
		s.mu.Unlock()
		s.applyWorkingMessage(ctx)
		ctx.Notify("Status line working message: "+mode, "info")
	}
	e.RegisterCommand("status-line", sdk.CommandOptions{
		Description: "Toggle or configure aio status line (on|off|minimal|verbose)",
		Handler: func(ctx sdk.Context, args string) error {
			if !ctx.HasUI() {
				ctx.Notify("Status line requires TUI mode", "warning")
				return nil
			}
			switch strings.ToLower(strings.TrimSpace(args)) {
			case "", "toggle":
				s.mu.Lock()
				enabled := s.config.Enabled
				s.mu.Unlock()
				setEnabled(ctx, !enabled)
			case "on", "enable":
				setEnabled(ctx, true)
			case "off", "disable":
				setEnabled(ctx, false)
			case "minimal", "verbose":
				setWorking(ctx, strings.ToLower(strings.TrimSpace(args)))
			default:
				ctx.Notify("Usage: /status-line [on|off|minimal|verbose]", "warning")
			}
			return nil
		},
	})

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.load(ctx)
		s.installFooter(ctx)
		if s.shouldFetch(ctx) {
			s.refreshUsage(ctx, true)
		}
		return nil, nil
	})
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.load(ctx)
		s.resetUsage(ctx, true)
		s.installFooter(ctx)
		if s.shouldFetch(ctx) {
			s.refreshUsage(ctx, true)
		}
		return nil, nil
	})
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.HasUI() {
			ctx.ClearStatus(providerUsageKey)
			_ = ctx.SetWidget(providerUsageKey, nil)
		}
		s.stopTickerNow()
		s.resetUsage(ctx, false)
		return nil, nil
	})
	e.OnEvent("model_select", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.resetUsage(ctx, true)
		if s.shouldFetch(ctx) {
			s.refreshUsage(ctx, true)
		}
		return nil, nil
	})
	e.OnEvent("turn_start", func(ctx sdk.Context, _ map[string]any) (any, error) {
		output := 0.0
		if !frame.Probe().Active {
			// Only the working message reads the output tokens; with the
			// frame active it is never shown, so skip the branch read.
			output = statusline.ComputeUsageStats(sessionBranchEntries(ctx)).Output
		}
		s.mu.Lock()
		s.streamStart, s.outputAtTurn = nowMillis(), output
		s.mu.Unlock()
		s.applyWorkingMessage(ctx)
		s.startTicker(ctx)
		if s.shouldFetch(ctx) {
			s.refreshUsage(ctx, false)
		}
		return nil, nil
	})
	e.OnEvent("before_provider_request", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.applyWorkingMessage(ctx)
		return nil, nil
	})
	e.OnEvent("agent_end", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		s.streamStart = 0
		s.mu.Unlock()
		s.stopTickerNow()
		if ctx.HasUI() && !frame.Probe().Active {
			ctx.ClearWorkingMessage()
		}
		if s.shouldFetch(ctx) {
			s.refreshUsage(ctx, false)
		}
		return nil, nil
	})
}
