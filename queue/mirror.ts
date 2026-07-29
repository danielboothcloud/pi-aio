/**
 * Mirror of pi's pending message queue.
 *
 * Pi keeps two FIFO queues (steering, then follow-up) inside AgentSession but
 * does not expose their contents to extensions. We shadow them by observing
 * `input` events (additions while streaming) and `message_start` events for
 * user messages (deliveries), using the same exact-text matching AgentSession
 * uses internally.
 */

export type QueueMode = "steer" | "followUp";

export interface QueuedMessage {
	text: string;
	mode: QueueMode;
}

export class QueueMirror {
	private steering: string[] = [];
	private followUp: string[] = [];

	get size(): number {
		return this.steering.length + this.followUp.length;
	}

	get isEmpty(): boolean {
		return this.size === 0;
	}

	add(text: string, mode: QueueMode): void {
		if (mode === "steer") {
			this.steering.push(text);
		} else {
			this.followUp.push(text);
		}
	}

	/**
	 * Remove the first exact match, checking steering before follow-up — the
	 * same order AgentSession uses when a queued user message is delivered.
	 * Returns the mode the text was found in, or undefined on a miss.
	 */
	removeDelivered(text: string): QueueMode | undefined {
		const steeringIndex = this.steering.indexOf(text);
		if (steeringIndex !== -1) {
			this.steering.splice(steeringIndex, 1);
			return "steer";
		}
		const followUpIndex = this.followUp.indexOf(text);
		if (followUpIndex !== -1) {
			this.followUp.splice(followUpIndex, 1);
			return "followUp";
		}
		return undefined;
	}

	/** Remove the first exact match within the entry's own mode queue. */
	remove(entry: QueuedMessage): boolean {
		const queue = entry.mode === "steer" ? this.steering : this.followUp;
		const index = queue.indexOf(entry.text);
		if (index === -1) return false;
		queue.splice(index, 1);
		return true;
	}

	/** The message pi would deliver next: first steering, else first follow-up. */
	next(): QueuedMessage | undefined {
		const steeringText = this.steering[0];
		if (steeringText !== undefined)
			return { text: steeringText, mode: "steer" };
		const followUpText = this.followUp[0];
		if (followUpText !== undefined)
			return { text: followUpText, mode: "followUp" };
		return undefined;
	}

	removeNext(): QueuedMessage | undefined {
		const next = this.next();
		if (!next) return undefined;
		this.remove(next);
		return next;
	}

	/** Ordered entries: steering FIFO first, then follow-up FIFO. */
	entries(): QueuedMessage[] {
		return [
			...this.steering.map((text) => ({ text, mode: "steer" as const })),
			...this.followUp.map((text) => ({ text, mode: "followUp" as const })),
		];
	}

	/** Clear both queues, returning the entries that were pending. */
	clear(): QueuedMessage[] {
		const entries = this.entries();
		this.steering = [];
		this.followUp = [];
		return entries;
	}
}
