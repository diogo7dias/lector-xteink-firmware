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

const { DIFFUSION } = new Function("LEVELS", "S", `${quantizeSrc}; return {DIFFUSION};`)(LEVELS, {});

test("every diffusion kernel's weights sum to its own divisor", () => {
  for (const [name, k] of Object.entries(DIFFUSION)) {
    const sum = k.taps.reduce((s, t) => s + t[2], 0);
    assert.equal(sum, k.div, `${name} weights sum to ${sum}, divisor is ${k.div}`);
  }
});

test("every style is offered once in the badge list, and each one has a label", () => {
  assert.equal(new Set(STYLES).size, STYLES.length, "a repeated entry would list a style twice");
  for (const k of STYLES) assert.ok(STYLE_LABEL[k], `${k} needs a label for the badge`);
  for (const k of STYLES) assert.equal(knownStyle(k), k, `${k} must survive the guard`);
  // A <select> whose value is not among its options shows blank, so an unknown name
  // has to land on a real entry rather than leave the picker empty.
  assert.equal(knownStyle("no-such-style"), STYLES[0], "a stale override must not blank a card");
});

test("the new diffusion styles keep a solid black ground solid", () => {
  const w = 64, h = 64;
  for (const name of Object.keys(DIFFUSION)) {
    const out = makeQuantize(LEVELS, { w, h, ditherStyle: name })(flat(w, h, 18), true);
    assert.equal(out.reduce((n, v) => n + (v === 0 ? 0 : 1), 0), 0, `${name} peppered the ground`);
  }
});

// An ordered pass has no memory, so its only hard promise is that a tone sitting
// exactly on a level is never pushed off it. That is what keeps pure black pure.
test("Ordered and Halftone leave pure black and pure white alone", () => {
  const w = 32, h = 32;
  for (const style of ["ordered", "halftone"]) {
    const quantize = makeQuantize(LEVELS, { w, h, ditherStyle: style });
    assert.deepEqual([...new Set(quantize(flat(w, h, 0), true))], [0], `${style} dirtied pure black`);
    assert.deepEqual([...new Set(quantize(flat(w, h, 255), true))], [3], `${style} dirtied pure white`);
  }
});

// The reason to have an ordered style at all: the same tone renders the same way
// wherever it appears, so a flat area is one repeating tile rather than a drifting one.
test("Ordered repeats on an 8x8 tile, everywhere in the image", () => {
  const w = 64, h = 64;
  const out = makeQuantize(LEVELS, { w, h, ditherStyle: "ordered" })(flat(w, h, 128), true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    assert.equal(out[y * w + x], out[(y & 7) * w + (x & 7)], `tile broke at ${x},${y}`);
  }
  assert.ok(new Set(out).size > 1, "a midtone must actually be carried by the pattern");
});

test("every style renders differently, so no badge step is a duplicate", () => {
  const w = 96, h = 96;
  const g = ramp(w, h);
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
  for (const style of ["solid", "classic", "smooth", ...Object.keys(DIFFUSION)]) {
    const out = makeQuantize(LEVELS, { w, h, ditherStyle: style })(g, true);
    const mean = Array.from(out).reduce((s, i) => s + LEVELS[i], 0) / out.length;
    assert.ok(Math.abs(mean - target) < 3, `${style} drifted to ${mean.toFixed(2)} from ${target.toFixed(2)}`);
  }
});
