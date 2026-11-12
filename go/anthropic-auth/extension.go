// Package anthropicauth ports @gotgenes/pi-anthropic-auth without a Node runtime.
package anthropicauth

import (
	"context"
	"fmt"
	"maps"
	"os"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	core "github.com/danielboothcloud/pi-aio/go/internal/anthropicauth"
)

// requestContext exposes the SDK request lifetime without a detached cancellation goroutine.
type requestContext struct{ sdk.Context }

func (requestContext) Deadline() (time.Time, bool) { return time.Time{}, false }
func (requestContext) Value(any) any               { return nil }

type preparedRequest struct {
	model, transcript map[string]any
	options           core.StreamOptions
}

// Extension is the independent anthropic-auth factory. The host retains ownership of login, refresh and the model catalog.
func Extension() *sdk.Extension {
	e := sdk.New("anthropic-auth")
	observer := &core.Observer{DebugMode: os.Getenv("PI_ANTHROPIC_AUTH_DEBUG"), Emit: func(line string) { fmt.Fprintln(os.Stderr, line) }}
	// The wrapper owns one learned version floor across every request and provider. Raw SDK delegates are bound to the individual request's context, not to a factory or session-start context.
	prepare := core.WrapStreamSimple(func(model, transcript map[string]any, options core.StreamOptions) (preparedRequest, error) {
		return preparedRequest{model, transcript, options}, nil
	}, func() string { return os.Getenv("PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION") }, observer)
	stream := sdk.ProviderStreamSimpleFunc(func(c sdk.Context, model, transcript, values map[string]any) (*sdk.ModelEventStream, error) {
		options := core.StreamOptions{Values: values, Signal: requestContext{c}}
		switch callback := values["onPayload"].(type) {
		case sdk.OnPayloadFunc:
			options.OnPayload = core.PayloadFunc(callback)
		case func(any, map[string]any) (any, error):
			options.OnPayload = callback
		}
		switch fetch := values["fetch"].(type) {
		case sdk.ModelFetchFunc:
			options.Fetch = core.FetchFunc(fetch)
		case core.FetchFunc:
			options.Fetch = fetch
		}
		p, err := prepare(model, transcript, options)
		if err != nil {
			return nil, err
		}
		out := sdk.ProviderStreamOptions{Values: maps.Clone(p.options.Values), Signal: p.options.Signal, OnPayload: sdk.OnPayloadFunc(p.options.OnPayload)}
		if p.options.Fetch != nil {
			out.Values["fetch"] = sdk.ModelFetchFunc(p.options.Fetch)
		}
		// Preserve opaque options as well as callbacks; the raw bridge owns their serialization and support checks.
		switch callback := values["onResponse"].(type) {
		case sdk.OnResponseFunc:
			out.OnResponse = callback
		case func(map[string]any, map[string]any) error:
			out.OnResponse = callback
		}
		return sdk.AnthropicMessagesAPI(c).StreamSimple(p.model, p.transcript, out)
	})
	register := func(name string) error {
		e.RegisterProvider(name, sdk.ProviderConfig{"api": "anthropic-messages", "streamSimple": stream})
		return nil
	}
	e.UnregisterProvider("anthropic")
	_ = register("anthropic")
	extra := &core.ExtraProviders{}
	agentDir, err := sdk.AgentDir()
	if err != nil {
		panic(fmt.Errorf("pi-anthropic-auth agent directory: %w", err))
	}
	if err := extra.Apply(core.LoadConfig(core.GlobalConfigPath(agentDir)), "global", register); err != nil {
		panic(err)
	}
	e.OnSessionStart(func(c sdk.Context, _ map[string]any) (any, error) {
		trusted, err := c.IsProjectTrusted()
		if err != nil {
			return nil, err
		}
		if err := extra.ApplyProject(trusted, c.Cwd(), core.LoadConfig, register); err != nil {
			return nil, err
		}
		for _, warning := range extra.Warnings() {
			report(c, "[pi-anthropic-auth] "+warning, "warning")
		}
		return nil, nil
	})
	e.RegisterCommand("anthropic-auth:status", sdk.CommandOptions{
		Description: "Show pi-anthropic-auth diagnostics and subscription (--account adds email and organization).",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			var items []sdk.AutocompleteItem
			for _, item := range core.StatusArgumentCompletions(prefix) {
				items = append(items, sdk.AutocompleteItem{Value: item.Value, Label: item.Label, Description: item.Description})
			}
			return items, nil
		},
		Handler: func(c sdk.Context, args string) error {
			modulePath := "(source provenance unavailable)"
			if source, ok := c.ExtensionSourceInfo(); ok {
				modulePath = source.Path
			}
			d := core.Diagnostics{Version: "3.4.4", ModulePath: modulePath, TransportResolved: true, ShapedProviders: extra.ShapedProviders(), ConfigWarnings: extra.Warnings()}
			accounts, err := core.CollectAccounts(requestContext{c}, d, args, func(ctx context.Context, provider string) (core.AccountLookup, error) {
				return core.LookupProviderAccount(ctx, provider, func(provider string) (string, error) {
					key := c.ModelRegistry().GetApiKeyForProvider(provider)
					if key == nil {
						return "", nil
					}
					return *key, nil
				}, nil)
			})
			if err != nil {
				return err
			}
			report(c, core.FormatDiagnosticsReport(d, accounts), "info")
			return nil
		},
	})
	return e
}

// Pi writes reports to stderr without a UI. PiG's subprocess stderr visibility is subject to D56; never put diagnostics or tokens on protocol stdout.
func report(c sdk.Context, text, level string) {
	if c.HasUI() {
		c.Notify(text, level)
	} else {
		fmt.Fprintln(os.Stderr, text)
	}
}
