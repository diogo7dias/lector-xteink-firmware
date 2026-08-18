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

test("Smooth keeps flat fields clean, like Clean and unlike Classic", () => {
  const w = 64, h = 64;
  const g = flat(w, h, 245);
  const smooth = makeQuantize(LEVELS, { w, h, ditherStyle: "smooth" })(g, true);
  const strays = out => out.reduce((n, v) => n + (v === 3 ? 0 : 1), 0);
  assert.equal(strays(smooth), 0, "the flat-area snap must still apply under Smooth");
});

test("Smooth is its own pass: not Clean, not Classic", () => {
  const w = 64, h = 64;
  const g = ramp(w, h);
  const smooth = Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: "smooth" })(g, true));
  const clean = Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: "clean" })(g, true));
  const classic = Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: "classic" })(g, true));
  assert.notDeepEqual(smooth, clean, "Smooth must differ from Clean — the kernel is the whole point");
  assert.notDeepEqual(smooth, classic, "Smooth keeps the serpentine scan and the snap; Classic has neither");
});

// The reason Smooth exists. Atkinson discards two eighths of every error, so the
// rendered average drifts away from the source; Floyd-Steinberg conserves it.
test("Smooth holds the average tone at least as well as Clean", () => {
  const w = 96, h = 96;
  const g = ramp(w, h);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const rendered = style =>
    mean(Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: style })(g, true)).map(i => LEVELS[i]));
  const target = mean(Array.from(g));
  const smoothErr = Math.abs(rendered("smooth") - target);
  const cleanErr = Math.abs(rendered("clean") - target);
  assert.ok(smoothErr <= cleanErr, `Smooth drifted ${smoothErr} vs Clean ${cleanErr}`);
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

// Solid is Classic with one narrow exception: flat fields that are almost pure
// black or almost pure white are taken to that level and their error dropped.
// The tests below pin both halves of that sentence — the exception fires where it
// should, and nowhere else.

test("Solid clears the grey dots off a solid black ground", () => {
  const w = 64, h = 64;
  const g = flat(w, h, 18);   // a photo's black background: dark, but not level 0

  const solid = makeQuantize(LEVELS, { w, h, ditherStyle: "solid" })(g, true);
  const classic = makeQuantize(LEVELS, { w, h, ditherStyle: "classic" })(g, true);

  const dots = out => out.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
  assert.equal(dots(solid), 0, "a flat near-black field must come out solid black");
  assert.ok(dots(classic) > 0, "Classic peppers it — that is the complaint Solid answers");
});

test("Solid clears the grey dots off a solid white ground", () => {
  const w = 64, h = 64;
  const g = flat(w, h, 240);
  const solid = makeQuantize(LEVELS, { w, h, ditherStyle: "solid" })(g, true);
  assert.equal(solid.reduce((n, v) => n + (v === 3 ? 0 : 1), 0), 0);
});

// The reason Solid restricts the snap to the endpoints. A midtone has levels on
// both sides and can pay its error in either direction, so ordinary dithering
// there is honest and must be left exactly as Classic renders it.
test("Solid is Classic byte for byte away from the two endpoints", () => {
  const w = 64, h = 64;
  for (const fill of [110, 150, 190]) {
    const solid = makeQuantize(LEVELS, { w, h, ditherStyle: "solid" })(flat(w, h, fill), true);
    const classic = makeQuantize(LEVELS, { w, h, ditherStyle: "classic" })(flat(w, h, fill), true);
    assert.deepEqual(Array.from(solid), Array.from(classic), `midtone ${fill} must be untouched`);
  }
});

// RAW_TOL is what makes this safe: a one-pixel line's own neighbourhood spans the
// whole distance from the line to its ground, so the line never counts as flat and
// the snap cannot swallow it.
test("Solid keeps a one-pixel line standing on a near-black ground", () => {
  const w = 64, h = 64;
  const g = flat(w, h, 18);
  for (let y = 0; y < h; y++) g[y * w + 32] = 250;

  const solid = makeQuantize(LEVELS, { w, h, ditherStyle: "solid" })(g, true);

  let kept = 0, dots = 0;
  for (let y = 0; y < h; y++) {
    if (solid[y * w + 32] >= 2) kept++;
    for (let x = 0; x < w; x++) if (Math.abs(x - 32) > 2 && solid[y * w + x] !== 0) dots++;
  }
  assert.equal(kept, h, "every pixel of the line must survive");
  assert.equal(dots, 0, "and the ground around it must still come out solid black");
});

