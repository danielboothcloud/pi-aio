import { QueueMirror, type QueuedMessage, type QueueMode } from "./mirror.js";

export interface QueueControllerDeps {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	/** Aborts the current run. In pi's TUI this also dumps the native queue into the editor. */
	abort(): void;
	clearEditor(): void;
	/** Put texts back into the editor (used when a deferred send fails to start a run). */
	restoreTextsToEditor(texts: string[]): void;
	sendUserMessage(text: string, mode: QueueMode): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
	updateWidget(): void;
}

/**
 * Owns the queue mirror and the "Enter on empty input interrupts and sends the
 * next pending message" flow.
 *
 * Why the flow looks the way it does:
 *
 * 1. `ctx.abort()` in pi's TUI is `restoreQueuedMessagesToEditor({abort})`:
 *    it clears pi's native queues into the editor, then aborts the run. We
 *    clear that dumped text from the editor ourselves.
 * 2. The popped "next" message is NOT re-sent while the aborted run is still
 *    unwinding. Racing the unwind with `sendUserMessage` is nondeterministic:
 *    queued-as-steering only drains when the post-run continuation starts
 *    another run, and when it does not the message silently coexists with the
 *    editor-restored texts and double-sends on the next Enter. Instead the
 *    send is deferred to `agent_settled`, where pi is guaranteed idle
 *    (`agent_settled` is emitted from the prompt cycle's finally, after the
 *    active-run flag is cleared), so the send becomes a direct prompt that
 *    always starts a fresh run.
 * 3. The remaining messages are NOT re-sent synchronously either: there is a
 *    real race between the abort unwinding and `sendUserMessage`'s streaming
 *    check that can turn them into direct prompts and throw "Agent is already
 *    processing". They stay mirrored (widget keeps showing them) and are
 *    flushed on the next `agent_start`, when pi is guaranteed to be streaming.
 * 4. If the deferred send fails to start a run (e.g. an auth error caught by
 *    pi, which extensions never see as a throw), `pendingNext` stays set: a
 *    later `agent_settled` retries the send, and Enter on the still-empty
 *    editor restores the orphaned messages to the editor instead of losing
 *    them — restoring exactly once, with nothing left in pi's native queue,
 *    so nothing can double-send.
 */
export class QueueController {
	readonly mirror = new QueueMirror();
	/** Messages kept mirrored but not yet re-queued natively; flushed on agent_start. */
	private requeue: QueuedMessage[] = [];
	/** The popped "next" message, until some user message is delivered. */
	private pendingNext: QueuedMessage | null = null;

	constructor(private deps: QueueControllerDeps) {}

	/** True while an interrupt flow is between abort and delivery/flush. */
	get flowBusy(): boolean {
		return this.pendingNext !== null || this.requeue.length > 0;
	}

	/** `input` event with a streaming behavior: the message is being queued natively. */
	handleQueuedInput(text: string, mode: QueueMode): void {
		this.mirror.add(text, mode);
		this.deps.updateWidget();
	}

	/** `message_start` for a user message: a queued message was delivered. */
	handleUserMessageText(text: string): void {
		if (this.pendingNext !== null) {
			if (this.pendingNext.text === text) {
				this.pendingNext = null;
			} else {
				// Some other user message got delivered first; the flow's message
				// is no longer "next" in any meaningful sense. Stop tracking it.
				this.pendingNext = null;
			}
		}
		this.mirror.removeDelivered(text);
		this.resync();
	}

	/**
	 * Drop mirror entries whenever pi reports an empty native queue — covers
	 * dequeue (alt+up), Esc restore, extension-command sends and delivery
	 * mismatches (skill/template expansion changes the queued text).
	 */
	resync(): void {
		if (this.flowBusy) return;
		if (!this.deps.hasPendingMessages() && !this.mirror.isEmpty) {
			this.mirror.clear();
		}
		this.deps.updateWidget();
	}

	/**
	 * Enter pressed with an empty editor: while the agent is busy, abort the
	 * current run and queue the next pending message for the deferred send;
	 * while idle with an orphaned flow, recover the orphans to the editor.
	 * Returns true when the key was consumed.
	 */
	onEmptySubmit(): boolean {
		if (this.deps.isIdle()) {
			if (this.flowBusy) {
				// A deferred send never started a run (e.g. it failed
				// silently). Restore the orphaned messages to the editor and
				// consume the key: the editor now holds them, so the next Enter
				// sends exactly them — once.
				this.restoreOrphans();
				return true;
			}
			this.resync();
			return false;
		}
		if (this.flowBusy) {
			// A previous interrupt is still in flight; swallow the key rather
			// than double-aborting (which would re-dump and duplicate messages).
			return true;
		}
		const next = this.mirror.removeNext();
		if (!next) {
			// Mirror miss (e.g. queue filled across a reload). Nothing we can
			// reliably identify — leave default behavior (empty submit is a no-op).
			if (!this.deps.hasPendingMessages()) this.mirror.clear();
			this.deps.updateWidget();
			return false;
		}

		this.requeue = this.mirror.entries();
		this.pendingNext = next;
		this.deps.abort();
		this.deps.clearEditor();
		// No send here: see the class doc — the send is deferred to
		// agent_settled, when pi is guaranteed idle.
		this.deps.updateWidget();
		return true;
	}

	/** Flush the deferred re-queue once a run is definitely streaming. */
	onAgentStart(): void {
		if (this.requeue.length === 0) return;
		const items = this.requeue;
		this.requeue = [];
		for (const item of items) {
			// The sendUserMessage input event re-mirrors each item; remove the
			// existing entry first so it is not duplicated.
			this.mirror.remove(item);
			this.deps.sendUserMessage(item.text, item.mode);
		}
		this.deps.updateWidget();
	}

	/**
	 * `agent_settled`: pi is idle by construction. If an interrupt flow is
	 * waiting, deliver its popped message as a direct prompt (guaranteed to
	 * start a run); otherwise restore any orphaned flow messages.
	 */
	onAgentSettled(): void {
		if (this.pendingNext !== null && this.deps.isIdle()) {
			// The deferred send: pi is idle, so this becomes a direct prompt
			// that always starts a fresh run. The input event carries no
			// streaming behavior (not re-mirrored); delivery (message_start)
			// clears pendingNext, and the run's agent_start flushes requeue.
			this.deps.sendUserMessage(this.pendingNext.text, "steer");
			return;
		}
		this.restoreOrphans();
	}

	/** Restore orphaned flow messages to the editor and clear the flow state. */
	private restoreOrphans(): void {
		const orphaned = this.requeue;
		this.requeue = [];
		const lostNext = this.pendingNext;
		this.pendingNext = null;
		if (orphaned.length > 0 || lostNext !== null) {
			const texts = this.mirror.clear().map((entry) => entry.text);
			if (lostNext !== null && !texts.includes(lostNext.text)) {
				texts.unshift(lostNext.text);
			}
			this.deps.restoreTextsToEditor(texts);
			this.deps.notify(
				"Queue interrupt did not start a run; pending messages restored to the editor",
				"warning",
			);
		}
		this.resync();
	}
}
