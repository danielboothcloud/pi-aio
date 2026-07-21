export type NotifyType = "info" | "warning" | "error";

export interface NotifyContext {
	mode: string;
	hasUI: boolean;
	ui?: { notify(message: string, type?: NotifyType): void };
}

export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI && ctx.ui) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}
