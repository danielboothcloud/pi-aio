package browsersearch

// Progress and notices of the fetch chain. The host wiring (go/aio) puts a
// Reporter in the tool context: Notify shows a UI notification, or writes
// to the extension stderr when there is no UI. The tools add Progress,
// which turns worker progress into tool updates.

import (
	"context"
	"fmt"
	"strings"
)

// Reporter receives progress and notices for one tool call.
type Reporter struct {
	// Progress receives worker progress (start, first-use download).
	Progress func(Progress)
	// Notify shows a notice with a level ("info", "warning").
	Notify func(message, level string)
}

type reporterKey struct{}

// WithReporter returns ctx with r.
func WithReporter(ctx context.Context, r Reporter) context.Context {
	return context.WithValue(ctx, reporterKey{}, r)
}

func reporterOf(ctx context.Context) Reporter {
	r, _ := ctx.Value(reporterKey{}).(Reporter)
	return r
}

func (r Reporter) progress(p Progress) {
	if r.Progress != nil {
		r.Progress(p)
	}
}

// notify shows message through the reporter, or writes it to rt.Stderr
// when the context has none.
func (rt *Runtime) notify(ctx context.Context, message, level string) {
	if n := reporterOf(ctx).Notify; n != nil {
		n(message, level)
		return
	}
	if rt.Stderr != nil {
		fmt.Fprintf(rt.Stderr, "[browser-search] %s\n", message)
	}
}

// callNotices deduplicates the notices of one tool call by URL.
type callNotices struct {
	rt       *Runtime
	ctx      context.Context
	warned   map[string]bool
	download bool
}

// toolContext prepares ctx for one tool call: worker progress becomes tool
// updates, and the first-use browser download is announced once.
func (rt *Runtime) toolContext(ctx context.Context, onUpdate func(Update)) (context.Context, *callNotices) {
	notices := &callNotices{rt: rt, warned: map[string]bool{}}
	r := reporterOf(ctx)
	r.Progress = func(p Progress) {
		if onUpdate != nil {
			onUpdate(Update{Text: "Camoufox: " + p.Message, Details: map[string]any{"phase": "camoufox", "message": p.Message}})
		}
		if p.Download && !notices.download {
			notices.download = true
			rt.notify(notices.ctx, p.Message, "info")
		}
	}
	ctx = WithReporter(ctx, r)
	notices.ctx = ctx
	return ctx, notices
}

// result shows the fallback warning of r once per URL.
func (n *callNotices) result(r FetchResult) {
	if r.Warning == nil || n.warned[r.URL] {
		return
	}
	n.warned[r.URL] = true
	n.rt.notify(n.ctx, *r.Warning, "warning")
}

// warningLine is the warning as a result text line.
func warningLine(r FetchResult) string {
	if r.Warning == nil {
		return ""
	}
	return "> Warning: " + *r.Warning + "\n\n"
}

// chainLabel names the fetch tiers for progress updates.
func (rt *Runtime) chainLabel() string {
	tiers := []string{"Camoufox", "HTTP fallback"}
	if rt.Env.CamofoxExplicit {
		tiers = append([]string{"Camofox"}, tiers...)
	}
	return strings.Join(tiers, " → ")
}
