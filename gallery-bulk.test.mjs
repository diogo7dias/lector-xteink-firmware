import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// The wallpapers themselves live in diogo7dias/lector-wallpapers and are served from that
// repo's GitHub Pages site. They were removed from here because 3,190 PXC files (324 MB)
// made every Pages deploy slow and every release-workflow clone of this repo slow with it.
// What is left to test here is the wiring: the grid must still render inside this page's
// Gallery tab, reading from the remote base, and must reshuffle on every visit.

test("gallery reads from the wallpapers repo and still renders in this page", () => {
  assert.match(html, /const GALLERY_REMOTE="https:\/\/diogo7dias\.github\.io\/lector-wallpapers\/gallery\/";/);
  assert.match(html, /const galleryUrl=file=>GALLERY_BASE\+file;/);
  // A local gallery/ checkout wins over the remote, so the importer and a local server work.
  assert.match(html, /for\(const base of \["gallery\/",GALLERY_REMOTE\]\)/);
  // Every fetch and the master download go through galleryUrl, never a bare "gallery/" path.
  assert.doesNotMatch(html, /fetch\("gallery\/"\+/);
  assert.doesNotMatch(html, /href="gallery\/"\+/);
  // Four call sites: manifest, preview fetch, master fetch, master download link.
  assert.equal(html.match(/galleryUrl\(/g).length, 4);
  // target="_blank" on a gallery link would take the user off the page; the tab renders here.
  assert.doesNotMatch(html, /gdl-main[\s\S]{0,200}target="_blank"/);
});

test("gallery reshuffles on first load and on every re-entry", () => {
  assert.match(html, /function shuffleGallery\(\)/);
  // Fisher-Yates, not sort() with a random comparator, which is biased.
  assert.match(html, /const j=Math\.floor\(Math\.random\(\)\*\(i\+1\)\);/);
  assert.match(html, /shuffleGallery\(\);\s*\n\s*state\.hidden=true;/);
  assert.match(html, /else if\(galleryEntries\.length\)\{ shuffleGallery\(\); renderGalleryBatch\(0\); \}/);
});

test("gallery loads only one small batch and supports mixed master sizes", () => {
  assert.match(html, /const GALLERY_BATCH_SIZE=24;/);
  assert.match(html, /id="gloadMore"/);
  assert.match(html, /id="gprev"/);
  assert.match(html, /Download · \$\{masterDevice\} PXC/);
  assert.match(html, /renderGalleryBatch/);
  assert.match(html, /async function renderGalleryBatch\(start\)[\s\S]*?grid\.replaceChildren\(\)/);
  assert.match(html, /const GALLERY_PREVIEW_WIDTH=240;/);
  assert.match(html, /previewPxc/);
  assert.match(html, /loadGalleryMaster/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /for\(const entry of list\)/);
});
