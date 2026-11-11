// Scratch repro for PIG-LIMITS: an extension command that calls ctx.abort()
// while the agent streams with queued steering messages.
export default function (pi: { registerCommand: (name: string, c: unknown) => void }) {
	pi.registerCommand("ui-abort", {
		description: "abort the run from an extension",
		handler: async (_args: string, ctx: { abort(): void; ui: { notify(m: string, l: string): void } }) => {
			ctx.abort();
			ctx.ui.notify("ui-abort: abort() returned", "info");
		},
	});
}
