import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const readJson = (p) => JSON.parse(read(p));

// The flasher UI now lives as a tab inside the main site page.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const redirect = read("./index.html");
const update = readJson("./manifest-update.json");
const full = readJson("./manifest-full.json");

// Flash offsets are dictated by the device partition table (partitions.csv in the
// lector repo). If these change, the firmware will not boot — treat them as fixed.
const OFFSET = { bootloader: 0, partitions: 0x8000, boot_app0: 0xe000, app: 0x10000 };

test("update manifest keeps user data: no erase, no bootloader/partition write", () => {
  assert.equal(update.erase, false);
  const parts = update.builds[0].parts;
  assert.equal(update.builds[0].chipFamily, "ESP32-C3");
  const byPath = Object.fromEntries(parts.map((p) => [p.path, p.offset]));
  // Only OTA-data reset + app. Never the bootloader or partition table (those
  // would require a full erase / can brick a live device).
  assert.deepEqual(Object.keys(byPath).sort(), [
    "firmware/latest/boot_app0.bin",
    "firmware/latest/firmware.bin",
  ]);
  assert.equal(byPath["firmware/latest/boot_app0.bin"], OFFSET.boot_app0);
  assert.equal(byPath["firmware/latest/firmware.bin"], OFFSET.app);
});

test("full manifest reflashes all four parts at the correct offsets, erase first", () => {
  assert.equal(full.erase, true);
  const parts = full.builds[0].parts;
  assert.equal(full.builds[0].chipFamily, "ESP32-C3");
  assert.equal(parts.length, 4);
  const byPath = Object.fromEntries(parts.map((p) => [p.path, p.offset]));
  assert.equal(byPath["firmware/latest/bootloader.bin"], OFFSET.bootloader);
  assert.equal(byPath["firmware/latest/partitions.bin"], OFFSET.partitions);
  assert.equal(byPath["firmware/latest/boot_app0.bin"], OFFSET.boot_app0);
  assert.equal(byPath["firmware/latest/firmware.bin"], OFFSET.app);
  assert.deepEqual(
    parts.map((p) => p.offset).sort((a, b) => a - b),
    [0, 32768, 57344, 65536],
  );
});

test("only full installs erase; every Update mode keeps data", () => {
  // erase is limited to the full-flash install (rescue). Every Update mode
  // (the app-only Lector update) must never erase.
  assert.match(html, /const erase\s*=\s*mode\s*===\s*"rescue"/);
  assert.match(html, /eraseAll\s*:\s*erase/);
  assert.doesNotMatch(html, /esp-web-tools/);
});

test("writes stay compressed — esptool-js 0.5.7 has no uncompressed path", () => {
  // compress:false throws 'Yet to handle Non Compressed writes' in esptool-js,
  // so the write MUST be compressed. Guard against a regression.
  assert.match(html, /compress\s*:\s*true/);
  assert.doesNotMatch(html, /compress\s*:\s*false/);
});

