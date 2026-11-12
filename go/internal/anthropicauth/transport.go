package anthropicauth

import (
	"context"
	"maps"
	"net/http"
)

type FetchFunc func(*http.Request) (*http.Response, error)
type PayloadFunc func(any, map[string]any) (any, error)

// StreamOptions separates callbacks from JSON-safe provider option values.
// An adapter must forward Signal and preserve all Values without alteration.
type StreamOptions struct {
	Values    map[string]any
	Signal    context.Context
	OnPayload PayloadFunc
	Fetch     FetchFunc
}
type StreamSimple[T any] func(map[string]any, map[string]any, StreamOptions) (T, error)

// WrapStreamSimple composes the caller's onPayload first, then OAuth shaping.
// The delegate must be the RAW built-in Anthropic transport, never a registry
// lookup for the provider being overridden. One floor is shared by all calls.
func WrapStreamSimple[T any](delegate StreamSimple[T], override func() string, observer *Observer) StreamSimple[T] {
	floor := &LearnedFloor{}
	if override == nil {
		override = func() string { return "" }
	}
	return func(model, transcript map[string]any, options StreamOptions) (T, error) {
		key, _ := options.Values["apiKey"].(string)
		oauth := IsAnthropicOAuthToken(key)
		caller := options.OnPayload
		var sync *BillingVersionSync
		if oauth {
			sync = NewBillingVersionSync(floor, options.Fetch, override, observer)
		}
		onPayload := func(payload any, payloadModel map[string]any) (any, error) {
			upstream := payload
			if caller != nil {
				result, err := caller(payload, payloadModel)
				if err != nil {
					return nil, err
				}
				if result != nil {
					upstream = result
				}
			}
			if !oauth {
				return upstream, nil
			}
			sync.RecordRequest(upstream)
			version, err := ResolveClaudeCodeVersion(override())
			if err != nil {
				return nil, err
			}
			return ShapePayload(upstream, version, observer), nil
		}
		options.Values = maps.Clone(options.Values)
		options.OnPayload = onPayload
		if sync != nil {
			options.Fetch = sync.Fetch
		}
		return delegate(model, transcript, options)
	}
}
