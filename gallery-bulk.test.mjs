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
  // A reshuffle on first load, ahead of the first render.
  assert.match(html, /shuffleGallery\(\);\s*\n\s*applyGalleryQuery\(\);/);
  // And another on every re-entry, unless a search is in progress.
  assert.match(html, /else if\(galleryEntries\.length && !galleryQuery\)\{ shuffleGallery\(\);/);
});

test("gallery loads only one small batch and supports mixed master sizes", () => {
  assert.match(html, /const GALLERY_BATCH_SIZE=24;/);
  assert.match(html, /id="gloadMore"/);
  assert.match(html, /id="gprev"/);
  assert.match(html, /Download · \$\{masterDevice\} PXC/);
  assert.match(html, /renderGalleryBatch/);
  assert.match(html, /async function renderGalleryBatch\(start\)[\s\S]*?grid\.replaceChildren\(\)/);
  assert.match(html, /previewPxc/);
  assert.match(html, /loadGalleryMaster/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /for\(const entry of list\)/);
});

// Downloading all 6,600 wallpapers one card at a time is not a real option, and zipping them in
// the browser would mean 6,600 fetches and 672 MB in memory. The set is prebuilt by
// build-gallery-zip.mjs in the wallpapers repo and attached to a GitHub release, so the button
// here is a plain link to that asset.
const ZIP_URL = "https://github.com/diogo7dias/lector-wallpapers/releases/download/gallery-latest/lector-wallpapers-gallery.zip";

test("the gallery offers the whole set as one prebuilt zip", () => {
  assert.match(html, /id="gdlAll"/);
  assert.ok(html.includes(`href="${ZIP_URL}"`), "the button must point at the release asset");
  // A release asset is cross-origin, where the download attribute is ignored; GitHub already
  // serves the file as an attachment.
  const zipTag = html.match(/<a[^>]*id="gdlAll"[\s\S]*?>/)[0];
  assert.doesNotMatch(zipTag, /\sdownload[\s=>]/);
  // The size is stated up front: 176 MB is not a click to make by accident on mobile data.
  assert.match(html, /const GALLERY_ZIP_SIZE="176 MB";/);
});

test("the zip button states the real wallpaper count once the manifest is in", () => {
  // Hardcoding the count would go stale on the next import; the manifest already knows it.
  assert.match(html, /function updateGalleryZipNote\(\)/);
  assert.match(html, /galleryEntries\.length\.toLocaleString\(\)/);
  assert.match(html, /GALLERY_ZIP_SIZE/g);
  // Called after the manifest loads, not before, or it would advertise "0 wallpapers".
  assert.match(html, /galleryEntries=\(manifest && manifest\.wallpapers\) \|\| \[\];[\s\S]{0,200}updateGalleryZipNote\(\);/);
  // And once at load, so the offer still stands if the manifest never arrives.
  assert.match(html, /^updateGalleryZipNote\(\);$/m);
  // galleryEntries is a let: calling above its declaration throws and takes the page with it.
  assert.ok(html.indexOf("let galleryEntries=") < html.search(/^updateGalleryZipNote\(\);$/m));
});
