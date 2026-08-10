import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// Pull the shipping quantiser out of the page rather than copying it here, so a
// rewrite cannot leave these tests passing against logic that no longer ships.
function extract(startMarker, endMarker) {
  const at = html.indexOf(startMarker);
  assert.notEqual(at, -1, `${startMarker} not found in index.html`);
  const end = html.indexOf(endMarker, at);
  assert.notEqual(end, -1, `end of ${startMarker} not found`);
  return html.slice(at, end);
}

const LEVELS = [0, 85, 170, 255];
const quantizeSrc = extract("function nearestLevel(v){", "// Strip stray specks");
const makeQuantize = new Function("LEVELS", "S", `${quantizeSrc}; return quantize;`);

function flat(w, h, fill) {
  const a = new Uint8Array(w * h);
  a.fill(fill);
  return a;
}

// The plain Floyd-Steinberg the converter shipped before 2026-08-05, written out
// independently. "Classic" must reproduce this exactly, or an old master
// re-converted through it no longer matches the file it originally produced.
function referenceFloydSteinberg(g, w, h) {
  // Same thresholds the page uses. They are NOT the true midpoints (42.5 / 127.5
  // / 212.5), so a true-nearest helper disagrees with the shipping code on the
  // half-gray boundary and this test would fail against a correct port.
  const nearest = v => (v >= 212 ? 3 : v >= 127 ? 2 : v >= 42 ? 1 : 0);
  const idx = new Uint8Array(w * h);
  const buf = Float32Array.from(g);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, old = buf[i], q = nearest(old);
      idx[i] = q;
      const err = old - LEVELS[q];
      if (x + 1 < w) buf[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        const n = (y + 1) * w + x;
        if (x > 0) buf[n - 1] += err * 3 / 16;
        buf[n] += err * 5 / 16;
        if (x + 1 < w) buf[n + 1] += err * 1 / 16;
      }
    }
  }
  return idx;
}

// A left-to-right ramp: every row carries a residual, so the two styles have
// somewhere to disagree and the reference has something to match.
function ramp(w, h) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.round((x / (w - 1)) * 255);
  return a;
}

test("Classic reproduces the pre-2026-08-05 Floyd-Steinberg exactly", () => {
  const w = 64, h = 64;
  const quantize = makeQuantize(LEVELS, { w, h, ditherStyle: "classic" });
  const g = ramp(w, h);
  assert.deepEqual(Array.from(quantize(g, true)), Array.from(referenceFloydSteinberg(g, w, h)));
});

test("Classic keeps the speckle on a flat field and Clean removes it", () => {
  const w = 64, h = 64;
  const g = flat(w, h, 245);  // near white, but not on a level

  const clean = makeQuantize(LEVELS, { w, h, ditherStyle: "clean" })(g, true);
  const classic = makeQuantize(LEVELS, { w, h, ditherStyle: "classic" })(g, true);

  const strays = out => out.reduce((n, v) => n + (v === 3 ? 0 : 1), 0);
  assert.equal(strays(clean), 0, "Clean must place a flat near-white field on one level");
  assert.ok(strays(classic) > 0, "Classic must keep the old grit — that is what it is for");
});

test("an unset style behaves as Clean, so callers predating the setting are unchanged", () => {
  const w = 32, h = 32;
  const g = flat(w, h, 245);
  const unset = makeQuantize(LEVELS, { w, h })(g, true);
  const clean = makeQuantize(LEVELS, { w, h, ditherStyle: "clean" })(g, true);
  assert.deepEqual(Array.from(unset), Array.from(clean));
});

test("thresholding ignores the style entirely", () => {
  const w = 16, h = 16;
  const g = ramp(w, h);
  const clean = makeQuantize(LEVELS, { w, h, ditherStyle: "clean" })(g, false);
  const classic = makeQuantize(LEVELS, { w, h, ditherStyle: "classic" })(g, false);
  assert.deepEqual(Array.from(clean), Array.from(classic));
});
