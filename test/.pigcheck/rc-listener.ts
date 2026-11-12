// Scratch listener for the recipes/notifications pig check: appends every
// AIO notification protocol event (aio:notification*) to RC_EVENTS_LOG.
import { appendFileSync } from "node:fs";

export default function (pi: { events: { on: (name: string, fn: (data: unknown) => void) => void } }) {
	const log = process.env.RC_EVENTS_LOG;
	if (!log) return;
	for (const name of ["aio:notification", "aio:notification:goal-activity", "aio:notification:agent-prompt"]) {
		pi.events.on(name, (data) => appendFileSync(log, `${JSON.stringify({ name, data })}\n`));
	}
}