test("Solid holds tone far better than Clean, which is why it is not just Clean", () => {
  const w = 96, h = 96;
  const g = ramp(w, h);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const rendered = style =>
    mean(Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: style })(g, true)).map(i => LEVELS[i]));
  const target = mean(Array.from(g));
  const solidErr = Math.abs(rendered("solid") - target);
  const cleanErr = Math.abs(rendered("clean") - target);
  assert.ok(solidErr < cleanErr, `Solid drifted ${solidErr} vs Clean ${cleanErr}`);
});

// ---------- the rest of the style set ----------
// These reach the page through the per-image badge rather than the global picker, so
// the guard that matters most is the last test here: a name that quantize() does not
// handle falls through to the Clean fallback and would otherwise ship silently, giving
// two badge steps that render the same image.

const styleListSrc = extract("const STYLES = [", "// ---------- state ----------");
const { STYLES, STYLE_LABEL, knownStyle } =
  new Function(`${styleListSrc}; return {STYLES, STYLE_LABEL, knownStyle};`)();

test("every style is offered once in the badge list, and each one has a label", () => {
  assert.equal(new Set(STYLES).size, STYLES.length, "a repeated entry would list a style twice");
  for (const k of STYLES) assert.ok(STYLE_LABEL[k], `${k} needs a label for the badge`);
  for (const k of STYLES) assert.equal(knownStyle(k), k, `${k} must survive the guard`);
  // A <select> whose value is not among its options shows blank, so an unknown name
  // has to land on a real entry rather than leave the picker empty.
  assert.equal(knownStyle("no-such-style"), STYLES[0], "a stale override must not blank a card");
});

// An ordered pass has no memory, so its only hard promise is that a tone sitting
// exactly on a level is never pushed off it. That is what keeps pure black pure.
// This once covered the 8x8 screens only, and they passed by luck: the offset on an
// 8x8 tile stops just short of nearestLevel's 42 break. Widening it to every screen
// caught Halftone 45 and the diagonal line screen tipping a pure black ground to
// grey on one cell, which screenedLevel() now prevents for any tile size.
test("every screened style leaves pure black and pure white alone", () => {
  const w = 32, h = 32;
  for (const style of ["halftone", "halftone45", "halftonefine", "linescreen"]) {
    const quantize = makeQuantize(LEVELS, { w, h, ditherStyle: style });
    assert.deepEqual([...new Set(quantize(flat(w, h, 0), true))], [0], `${style} dirtied pure black`);
    assert.deepEqual([...new Set(quantize(flat(w, h, 255), true))], [3], `${style} dirtied pure white`);
  }
});

// The reason to have an ordered style at all: the same tone renders the same way
// wherever it appears, so a flat area is one repeating tile rather than a drifting one.
test("Halftone repeats on an 8x8 tile, everywhere in the image", () => {
  const w = 64, h = 64;
  const out = makeQuantize(LEVELS, { w, h, ditherStyle: "halftone" })(flat(w, h, 128), true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    assert.equal(out[y * w + x], out[(y & 7) * w + (x & 7)], `tile broke at ${x},${y}`);
  }
  assert.ok(new Set(out).size > 1, "a midtone must actually be carried by the pattern");
});

// The generated screens are only correct if every threshold appears exactly once.
// A duplicated or missing rank bends the tone response, and it would be invisible
// by eye until a gradient came out wrong, so pin the permutation itself.
const { screenMatrix, SCREEN_ROUND45, SCREEN_FINE45, SCREEN_LINE } =
  new Function("LEVELS", "S", `${quantizeSrc}; return {screenMatrix, SCREEN_ROUND45, SCREEN_FINE45, SCREEN_LINE};`)(LEVELS, {});

test("every generated dot screen uses each threshold exactly once", () => {
  for (const [name, m, n] of [["round45", SCREEN_ROUND45, 12], ["fine45", SCREEN_FINE45, 6]]) {
    assert.equal(m.length, n * n, `${name} is not ${n}x${n}`);
    assert.deepEqual([...m].sort((a, b) => a - b), Array.from({ length: n * n }, (_, i) => i),
      `${name} is not a permutation of 0..${n * n - 1}`);
  }
});

