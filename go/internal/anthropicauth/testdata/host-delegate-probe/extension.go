package delegateprobe

import (
	"fmt"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	"os"
)

func Extension() *sdk.Extension {
	e := sdk.New("host-delegate-probe")
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		p, err := ctx.ModelRegistry().GetProvider("anthropic")
		result := fmt.Sprintf("provider_nil=%v error=%v\n", p == nil, err)
		if writeErr := os.WriteFile(os.Getenv("ANTHROPIC_AUTH_PROBE_FILE"), []byte(result), 0600); writeErr != nil {
			return nil, writeErr
		}
		return nil, nil
	})
	return e
}
