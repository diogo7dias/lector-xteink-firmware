import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Guards against the page describing a build it no longer serves.
//
// This page went out to readers claiming "the build on this site is lector 0.11.1"
// while it was serving 0.24.0, and its release history stopped six releases back.
// Nothing caught either, because every version was typed by hand in prose. These
// tests make that failure loud: the firmware release workflow writes
// flash/version.txt into this repository on every stable tag, so the moment a
// release lands, anything on the page still naming the previous one fails here.

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const publishedVersion = readFileSync(new URL("./flash/version.txt", import.meta.url), "utf8").trim();

/** "lector 0.24.0" -> "0.24.0" */
const numberOf = (display) => display.replace(/^lector\s+/, "");

test("the published version string is well formed", () => {
  assert.match(publishedVersion, /^lector \d+\.\d+\.\d+$/, `flash/version.txt reads "${publishedVersion}"`);
});

test("no version is hardcoded into the flasher prose", () => {
  // The sentence above the big number, and the number itself, both read
  // flash/version.txt at load. Anything typed in by hand here drifts silently.
  const proseVersions = html.match(/The build on this site is <strong>lector[^<]*<\/strong>/g);
  assert.equal(proseVersions, null, "the flasher prose names a version literally instead of reading version.txt");
  assert.match(html, /id="flashVersionInline"/, "the prose lost the element that fills it from version.txt");
  assert.match(html, /id="flashVersion"/, "the headline lost the element that fills it from version.txt");
});

test("the release summary names the build being served", () => {
  // The page describes exactly one release: the one it serves. It once claimed
  // 0.11.1 while serving 0.24.0, which is why this is asserted rather than trusted.
  const match = html.match(/What (lector \d+\.\d+\.\d+) does/);
  assert.ok(match, "no release summary heading found in the flasher panel");
  assert.equal(
    match[1],
    publishedVersion,
    `the summary describes ${match[1]} while the site serves ${publishedVersion}`,
  );
});

test("the on-device version claim matches what is served", () => {
  const match = html.match(/Reports version <strong>(lector \d+\.\d+\.\d+)<\/strong> on device/);
  assert.ok(match, "the panel no longer says which version the reader will report");
  assert.equal(match[1], publishedVersion);
});

test("no earlier release is described on the page", () => {
  // Every older release lives on the GitHub releases page. A history kept by hand
  // here went six releases stale without anyone noticing.
  const others = [...html.matchAll(/lector (\d+\.\d+\.\d+)/g)]
    .map((m) => m[1])
    .filter((v) => v !== numberOf(publishedVersion));
  assert.deepEqual(others, [], `the page still describes ${others.join(", ")}`);
  assert.match(
    html,
    /github\.com\/diogo7dias\/lector\/releases/,
    "nothing points readers at the releases page for older notes",
  );
});

test("the experimental channel is not offered", () => {
  // Experimental builds are handed over as a test kit now, not published here.
  assert.doesNotMatch(html, /btnExperimental/, "the experimental button is back on the page");
  assert.doesNotMatch(html, /manifest-experimental/, "the page still fetches the experimental manifest");
});

test("the SD card download serves the app image and says what it cannot do", () => {
  assert.match(html, /id="btnDownloadBin"/, "the SD download button is gone");
  assert.match(
    html,
    /href="flash\/firmware\/latest\/firmware\.bin"/,
    "the download must serve the same app image the Update button writes",
  );
  assert.match(html, /download="lector-firmware\.bin"/, "the link does not download, it navigates");
  // The SD picker is part of Lector, so it cannot install onto a stock reader or
  // revive a dead one. Promising otherwise sends people to the wrong rescue.
  assert.match(html, /already running Lector/i);
  assert.match(html, /cannot install onto a stock reader/i);
});
