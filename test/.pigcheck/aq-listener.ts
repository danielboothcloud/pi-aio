// Scratch listener for the ask-user-question pig check: appends every
// rpiv:ask-user:prompt and aio:notification:agent-prompt event to
// AQ_EVENTS_LOG, to show the Go extension's events on the shared bus.
import { appendFileSync } from "node:fs";

export default function (pi: { events: { on: (channel: string, fn: (data: unknown) => void) => void } }) {
	for (const channel of ["rpiv:ask-user:prompt", "aio:notification:agent-prompt"]) {
		pi.events.on(channel, (data) => appendFileSync(process.env.AQ_EVENTS_LOG ?? "/dev/null", `${JSON.stringify({ channel, data })}\n`));
	}
}
