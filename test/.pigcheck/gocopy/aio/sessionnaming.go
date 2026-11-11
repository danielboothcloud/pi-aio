package aio

// Session naming wiring (port of session-naming/index.ts). The title
// request runs after agent_end returns, so it uses the long-lived context
// from OnLoaded; a request-scoped context ends with its handler. As in
// TypeScript, the request has its own abort: a timeout, a new session, or a
// shutdown aborts the provider request (ModelRegistry.StreamSimpleContext).

import (
	"context"
	"os"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/sessionnaming"
)

func init() { addRegistrar(OrderSessionNaming, "session-naming", registerSessionNaming) }

// namingTimeout bounds the title request.
const namingTimeout = 20 * time.Second

type namingState struct {
	mu         sync.Mutex
	eligible   bool
	generation int
	loaded     *sdk.Context
	// cancel aborts the title request in flight; nil when none runs.
	cancel context.CancelFunc
}

// reset voids the current generation and aborts its title request.
func (s *namingState) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eligible = false
	s.generation++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

// begin starts the abort scope of one title request. It returns nil when a
// newer session already voided generation.
func (s *namingState) begin(generation int) (context.Context, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != generation {
		return nil, nil
	}
	if s.cancel != nil {
		s.cancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), namingTimeout)
	s.cancel = cancel
	return ctx, func() {
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.generation == generation {
			s.cancel = nil
		}
	}
}

func (s *namingState) name(prompt, provider, modelID, sessionID string, generation int) {
	ctx := s.loaded
	if ctx == nil {
		return
	}
	current := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.generation == generation
	}
	model, err := ctx.ModelRegistry().Find(provider, modelID)
	if err != nil || model == nil {
		return
	}
	callCtx, done := s.begin(generation)
	if callCtx == nil {
		return
	}
	defer done()
	response := ctx.ModelRegistry().StreamSimple(model, map[string]any{
		"systemPrompt": sessionnaming.SystemPrompt,
		"messages":     []any{map[string]any{"role": "user", "content": prompt, "timestamp": time.Now().UnixMilli()}},
	}, map[string]any{"maxTokens": 128}).Result()
	id, err := ctx.SessionManager().GetSessionID()
	if response == nil || !current() || err != nil || id != sessionID || ctx.SessionName() != "" || response["stopReason"] != "stop" {
		return
	}
	response["role"] = "assistant"
	if title := sessionnaming.CleanTitle(sessionnaming.MessageText(response)); title != "" {
		_ = ctx.SetSessionName(title)
	}
}

func registerSessionNaming(e *sdk.Extension) {
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	s := &namingState{}
	e.OnLoaded(func(ctx sdk.Context) { s.loaded = &ctx })
	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		s.reset()
		reason, _ := data["reason"].(string)
		header, _ := ctx.SessionManager().GetHeader()
		entries, _ := ctx.SessionManager().GetEntries()
		eligible := sessionnaming.Eligible(reason, ctx.SessionName() != "", header, entries)
		s.mu.Lock()
		s.eligible = eligible
		s.mu.Unlock()
		return nil, nil
	})
	e.OnEvent("agent_end", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		eligible, generation := s.eligible, s.generation
		s.mu.Unlock()
		provider, modelID := ctx.ModelProvider(), ctx.Model()
		if !eligible || provider == "" || modelID == "" || ctx.SessionName() != "" {
			return nil, nil
		}
		var messages []map[string]any
		for _, entry := range branchEntries(ctx) {
			if m, ok := entry["message"].(map[string]any); ok && entry["type"] == "message" {
				messages = append(messages, m)
			}
		}
		prompt, ok := sessionnaming.Prompt(messages)
		if !ok {
			return nil, nil
		}
		s.mu.Lock()
		s.eligible = false
		s.mu.Unlock()
		sessionID, err := ctx.SessionManager().GetSessionID()
		if err != nil {
			return nil, nil
		}
		// Owned background work: a new session or shutdown aborts the
		// request and the generation check voids a late result; the
		// timeout aborts a request that never answers.
		go s.name(prompt, provider, modelID, sessionID, generation)
		return nil, nil
	})
	e.OnSessionShutdown(func(sdk.Context, map[string]any) (any, error) {
		s.reset()
		return nil, nil
	})
}
