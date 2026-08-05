import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// Pull the shipping functions out of the page rather than copying them here, so
// a rewrite of the algorithm cannot leave these tests passing against logic that
// no longer ships.
function extract(startMarker, endMarker) {
  const at = html.indexOf(startMarker);
  assert.notEqual(at, -1, `${startMarker} not found in index.html`);
  const end = html.indexOf(endMarker, at);
  assert.notEqual(end, -1, `end of ${startMarker} not found`);
  return html.slice(at, end);
}

const LEVELS = [0, 85, 170, 255];

const despeckleSrc =
  extract("const MAX_SPECKLE", "// ---------- encoders ----------");
const despeckleIdx = new Function(`${despeckleSrc}; return despeckleIdx;`)();

const quantizeSrc =
  extract("function nearestLevel(v){", "// Strip stray specks");
const makeQuantize = new Function("LEVELS", "S", `${quantizeSrc}; return quantize;`);

function grid(w, h, fill) {
  const a = new Uint8Array(w * h);
  a.fill(fill);
  return a;
}

// ------------------------------------------------------------ despeckle

test("a lone stray pixel in a flat field is pulled to its surroundings", () => {
  const w = 9, h = 9;
  const idx = grid(w, h, 3);        // solid white
  idx[4 * w + 4] = 1;               // one dark pixel of grit in the middle
  const out = despeckleIdx(idx, w, h);
  assert.equal(out[4 * w + 4], 3, "the stray pixel should have been cleaned");
  assert.equal(out.filter((v) => v !== 3).length, 0, "nothing else should change");
});

test("a one-pixel-wide line survives, being one long island", () => {
  const w = 9, h = 9;
  const idx = grid(w, h, 3);
  for (let y = 0; y < h; y++) idx[y * w + 4] = 0;   // vertical hairline
  const out = despeckleIdx(idx, w, h);
  for (let y = 1; y < h - 1; y++) {
    assert.equal(out[y * w + 4], 0, `line pixel at row ${y} was eaten`);
  }
});

test("a diagonal one-pixel line also survives", () => {
  const w = 9, h = 9;
  const idx = grid(w, h, 3);
  for (let i = 0; i < 9; i++) idx[i * w + i] = 0;
  const out = despeckleIdx(idx, w, h);
  for (let i = 1; i < 8; i++) {
    assert.equal(out[i * w + i], 0, `diagonal pixel ${i} was eaten`);
  }
});

test("an image with no speckle comes back byte-for-byte identical", () => {
  const w = 12, h = 12;
  const idx = grid(w, h, 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) idx[y * w + x] = 0;
  const out = despeckleIdx(idx, w, h);
  assert.deepEqual([...out], [...idx]);
});

test("real dither texture is left alone; its islands all connect", () => {
  const w = 16, h = 16;
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = (x + y) & 1 ? 3 : 2;
  const out = despeckleIdx(idx, w, h);
  assert.deepEqual([...out], [...idx]);
});

test("the end of a line is not eaten, and does not erode over repeated runs", () => {
  // A neighbour-counting rule fails here: the last pixel of a line has seven
  // background neighbours and one of its own, so it is removed, and then the new
  // last pixel on the next run, until the line is gone. Measuring the island
  // instead makes the pass safe to repeat, and this test is what keeps it so.
  const w = 24, h = 24;
  const idx = grid(w, h, 3);
  for (let y = 4; y <= 18; y++) idx[y * w + 12] = 0;   // a line with two free ends
  const before = idx.filter((v) => v === 0).length;
  let out = idx;
  for (let pass = 0; pass < 10; pass++) out = despeckleIdx(out, w, h);
  assert.equal(out.filter((v) => v === 0).length, before,
    "the line lost pixels; it is being eroded from its ends");
  assert.equal(out[4 * w + 12], 0, "the top end of the line was eaten");
  assert.equal(out[18 * w + 12], 0, "the bottom end of the line was eaten");
});

test("a small clump of stray pixels is cleaned, not just single ones", () => {
  // Error diffusion drops specks next to each other as often as alone. A rule
  // that only caught fully isolated pixels left roughly a sixth of the grit
  // behind.
  const w = 20, h = 20;
  const idx = grid(w, h, 3);
  idx[10 * w + 10] = 1; idx[10 * w + 11] = 1; idx[11 * w + 10] = 1;  // 3-pixel clump
  const out = despeckleIdx(idx, w, h);
  assert.equal(out.filter((v) => v !== 3).length, 0, "the clump should have been cleaned");
});

