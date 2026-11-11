package aio

// btw wiring (port of btw/index.ts). The digest, snapshot, prompt, engine,
// display rows, and command flow live in internal/btw; this file adapts
// sdk.Context to its Host, runs each question on its own goroutine, and keeps
// the above-editor card current.
//
// Not ported: AIO notification events. The "btw asking" pill rides the
// frame's top border (the footer status without the frame). The box and
// card are plain text without theme
// colors. Each question has its own abort, as in btw/index.ts: a newer
// question or a shutdown aborts the older question's provider request.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
	"github.com/danielboothcloud/pi-aio/go/internal/frame"
)

func init() {
	addRegistrar(OrderBtw, "btw", registerBtw)
}

// sdkLayout measures and fits text with the SDK's pi-tui port.
type sdkLayout struct{}

func (sdkLayout) Width(text string) int { return sdktui.VisibleWidth(text) }
func (sdkLayout) Truncate(text string, width int, ellipsis string) string {
	return sdktui.TruncateToWidth(text, width, ellipsis, false)
}
func (sdkLayout) Wrap(text string, width int) []string { return sdktui.WrapTextWithAnsi(text, width) }

// btwCard owns the above-editor card: the shown card, its 1 s repaint
// ticker (elapsed seconds and the hide countdown), and the dismiss timer.
type btwCard struct {
	mu      sync.Mutex
	ctx     sdk.Context
	card    *btw.Card
	ticker  *time.Ticker
	stop    chan struct{}
	dismiss *time.Timer
}

func (c *btwCard) paint() {
	if c.card == nil {
		return
	}
	width := c.ctx.Width()
	if width <= 0 {
		width = 80
	}
	rows := btw.CardRows(sdkLayout{}, *c.card, width, float64(time.Now().UnixMilli()))
	_ = c.ctx.SetWidget(btw.WidgetKey, rows, sdk.WidgetOptions{"placement": "aboveEditor"})
}

// stopTickerLocked ends the repaint loop. The caller holds c.mu.
func (c *btwCard) stopTickerLocked() {
	if c.ticker != nil {
		c.ticker.Stop()
		close(c.stop)
		c.ticker, c.stop = nil, nil
	}
}

func (c *btwCard) show(ctx sdk.Context, card btw.Card) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopTickerLocked()
	c.ctx, c.card = ctx, &card
	c.paint()
	ticker, stop := time.NewTicker(time.Second), make(chan struct{})
	c.ticker, c.stop = ticker, stop
	go func() {
		defer func() { _ = recover() }() // a replaced session makes ctx stale
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				c.mu.Lock()
				if c.stop == stop {
					c.paint()
				}
				c.mu.Unlock()
			}
		}
	}()
}

func (c *btwCard) clear(ctx sdk.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopTickerLocked()
	c.card = nil
	_ = ctx.SetWidget(btw.WidgetKey, nil)
}

func (c *btwCard) startTimer(ctx sdk.Context, ms float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dismiss != nil {
		c.dismiss.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		defer func() { _ = recover() }()
		c.mu.Lock()
		current := c.dismiss == timer
		if current {
			c.dismiss = nil
		}
		c.mu.Unlock()
		if current {
			c.clear(ctx)
		}
	})
	c.dismiss = timer
}

func (c *btwCard) stopTimer() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dismiss != nil {
		c.dismiss.Stop()
		c.dismiss = nil
	}
}

// btwAborts owns the abort of the question in flight (the AbortController
// of btw/index.ts). Last wins: starting a question aborts the older one.
type btwAborts struct {
	mu     sync.Mutex
	run    *btw.Run
	cancel context.CancelFunc
}

// start aborts the older question and returns the abort scope of run.
func (a *btwAborts) start(run *btw.Run) context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
	scope, cancel := context.WithCancel(context.Background())
	a.run, a.cancel = run, cancel
	return scope
}

// finish releases the scope of run when it is still the newest question.
func (a *btwAborts) finish(run *btw.Run) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.run == run {
		a.cancel()
		a.run, a.cancel = nil, nil
	}
}

// abort aborts the question in flight, if any.
func (a *btwAborts) abort() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
		a.run, a.cancel = nil, nil
	}
}

