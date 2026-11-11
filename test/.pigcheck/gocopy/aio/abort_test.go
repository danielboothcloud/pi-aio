package aio

import (
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
)

// A newer /btw aborts the older question's request, and shutdown aborts the
// question in flight (btw/index.ts: active.abort.abort()).
func TestBtwAbortsLastWinsAndShutdown(t *testing.T) {
	var aborts btwAborts
	first, second := &btw.Run{Seq: 1}, &btw.Run{Seq: 2}
	firstCtx := aborts.start(first)
	if firstCtx.Err() != nil {
		t.Fatal("a new question starts aborted")
	}
	secondCtx := aborts.start(second)
	if firstCtx.Err() == nil {
		t.Fatal("a newer question did not abort the older request")
	}
	aborts.finish(first) // the replaced run ends late
	if secondCtx.Err() != nil {
		t.Fatal("the replaced run's finish aborted the newer question")
	}
	aborts.abort()
	if secondCtx.Err() == nil {
		t.Fatal("shutdown did not abort the question in flight")
	}
	aborts.abort() // idempotent with nothing in flight
}

// A finished question releases its scope, so a later shutdown has nothing to abort.
func TestBtwAbortsFinishReleasesTheScope(t *testing.T) {
	var aborts btwAborts
	run := &btw.Run{Seq: 1}
	ctx := aborts.start(run)
	aborts.finish(run)
	if ctx.Err() == nil {
		t.Fatal("finish did not release the scope")
	}
	if aborts.cancel != nil || aborts.run != nil {
		t.Fatal("finish kept the finished run")
	}
}

// A new session or shutdown (reset) aborts the title request in flight, and a
// request for a voided generation never starts (session-naming/index.ts).
func TestNamingResetAbortsTheTitleRequest(t *testing.T) {
	var s namingState
	ctx, done := s.begin(0)
	if ctx == nil || ctx.Err() != nil {
		t.Fatal("the current generation did not start a request")
	}
	if _, ok := ctx.Deadline(); !ok {
		t.Fatal("the title request has no timeout")
	}
	s.reset()
	if ctx.Err() == nil {
		t.Fatal("reset did not abort the title request")
	}
	done() // the aborted request ends after the reset
	if stale, _ := s.begin(0); stale != nil {
		t.Fatal("a voided generation started a request")
	}
	next, nextDone := s.begin(1)
	if next == nil {
		t.Fatal("the new generation did not start a request")
	}
	nextDone()
	if next.Err() == nil || s.cancel != nil {
		t.Fatal("a finished request kept its scope")
	}
}
