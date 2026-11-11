package aio

// /init wiring (port of init/index.ts).

import (
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/initcmd"
)

func init() { addRegistrar(OrderInit, "init", registerInit) }

func registerInit(e *sdk.Extension) {
	e.Command("init", "Analyze the codebase and create or update AGENTS.md (optional: force, dry-run)", func(ctx sdk.Context, args string) error {
		prompt := initcmd.BuildPrompt(ctx.Cwd(), args)
		if idle, err := ctx.IsIdle(); err == nil && !idle {
			if err := ctx.SendUserMessage(prompt, "followUp"); err != nil {
				return err
			}
			ctx.Notify("Queued /init for after the current turn", "info")
			return nil
		}
		return ctx.SendUserMessage(prompt, "")
	})
}
