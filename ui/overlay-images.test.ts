import assert from "node:assert/strict";
import { test } from "node:test";
import { hideViewportImages, imageRowSpan, suspendImagesUnderOverlays } from "./overlay-images.js";

const kitty = (rows: number) => `\x1b_Ga=T,f=100,q=2,r=${rows},i=7;AAAA\x1b\\`;
const iterm = (rows: number) => `\x1b[${rows - 1}A\x1b]1337;File=inline=1:AAAA\x07`;

test("imageRowSpan reads Kitty rows below and iTerm2 rows above", () => {
	assert.deepEqual(imageRowSpan(kitty(4)), { above: 0, below: 3 });
	assert.deepEqual(imageRowSpan(iterm(5)), { above: 4, below: 0 });
	assert.deepEqual(imageRowSpan(kitty(1)), { above: 0, below: 0 });
	assert.equal(imageRowSpan("plain \x1b[31mred\x1b[0m"), undefined);
});

test("hideViewportImages blanks images that reach into the viewport", () => {
	// 10 lines, height 4: rows 6..9 are visible.
	const lines = ["a", kitty(2), "", "b", "c", kitty(3), "", "", "d", "e"];
	const result = hideViewportImages(lines, 4);
	assert.equal(result.length, lines.length);
	assert.equal(result[1], kitty(2), "an image fully in scrollback stays");
	assert.equal(result[5], "", "an image whose rows reach the viewport is blanked");
	assert.deepEqual(result.slice(6), ["", "", "d", "e"]);
});

test("hideViewportImages handles short content and returns the same array without images", () => {
	const lines = ["x", "y"];
	assert.equal(hideViewportImages(lines, 10), lines);
	assert.deepEqual(hideViewportImages([iterm(2), "z"], 10), ["", "z"]);
});

class FakeTui {
	overlayStack: unknown[] = [];
	renders = 0;
	seen: string[][] = [];
	compositeOverlays(lines: string[], _w: number, _h: number): string[] {
		this.seen.push(lines);
		return lines;
	}
	requestRender(): void {
		this.renders++;
	}
}

test("suspendImagesUnderOverlays hides images only while overlays are open and nests", () => {
	const tui = new FakeTui();
	const lines = [kitty(2), "", "text"];
	const releaseA = suspendImagesUnderOverlays(tui);
	const releaseB = suspendImagesUnderOverlays(tui);

	tui.compositeOverlays(lines, 80, 10);
	assert.deepEqual(tui.seen.at(-1), lines, "no overlay, no change");

	tui.overlayStack.push({});
	tui.compositeOverlays(lines, 80, 10);
	assert.deepEqual(tui.seen.at(-1), ["", "", "text"]);

	releaseA();
	releaseA();
	assert.equal(tui.renders, 0);
	tui.compositeOverlays(lines, 80, 10);
	assert.deepEqual(tui.seen.at(-1), ["", "", "text"], "still suspended by B");

	releaseB();
	assert.equal(tui.renders, 1);
	assert.equal(Object.prototype.hasOwnProperty.call(tui, "compositeOverlays"), false);
	tui.compositeOverlays(lines, 80, 10);
	assert.deepEqual(tui.seen.at(-1), lines, "restored");
});

test("suspendImagesUnderOverlays is a no-op for a TUI without compositeOverlays", () => {
	const release = suspendImagesUnderOverlays({ requestRender() {} });
	release();
});
