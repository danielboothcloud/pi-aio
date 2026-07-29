import { QueueMirror, type QueuedMessage, type QueueMode } from "./mirror.js";

export interface QueueControllerDeps {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	/** Aborts the current run. In pi's TUI this also dumps the native queue into the editor. */
	abort(): void;
	clearEditor(): void;
	/** Put texts back into the editor (used when an interrupt fails mid-flight). */
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
 * 2. The "next" message is re-sent immediately with deliverAs "steer". Two
 *    convergent outcomes: if the aborted run is still unwinding it is queued
 *    as steering and drained by the post-run continuation; if the run already
 *    settled it becomes a direct prompt. Either way it starts a fresh run.
 * 3. The remaining messages are NOT re-sent synchronously: there is a real
 *    race between the abort unwinding and `sendUserMessage`'s streaming check
 *    that can turn them into direct prompts and throw "Agent is already
 *    processing". They stay mirrored (widget keeps showing them) and are
 *    flushed on the next `agent_start`, when pi is guaranteed to be streaming.
 * 4. If no run ever starts (e.g. auth error), `agent_settled` restores the
 *    orphaned messages to the editor instead of losing them.
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
	 * Enter pressed with an empty editor while the agent is busy: abort the
	 * current run and push the next pending message at it. Returns true when
	 * the key was consumed.
	 */
	onEmptySubmit(): boolean {
		if (this.deps.isIdle()) {
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
		// Fires an `input` event that re-mirrors this message as steering —
		// correct, since it is pending until delivered.
		this.deps.sendUserMessage(next.text, "steer");
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

	/** If an interrupt never produced a run, restore orphans to the editor. */
	onAgentSettled(): void {
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
