import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// A .pxc holds no record of the reader it was fitted for, and an X3 image on an X4
// is wrong in both dimensions, so the target device is written into the filename.
// These tests run the real snippet out of the page rather than a copy of it, so a
// rewrite of the rule cannot leave the test passing against logic that no longer ships.
function suffixRule() {
  const at = html.indexOf('if(S.fmt==="pxc"){');
  assert.notEqual(at, -1, "pxc filename suffix block not found in index.html");
  const body = html.slice(at, html.indexOf("return { idx, bytes, style, filename:", at));
  // deviceForSize is the page's own size-to-device map; take it from the page too.
  const mapAt = html.indexOf("function deviceForSize(w,h){");
  assert.notEqual(mapAt, -1, "deviceForSize not found in index.html");
  const map = html.slice(mapAt, html.indexOf("}", html.indexOf("return null;", mapAt)) + 1);
  return new Function("name", "fmt", "w", "h", `${map}
    const S = { fmt, w, h };
    let base = name.replace(/\\.[^.]+$/,"");
    ${body}
    return base;`);
}

const nameFor = suffixRule();

test("a PXC for the X3 gets an _X3 suffix", () => {
  assert.equal(nameFor("sunset.png", "pxc", 528, 792), "sunset_X3");
});

test("a PXC for the X4 gets an _X4 suffix", () => {
  assert.equal(nameFor("sunset.png", "pxc", 480, 800), "sunset_X4");
});

test("re-targeting replaces the old suffix instead of stacking one on top", () => {
  assert.equal(nameFor("sunset_X3.pxc", "pxc", 480, 800), "sunset_X4");
  assert.equal(nameFor("sunset_x4.pxc", "pxc", 528, 792), "sunset_X3");
});

test("a custom size names no device, because none is the target", () => {
  assert.equal(nameFor("sunset.png", "pxc", 600, 600), "sunset");
});

test("BMP output is left alone; the suffix is a PXC rule", () => {
  assert.equal(nameFor("sunset.png", "bmp", 528, 792), "sunset");
});