// The line screen is deliberately not a permutation — every cell on a band shares
// one threshold, which is what makes bands thicken instead of filling lengthwise.
// Its promise is instead that the n band thresholds are evenly spread over the
// same range, so tone still rises steadily.
test("every line screen spreads one threshold per band, evenly", () => {
  for (const [name, m, n] of [["diagonal", SCREEN_LINE, 10]]) {
    const cells = n * n;
    assert.equal(m.length, cells, `${name} is not ${n}x${n}`);
    const values = [...new Set(m)].sort((a, b) => a - b);
    assert.equal(values.length, n, `${name}: expected ${n} band thresholds, got ${values.length}`);
    assert.ok(values[0] < cells / n && values[n - 1] > cells - cells / n, `${name} must span the range`);
    const gaps = values.slice(1).map((v, i) => v - values[i]);
    assert.equal(new Set(gaps).size, 1, `${name} band spacing must be even, got ${gaps.join(",")}`);
  }
});

// The rank order is what makes it a screen rather than noise: ink has to start at
// one point per dot and spread outward from there. If the ordering were wrong the
// matrix would still be a valid permutation and still pass the test above.
test("a generated screen grows outward from its dot centre", () => {
  const n = 12, m = SCREEN_ROUND45;
  const at = (x, y) => m[((y % n) + n) % n * n + ((x % n) + n) % n];
  const centre = m.indexOf(0), cx = centre % n, cy = (centre - cx) / n;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
    assert.ok(at(cx + dx, cy + dy) < at(cx + 2 * dx, cy + 2 * dy),
      `ink at ${dx},${dy} must arrive before ${2 * dx},${2 * dy}`);
  }
});

// A line screen must not close into dots — that is the whole difference. Its spot
// function reads one axis only, so every cell on a given diagonal shares a tone.
// Bands must thicken, not fill along their length. Ranking every cell separately
// gives the cells on one band consecutive thresholds, which draws a diagonal
// gradient of dots instead of lines — the first version did exactly that.
// It is pinned by walking ALONG a band: the level must not change there, and must
// change across it.
test("the line screen renders bands in its own direction", () => {
  const w = 40, h = 40;
  //                    style          step along a band
  for (const [style, dx, dy] of [["linescreen", 1, -1]]) {
    const out = makeQuantize(LEVELS, { w, h, ditherStyle: style })(flat(w, h, 128), true);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x + 1 < w; x++) {
      assert.equal(out[y * w + x], out[(y + dy) * w + x + dx], `${style} band broke at ${x},${y}`);
    }
    assert.ok(new Set(out).size > 1, `${style}: a midtone must be carried by the bands`);
  }
});

test("every style renders differently, so no badge step is a duplicate", () => {
  const w = 96, h = 96;
  // A ramp alone is the wrong probe: the picture needs both a gradient and a
  // textured patch for every style to have somewhere to differ, which is what a
  // real photograph has.
  const g = ramp(w, h);
  for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) g[y * w + x] = (x * 37 + y * 91) % 256;
  const seen = new Map();
  for (const style of STYLES) {
    const dither = style !== "threshold";
    const key = Array.from(makeQuantize(LEVELS, { w, h, ditherStyle: style })(g, dither)).join("");
    const clash = seen.get(key);
    assert.equal(clash, undefined, `${style} renders identically to ${clash} — quantize() is not handling it`);
    seen.set(key, style);
  }
});

// Diffusion conserves error by construction, so every one of these should land close
// to the source average. A kernel typed in wrong shows up here as tone drift.
test("every diffusion style holds the average tone of a ramp", () => {
  const w = 96, h = 96;
  const g = ramp(w, h);
  const target = Array.from(g).reduce((s, v) => s + v, 0) / g.length;
  for (const style of ["solid", "classic", "smooth"]) {
    const out = makeQuantize(LEVELS, { w, h, ditherStyle: style })(g, true);
    const mean = Array.from(out).reduce((s, i) => s + LEVELS[i], 0) / out.length;
    assert.ok(Math.abs(mean - target) < 3, `${style} drifted to ${mean.toFixed(2)} from ${target.toFixed(2)}`);
  }
});
