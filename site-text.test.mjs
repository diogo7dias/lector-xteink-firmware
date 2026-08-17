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

test("the What's new block describes the build being served", () => {
  const match = html.match(/What's new — (lector \d+\.\d+\.\d+):/);
  assert.ok(match, "no What's new heading found in the flasher panel");
  assert.equal(
    match[1],
    publishedVersion,
    `the What's new block describes ${match[1]} while the site serves ${publishedVersion}`,
  );
});

test("the release history opens with the build being served", () => {
  const summaries = [...html.matchAll(/<summary>(lector \d+\.\d+\.\d+)<\/summary>/g)].map((m) => m[1]);
  assert.ok(summaries.length > 0, "the release history has no entries");
  assert.equal(
    summaries[0],
    publishedVersion,
    `the release history starts at ${summaries[0]} while the site serves ${publishedVersion}`,
  );
});

test("the release history has no gaps in its minor versions", () => {
  // A missing entry is how six releases went unrecorded. Patch numbers can be
  // skipped, since a patch is sometimes never published, but a missing minor
  // means a whole release went undescribed.
  const minors = [
    ...new Set(
      [...html.matchAll(/<summary>lector (\d+)\.(\d+)\.\d+<\/summary>/g)].map((m) => `${m[1]}.${m[2]}`),
    ),
  ];
  const asNumbers = minors.map((v) => v.split(".").map(Number));
  const [publishedMajor, publishedMinor] = numberOf(publishedVersion).split(".").map(Number);

  for (let minor = publishedMinor; minor >= 0; minor--) {
    const present = asNumbers.some(([major, m]) => major === publishedMajor && m === minor);
    // Stop at the oldest minor the history actually goes back to, rather than
    // demanding entries from before this panel existed.
    const olderExists = asNumbers.some(([major, m]) => major === publishedMajor && m < minor);
    if (!present && olderExists) {
      assert.fail(`the release history skips lector ${publishedMajor}.${minor}.x`);
    }
  }
});

test("the experimental section does not describe a build by hand", () => {
  // A hand-written "What to test in lector.exp.N" list outlived the build it
  // described, because that channel is republished far more often than this page.
  assert.doesNotMatch(
    html,
    /What to test in lector\.exp\.\d+/,
    "the experimental panel names a build literally; point at its release notes instead",
  );
  assert.match(html, /id="flashExperimentalVersion"/, "the experimental panel lost its version element");
});
