// Package driver is a hermetic integration fixture, never an installed extension.
package driver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func Extension() *sdk.Extension {
	e := sdk.New("driver")
	var once sync.Once
	var state map[string]any
	e.OnSessionStart(func(c sdk.Context, _ map[string]any) (any, error) {
		models, err := c.ModelRegistry().GetAll()
		if err != nil {
			return nil, err
		}
		auth, err := c.ModelRegistry().GetProviderAuthStatus("anthropic")
		if err != nil {
			return nil, err
		}
		state = map[string]any{"models": models, "auth": auth}
		return nil, save(state)
	})
	e.OnEvent("agent_end", func(c sdk.Context, _ map[string]any) (any, error) {
		var runErr error
		once.Do(func() {
			if os.Getenv("AIO_AUTH_AUX") == "" {
				return
			}
			results := []any{}
			for _, provider := range strings.Split(os.Getenv("AIO_AUTH_AUX"), ",") {
				model, err := c.ModelRegistry().Find(provider, "auth-fixture")
				if err != nil || model == nil {
					runErr = fmt.Errorf("find %s: %v", provider, err)
					return
				}
				order := []string{}
				options := map[string]any{"maxTokens": 32, "temperature": 0.2, "headers": map[string]string{"X-Caller-Option": "retained"}}
				if os.Getenv("AIO_AUTH_CALLBACKS") != "" {
					options["onPayload"] = sdk.OnPayloadFunc(func(p any, _ map[string]any) (any, error) {
						order = append(order, "payload")
						payload := p.(map[string]any)
						// A replacement must be shaped AFTER this callback, not before it.
						copy := map[string]any{}
						for k, v := range payload {
							copy[k] = v
						}
						copy["system"] = []any{map[string]any{"type": "text", "text": "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.\n\n<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\nCALLER_DOCS_REMOVE\n</docs>"}}
						copy["messages"] = []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "caller replacement text abcdefghijklmnopqrstuvwxyz"}}}}
						return copy, nil
					})
					options["fetch"] = sdk.ModelFetchFunc(func(r *http.Request) (*http.Response, error) {
						order = append(order, "fetch")
						r.Header.Set("X-Caller-Fetch", "retained")
						return http.DefaultClient.Do(r)
					})
					options["onResponse"] = sdk.OnResponseFunc(func(r, _ map[string]any) error { order = append(order, "response"); return nil })
				}
				result := c.ModelRegistry().CompleteContext(context.Background(), model, map[string]any{"systemPrompt": "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.\n\n<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\nAUX_DOCS_REMOVE\n</docs>", "messages": []any{map[string]any{"role": "user", "content": "auxiliary abcdefghijklmnopqrstuvwxyz", "timestamp": 1}}}, options)
				if result == nil {
					runErr = fmt.Errorf("auxiliary completion for %s returned no message", provider)
					return
				}
				results = append(results, map[string]any{"provider": provider, "result": result, "order": order})
			}
			state["aux"] = results
			if runErr == nil {
				runErr = save(state)
			}
		})
		return nil, runErr
	})
	return e
}
func save(state map[string]any) error {
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return os.WriteFile(os.Getenv("AIO_AUTH_RESULT"), b, 0600)
}