// btwHost adapts one sdk.Context to btw.Host.
type btwHost struct {
	ctx  sdk.Context
	card *btwCard
}

func (h btwHost) HasUI() bool                  { return h.ctx.HasUI() }
func (h btwHost) IsTUI() bool                  { return h.ctx.Mode() == "tui" }
func (h btwHost) Notify(message, level string) { h.ctx.Notify(message, level) }

// SetStatus is syncAsking: the frame "btw asking" pill while the frame is
// registered, else the footer status.
func (h btwHost) SetStatus(text string) {
	if frame.Probe().Supported {
		if modelID, ok := btw.AskingModelID(text); ok && text != "" {
			icon, label, role := btw.FrameAskingMeta(modelID)
			pill := &frame.Pill{Icon: icon, Label: label, Role: role}
			frame.SetMetadataContributor(btwFrameKey, func() frame.Contribution { return frame.Contribution{Btw: pill} })
		} else {
			frame.SetMetadataContributor(btwFrameKey, nil)
		}
		frame.RequestRepaint()
		if h.ctx.HasUI() {
			h.ctx.ClearStatus(btw.StatusKey)
		}
		return
	}
	frame.SetMetadataContributor(btwFrameKey, nil)
	if text == "" {
		h.ctx.ClearStatus(btw.StatusKey)
		return
	}
	h.ctx.SetStatus(btw.StatusKey, text)
}

const btwFrameKey = "btw"

func (h btwHost) ShowCard(card btw.Card)    { h.card.show(h.ctx, card) }
func (h btwHost) ClearCard()                { h.card.clear(h.ctx) }
func (h btwHost) StartCardTimer(ms float64) { h.card.startTimer(h.ctx, ms) }
func (h btwHost) StopCardTimer()            { h.card.stopTimer() }
func (h btwHost) Now() float64              { return float64(time.Now().UnixMilli()) }

func (h btwHost) AppendEntry(data btw.EntryData) error {
	return h.ctx.AppendEntry(btw.EntryType, data)
}

func registerBtw(e *sdk.Extension) {
	// Custom entries render for humans in parents and children alike.
	e.EntryRenderer(btw.EntryType, func(_ sdk.Context, entry map[string]any, _ sdk.EntryRenderOptions, width int) ([]string, error) {
		raw, err := json.Marshal(entry["data"])
		if err != nil {
			return nil, nil
		}
		var data btw.EntryData
		if json.Unmarshal(raw, &data) != nil || data.Answer == "" {
			return nil, nil
		}
		return btw.BoxRows(sdkLayout{}, data, width), nil
	})

	// Subagent children run headless: no command surface.
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	runner := btw.NewRunner(sdkLayout{}, -1)
	card := &btwCard{}
	aborts := &btwAborts{}

	e.RegisterCommand("btw", sdk.CommandOptions{
		Description: "Ask a quick side question without interrupting the agent — answered in the background by the session model (works mid-flow)",
		Handler: func(ctx sdk.Context, args string) error {
			host := btwHost{ctx, card}
			// The question stays on the model active now, as in TypeScript.
			provider, id, model := ctx.ModelProvider(), ctx.Model(), ""
			if id != "" {
				model = ctx.ModelQualified()
			}
			// ctx.Signal is set only while a run streams.
			run := runner.Command(host, args, model, ctx.Signal() != nil)
			if run == nil {
				return nil
			}
			cwd := ctx.Cwd()
			abort := aborts.start(run)
			// Return at once: the context and the call run detached.
			go func() {
				defer aborts.finish(run)
				defer func() {
					if r := recover(); r != nil {
						fmt.Fprintf(os.Stderr, "aio btw: side question stopped: %v\n", r)
					}
				}()
				runner.Ask(host, run, btw.AskInput{
					Branch: func() []json.RawMessage { return sessionBranch(ctx) },
					Cwd:    cwd,
					Complete: func(systemPrompt, prompt string) (map[string]any, error) {
						return completeWith(abort, ctx, provider, id, systemPrompt, prompt)
					},
				})
			}()
			return nil
		},
	})

	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		aborts.abort()
		runner.Shutdown(btwHost{ctx, card})
		return nil, nil
	})
}
