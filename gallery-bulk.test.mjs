import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const galleryDir = new URL("./gallery/", import.meta.url);
// The gallery is optional: its 3,190 PXC files were removed from this repo because
// publishing 324 MB made every Pages deploy slow and fragile, and scripts/import-gallery.mjs
// restores them on demand. The content checks below only mean something when the files are
// present, so they skip rather than fail when they are not; the UI and importer checks that
// follow are about index.html and the script, and always run.
const galleryPresent = existsSync(new URL("manifest.json", galleryDir));
const manifest = galleryPresent ? JSON.parse(readFileSync(new URL("manifest.json", galleryDir), "utf8")) : null;
const hashFile = new URL("hashes.json", galleryDir);
const hashSnapshot = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, "utf8")) : [];

test("gallery contains every unique download as a sequential unchanged PXC",
     { skip: galleryPresent ? false : "gallery not published in this checkout" }, () => {
  const entries = manifest.wallpapers;
  assert.equal(entries.length, 3190);
  assert.deepEqual(entries.map(entry => entry.file),
    Array.from({ length: 3190 }, (_, index) => `${String(index + 1).padStart(4, "0")}.pxc`));
  assert.ok(entries.every(entry => Object.keys(entry).join(",") === "file"));

  const files = readdirSync(galleryDir).filter(name => name.endsWith(".pxc")).sort();
  assert.deepEqual(files, entries.map(entry => entry.file));

  const hashes = new Set();
  const dimensions = new Map();
  for (const [index, file] of files.entries()) {
    const bytes = readFileSync(new URL(file, galleryDir));
    const hash = createHash("sha256").update(bytes).digest("hex");
    hashes.add(hash);
    assert.deepEqual(hashSnapshot[index], { file, sha256: hash });
    const size = `${bytes.readUInt16LE(0)}x${bytes.readUInt16LE(2)}`;
    dimensions.set(size, (dimensions.get(size) ?? 0) + 1);
  }
  assert.equal(hashes.size, 3190);
  assert.equal(hashSnapshot.length, 3190);
  assert.deepEqual(Object.fromEntries(dimensions), { "528x792": 3156, "480x800": 34 });
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

test("importer validates full payload and swaps a complete staged gallery", () => {
  const importer = readFileSync(new URL("./scripts/import-gallery.mjs", import.meta.url), "utf8");
  assert.match(importer, /expectedLength=4\+Math\.ceil\(width\/4\)\*height/);
  assert.match(importer, /existingAssignments/);
  assert.match(importer, /stagingDir/);
  assert.match(importer, /backupDir/);
  assert.match(importer, /rename\(stagingDir,galleryDir\)/);
});