test("running the cleaner twice changes nothing the first run left", () => {
  const w = 40, h = 40;
  const idx = grid(w, h, 3);
  for (let y = 5; y < 35; y++) idx[y * w + 8] = 0;         // structure
  for (let i = 0; i < 30; i++) idx[(i * 7 % 36 + 2) * w + (i * 13 % 30 + 5)] = 1; // grit
  const once = despeckleIdx(idx, w, h);
  const twice = despeckleIdx(once, w, h);
  assert.deepEqual([...twice], [...once], "the pass is not settled after one run");
});

test("a speck on a boundary between two levels is structure, and is kept", () => {
  // With black on one side and white on the other there is no single surrounding
  // level, so the pixel is part of the picture rather than grit on a background.
  const w = 20, h = 20;
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = x < 10 ? 0 : 3;
  idx[10 * w + 10] = 2;   // a mid-grey pixel sitting right on the edge
  const out = despeckleIdx(idx, w, h);
  assert.equal(out[10 * w + 10], 2, "a pixel on a boundary must not be filled in");
});

test("the border is left untouched, having no full neighbourhood to judge it", () => {
  const w = 9, h = 9;
  const idx = grid(w, h, 3);
  idx[0] = 0;
  const out = despeckleIdx(idx, w, h);
  assert.equal(out[0], 0);
});

// ------------------------------------------------------------ dithering

function quantizeFlat(value, w, h) {
  const S = { w, h };
  const quantize = makeQuantize(LEVELS, S);
  const g = new Float32Array(w * h);
  g.fill(value);
  return quantize(g, true);
}

test("a near-white flat field dithers to solid white, with no stray dots", () => {
  // This is the regression the whole change exists for: 245 is 10 short of
  // white, and plain Floyd-Steinberg used to bank that residual until it tipped
  // a pixel a full 85 levels down to grey.
  const out = quantizeFlat(245, 64, 64);
  assert.equal(out.filter((v) => v !== 3).length, 0, "flat near-white should hold one level");
});

test("a flat mid-light field snaps to its own level rather than speckling", () => {
  const out = quantizeFlat(190, 64, 64);
  assert.equal(out.filter((v) => v !== 2).length, 0, "flat 190 should hold the 170 level");
});

test("a tone genuinely between two levels still dithers, as it must", () => {
  // 128 is 43 from one level and 42 from the other. Snapping it would be a lie
  // about the image, so both levels have to appear.
  const out = quantizeFlat(128, 64, 64);
  const used = new Set(out);
  assert.ok(used.size > 1, "a true mid-tone must still mix two levels");
});

test("a gradient keeps its shape: dark end dark, light end light", () => {
  const w = 128, h = 8, S = { w, h };
  const quantize = makeQuantize(LEVELS, S);
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x / (w - 1)) * 255;
  const out = quantize(g, true);
  assert.equal(out[0], 0, "the dark end should be black");
  assert.equal(out[w - 1], 3, "the light end should be white");
});

test("a one-pixel line on a flat background is not snapped away", () => {
  // The flatness test blurs before measuring, so that grain does not read as
  // detail. That blur smears a line thinner than its own kernel into a locally
  // uniform band, which on its own would have the line declared flat and pulled
  // to the background's level. The raw-spread check is what prevents it, and
  // this test is what keeps that check honest.
  const w = 64, h = 32, S = { w, h };
  const quantize = makeQuantize(LEVELS, S);
  const g = new Float32Array(w * h);
  g.fill(245);
  for (let x = 0; x < w; x++) g[16 * w + x] = 20;   // black hairline on near-white
  const out = quantize(g, true);
  for (let x = 2; x < w - 2; x++) {
    assert.equal(out[16 * w + x], 0, `hairline pixel at x=${x} was lost`);
  }
  assert.equal(out[8 * w + 8], 3, "the background around it should still be clean white");
});

test("a lone dark pixel on a flat background is kept, not smoothed away", () => {
  // The quantiser must not do the cleaner's job. Removing detail is a decision
  // for the Cleaner tab on an already-converted file, never for a fresh convert.
  const w = 32, h = 32, S = { w, h };
  const quantize = makeQuantize(LEVELS, S);
  const g = new Float32Array(w * h);
  g.fill(245);
  g[16 * w + 16] = 0;
  const out = quantize(g, true);
  assert.equal(out[16 * w + 16], 0, "a real dark pixel in the source must survive");
});

test("thresholding is untouched by the change", () => {
  const w = 4, h = 1, S = { w, h };
  const quantize = makeQuantize(LEVELS, S);
  const g = Float32Array.from([0, 100, 200, 255]);
  assert.deepEqual([...quantize(g, false)], [0, 1, 2, 3]);
});
