import assert from "node:assert/strict";
import test from "node:test";
import {
	ExtensionSelectorComponent, initTheme, SessionSelectorComponent, TreeSelectorComponent,
	UserMessageSelectorComponent, type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { hostMenuComponents, installMenuFrames } from "./menus.ts";

const theme = { fg: (_role: string, text: string) => text };

function menuClass() {
	return class NativeMenu {
		calls: number[] = [];
		mouseEvents: Array<{ x: number; y: number; width: number; height: number }> = [];
		render(width: number): string[] {
			this.calls.push(width);
			return ["─".repeat(width), `${CURSOR_MARKER}界`, "─".repeat(width), "Enter select", "─".repeat(width)];
		}
		handleMouse(event: { x: number; y: number; width: number; height: number }) {
			this.mouseEvents.push(event);
			return { handled: true, focus: true };
		}
	};
}

const event = { type: "click", x: 4, y: 1, width: 40, height: 5, screenX: 20, screenY: 10 };

test("native menu rules are replaced without adding rows or losing cursors", (t) => {
	const Menu = menuClass();
	t.after(installMenuFrames([Menu, Menu, undefined], () => theme));
	const menu = new Menu();
	const lines = menu.render(40);
	assert.equal(lines.length, 5);
	assert.match(lines[0]!, /^╭─+╮$/);
	assert.match(lines[2]!, /^├─+┤$/);
	assert.match(lines.at(-1)!, /^╰─+╯$/);
	assert.ok(lines[1]!.includes(CURSOR_MARKER));
	assert.deepEqual(menu.calls, [36]);
	for (const line of lines) assert.equal(visibleWidth(line), 40);
});

test("mouse coordinates use the native inner layout and border clicks are ignored", (t) => {
	const Menu = menuClass();
	t.after(installMenuFrames([Menu], () => theme));
	const menu = new Menu();
	menu.render(40);
	assert.deepEqual(menu.handleMouse(event), { handled: true, focus: true });
	assert.deepEqual(menu.mouseEvents[0], { ...event, x: 2, width: 36 });
	assert.equal(menu.handleMouse({ ...event, x: 0 }), undefined);
	assert.equal(menu.handleMouse({ ...event, y: 0 }), undefined);
	assert.equal(menu.handleMouse({ ...event, y: 4 }), undefined);
	assert.equal(menu.mouseEvents.length, 1);
});

test("narrow renders fall through and clear stale mouse transforms", (t) => {
	const Menu = menuClass();
	t.after(installMenuFrames([Menu], () => theme));
	const menu = new Menu();
	menu.render(40);
	menu.render(4);
	menu.handleMouse({ ...event, width: 4 });
	assert.deepEqual(menu.calls, [36, 4]);
	assert.equal(menu.mouseEvents[0]?.x, event.x);
});

test("unknown or already-framed layouts preserve their native width", (t) => {
	class OtherMenu {
		calls: number[] = [];
		render(width: number) { this.calls.push(width); return [`╭${"─".repeat(width - 2)}╮`, "native"]; }
	}
	t.after(installMenuFrames([OtherMenu], () => theme));
	const menu = new OtherMenu();
	assert.equal(visibleWidth(menu.render(40)[0]!), 40);
	assert.deepEqual(menu.calls, [36, 40]);
});

test("leading spacers retain row indices for mouse dispatch", (t) => {
	const Parent = menuClass();
	class Menu extends Parent {
		render(width: number) { return ["", ...super.render(width)]; }
	}
	t.after(installMenuFrames([Menu], () => theme));
	const menu = new Menu();
	const lines = menu.render(40);
	assert.equal(lines[0], "");
	assert.match(lines[1]!, /^╭/);
	assert.equal(menu.handleMouse({ ...event, y: 1, height: 6 }), undefined);
	menu.handleMouse({ ...event, y: 2, height: 6 });
	assert.deepEqual(menu.mouseEvents[0], { ...event, x: 2, y: 2, width: 36, height: 6 });
});

test("already-rounded layouts with leading spacers and internal rules stay native", (t) => {
	class Menu {
		render(width: number) {
			return ["", `╭${"─".repeat(width - 2)}╮`, "─".repeat(width), "body", "─".repeat(width), `╰${"─".repeat(width - 2)}╯`];
		}
	}
	const menu = new Menu();
	const native = menu.render(40);
	t.after(installMenuFrames([Menu], () => theme));
	assert.deepEqual(menu.render(40), native);
});

test("resume, tree, and fork constructors with spacer/header layouts are framed", async (t) => {
	initTheme("dark", false);
	const session = new SessionSelectorComponent(async () => [], async () => [], () => {}, () => {}, () => {}, () => {},
		{ keybindings: getKeybindings() as never });
	const tree: SessionTreeNode[] = [{
		entry: { type: "message", id: "m", parentId: null, timestamp: "2026-01-01T00:00:00Z",
			message: { role: "user", content: "hello", timestamp: 0 } }, children: [],
	}];
	const treeMenu = new TreeSelectorComponent(tree, "m", 30, () => {}, () => {});
	const fork = new UserMessageSelectorComponent([{ id: "m", text: "hello" }], () => {}, () => {});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const menus = [session, treeMenu, fork];
	const nativeCounts = menus.map((menu) => menu.render(76).length);
	t.after(installMenuFrames(hostMenuComponents(), () => theme));
	for (const [index, menu] of menus.entries()) {
		for (const width of [8, 20, 80]) {
			const lines = menu.render(width);
			assert.equal(lines.filter((line) => line.startsWith("╭")).length, 1, menu.constructor.name);
			assert.match(lines.at(-1)!, /^╰/);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
		assert.equal(menu.render(80).length, nativeCounts[index], "native row indices preserved");
	}
	assert.ok(fork.render(80).some((line) => line.startsWith("│ ") && line.includes("Fork from Message")));
});

test("teardown restores inherited methods and original property descriptors", () => {
	const Parent = menuClass();
	class Menu extends Parent {}
	const original = Object.getOwnPropertyDescriptors(Menu.prototype);
	const cleanup = installMenuFrames([Menu], () => theme);
	assert.ok(Object.hasOwn(Menu.prototype, "render"));
	cleanup();
	cleanup();
	assert.deepEqual(Object.getOwnPropertyDescriptors(Menu.prototype), original);
	assert.equal(Menu.prototype.render, Parent.prototype.render);
	assert.equal(Menu.prototype.handleMouse, Parent.prototype.handleMouse);
});

test("frozen host prototypes remain optional", () => {
	const Menu = menuClass();
	Object.freeze(Menu.prototype);
	const original = Menu.prototype.render;
	const cleanup = installMenuFrames([Menu], () => theme);
	cleanup();
	assert.equal(Menu.prototype.render, original);
});

test("teardown leaves later wrappers in place with our adapter inert", () => {
	const Menu = menuClass();
	const cleanup = installMenuFrames([Menu], () => theme);
	const predecessor = Menu.prototype.render;
	const later = function (this: InstanceType<typeof Menu>, width: number) { return predecessor.call(this, width); };
	Menu.prototype.render = later;
	cleanup();
	assert.equal(Menu.prototype.render, later);
	assert.match(new Menu().render(40)[0]!, /^─+$/);
});

test("frame colors resolve from the current theme on every render", (t) => {
	const Menu = menuClass();
	let color = 31;
	t.after(installMenuFrames([Menu], () => ({ fg: (_role, text) => `\x1b[${color}m${text}\x1b[0m` })));
	const menu = new Menu();
	assert.ok(menu.render(40)[0]!.startsWith("\x1b[31m"));
	color = 32;
	assert.ok(menu.render(40)[0]!.startsWith("\x1b[32m"));
});

test("host ctx.ui.select uses the same frame without changing navigation or cancellation", (t) => {
	initTheme("dark", false);
	t.after(installMenuFrames(hostMenuComponents(), () => theme));
	let selected: string | undefined;
	let cancelled = false;
	const menu = new ExtensionSelectorComponent("Select effort", ["low", "high"],
		(value) => { selected = value; }, () => { cancelled = true; });
	const nativeRows = menu.render(80).length;
	for (const width of [8, 20, 80]) {
		const lines = menu.render(width);
		assert.match(lines[0]!, /^╭/);
		assert.match(lines.at(-1)!, /^╰/);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
	assert.equal(menu.render(80).length, nativeRows);
	menu.handleInput("j");
	menu.handleInput("\r");
	assert.equal(selected, "high");
	menu.handleInput("\x1b");
	assert.equal(cancelled, true);
});