test("reboot uses loader.after() and never fails a completed flash", () => {
  // esptool-js 0.5.7 resets via loader.after(), not loader.hardReset().
  assert.match(html, /loader\.after\(/);
  // The reset must be wrapped so a reboot hiccup does not report the flash failed.
  assert.match(html, /catch\s*\(\s*resetErr\s*\)/);
});

test("page exposes the Flasher tab wired to esptool-js", () => {
  assert.match(html, /data-view="flash"/);
  assert.match(html, /id="view-flash"/);
  assert.match(html, /esptool-js@0\.5\.7\/bundle\.js/);
  assert.match(html, /id="btnUpdate"/);
  assert.match(html, /id="btnRescue"/);
  assert.match(html, /flash\/manifest-update\.json/);
  assert.match(html, /flash\/manifest-full\.json/);
});

test("Flasher tab opens from a #flash deep link", () => {
  assert.match(html, /location\.hash===?"#flash"/);
});

test("the old /flash/ URL redirects into the tab", () => {
  assert.match(redirect, /url=\.\.\/#flash/);
  assert.match(redirect, /location\.replace\("\.\.\/#flash"\)/);
});

test("version.txt is a stable lector version string", () => {
  const v = read("./version.txt").trim();
  // Naming from 2026-08-03: stable builds are "lector X.Y.Z"; the "lector.c" prefix
  // is retired. The legacy form is still accepted because the currently published
  // stable build predates the change; drop that alternative once the next stable
  // publish lands. Either way this must never carry an experimental name.
  assert.match(v, /^lector(\.c)? \d+\.\d+\.\d+$/);
});

test("the full-erase flash is presented as a first-time install, not only a rescue", () => {
  // A device that does not have Lector yet needs the full flash (its stock
  // partition table differs, so an app-only Update will not boot). That path
  // must be discoverable as a first-time install, and the Update path must still
  // state it needs Lector already present.
  assert.match(html, /Install on a new device/i);
  assert.match(html, /does not have Lector yet/i);
  assert.match(html, /already be[\s\S]*?running Lector/i);
});

test("a completed flash tells the user to reboot by hand", () => {
  // The X3/X4 ignore the USB reset line, so the flasher must NOT claim it is
  // auto-rebooting; it must instruct a manual Reset + Power. Guard against a
  // regression back to the misleading "rebooting into the new build" message.
  assert.match(html, /press Reset, then Power/i);
  assert.doesNotMatch(html, /is rebooting into the new build/);
});

// --- Experimental build ---------------------------------------------------
// The experimental build is a SEPARATE payload from the stable one. It must never
// erase, never touch the bootloader or partition table, and never read from
// firmware/latest/ — otherwise flashing it would overwrite the user's way back.
const experimental = readJson("./manifest-experimental.json");

test("experimental manifest keeps user data and is fully separate from the stable build", () => {
  assert.equal(experimental.erase, false);
  assert.equal(experimental.builds[0].chipFamily, "ESP32-C3");
  const parts = experimental.builds[0].parts;
  const byPath = Object.fromEntries(parts.map((p) => [p.path, p.offset]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    "firmware/experimental/boot_app0.bin",
    "firmware/experimental/firmware.bin",
  ]);
  assert.equal(byPath["firmware/experimental/boot_app0.bin"], OFFSET.boot_app0);
  assert.equal(byPath["firmware/experimental/firmware.bin"], OFFSET.app);
  // The stable payload must stay reachable so "Update my reader" is a real way back.
  for (const p of parts) assert.ok(!p.path.includes("firmware/latest/"), p.path);
});

test("the experimental button is wired, confirmed, and warns it is untested", () => {
  assert.match(html, /id="btnExperimental"/);
  assert.match(html, /runFlash\("experimental"\)/);
  assert.match(html, /manifest-experimental\.json/);
  // It must sit behind a confirm(), like the erase flash does.
  const at = html.indexOf('getElementById("btnExperimental").addEventListener');
  assert.notEqual(at, -1, "experimental click handler not found");
  assert.match(html.slice(at, at + 600), /confirm\(/);
  // Durable safety claims, checked by meaning rather than one exact sentence so
  // rewording the section does not quietly drop the warning: the confirm must say
  // the build is untested and must name what it changes, and the page must offer a
  // way back. The specific risk sentence is NOT asserted here — it belongs to
  // whichever build is on the channel, and an assertion on last build's wording
  // pushes the next one into repeating a claim that is not true of it.
  assert.match(html, /not been tested on a device/i);
  assert.match(html, /It changes /i);
  assert.match(html, /To go back, press <strong>Update my reader<\/strong>/);
});

test("a busy flash disables the experimental button too", () => {
  const fn = html.slice(html.indexOf("function setButtonsDisabled"));
  assert.match(fn.slice(0, 400), /btnExperimental/);
});

test("experimental-version.txt is an experimental lector version string", () => {
  const v = read("./experimental-version.txt").trim();
  // Naming from 2026-08-03: experimental builds are "lector.exp.N", a plain counter
  // that never resets. The guard is unchanged in purpose -- a stable "lector 0.8.4"
  // must never appear on the experimental button, because that button is where
  // untested firmware lives. The old "lector.c X.Y.Z-suffix" form is retired.
  assert.match(v, /^lector\.exp\.\d+$/);
  // It must not claim to be the stable build.
  assert.notEqual(v, read("./version.txt").trim());
});
