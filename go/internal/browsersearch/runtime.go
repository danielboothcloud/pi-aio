package browsersearch

// Shared runtime: the injected HTTP client, resolver, clock, and sleeps,
// plus the fetch() error texts that the TypeScript adapters surface.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Runtime holds the injected backends. The zero value is not usable; use
// NewRuntime or fill every field.
type Runtime struct {
	Env      Env
	Getenv   LookupEnv
	HTTP     *http.Client
	Resolver Resolver
	Now      func() time.Time
	// Sleep is abort.ts sleep: wait ms or fail when ctx ends.
	Sleep func(ctx context.Context, ms int) error
	// RunRestart runs the Camofox restart command (exec in a shell).
	RunRestart func(ctx context.Context, command string) error
	Stderr     io.Writer
	Cloak      CloakDeps
	// ReadabilitySource is the in-page Readability.js source.
	ReadabilitySource string
}

// NewRuntime returns the production runtime for env.
func NewRuntime(env Env) *Runtime {
	return &Runtime{
		Env:               env,
		Getenv:            os.LookupEnv,
		HTTP:              &http.Client{},
		Resolver:          NetResolver{},
		Now:               time.Now,
		Sleep:             Sleep,
		Stderr:            os.Stderr,
		ReadabilitySource: ReadabilitySource,
	}
}

// Error is a named JavaScript error (SearxngError, ExaError, CamofoxError,
// TypeError). Status is the HTTP status when one caused it.
type Error struct {
	Name    string
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

// ErrAborted is the AbortError a cancelled signal throws.
var ErrAborted = errors.New("This operation was aborted")

// aborted is throwIfAborted.
func aborted(ctx context.Context) error {
	if ctx.Err() != nil {
		return ErrAborted
	}
	return nil
}

// Sleep is abort.ts sleep.
func Sleep(ctx context.Context, ms int) error {
	if err := aborted(ctx); err != nil {
		return err
	}
	t := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ErrAborted
	}
}

// response is a fetch() Response with its body read.
type response struct {
	status     int
	statusText string
	body       []byte
}

func (r response) ok() bool { return r.status >= 200 && r.status < 300 }

type fetchPhase int

const (
	phaseNone fetchPhase = iota
	phaseFetch
	phaseBody
)

// fetchFailure says where a fetch failed: the request (fetch rejected) or
// the body read, and whether the request deadline caused it.
type fetchFailure struct {
	phase    fetchPhase
	timedOut bool
	message  string
}

func (f *fetchFailure) Error() string { return f.message }

// doFetch performs one request with a deadline of timeoutMs over ctx. A
// cancelled ctx gives ErrAborted; other failures are *fetchFailure with
// Node's fetch texts ("Failed to parse URL from …", "fetch failed").
func (rt *Runtime) doFetch(ctx context.Context, method, target string, headers map[string]string, body []byte, timeoutMs int) (response, error) {
	if err := aborted(ctx); err != nil {
		return response{}, err
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return response{}, &fetchFailure{phase: phaseFetch, message: "Failed to parse URL from " + target}
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, target, reader)
	if err != nil {
		return response{}, &fetchFailure{phase: phaseFetch, message: "Failed to parse URL from " + target}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := rt.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return response{}, ErrAborted
		}
		return response{}, &fetchFailure{phase: phaseFetch, timedOut: reqCtx.Err() != nil, message: "fetch failed"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		if ctx.Err() != nil {
			return response{}, ErrAborted
		}
		return response{}, &fetchFailure{phase: phaseBody, timedOut: reqCtx.Err() != nil, message: "terminated"}
	}
	text := res.Status
	if i := strings.IndexByte(text, ' '); i >= 0 {
		text = text[i+1:]
	} else {
		text = ""
	}
	return response{status: res.StatusCode, statusText: text, body: data}, nil
}
