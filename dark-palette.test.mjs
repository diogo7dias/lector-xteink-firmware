import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const darkBlock = html.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\n  \}/)?.[1] ?? "";

function token(name) {
  const value = darkBlock.match(new RegExp(`--${name}:#([0-9a-f]{6})`, "i"))?.[1];
  assert.ok(value, `missing dark token --${name}`);
  return value;
}

function luminance(hex) {
  const channels = hex.match(/../g).map(part => Number.parseInt(part, 16) / 255);
  const linear = channels.map(channel => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function expectContrast(foreground, background, minimum) {
  const ratio = contrast(token(foreground), token(background));
  assert.ok(ratio >= minimum, `${foreground}/${background} was ${ratio.toFixed(2)}:1`);
}

test("dark palette keeps all text roles readable without pure white", () => {
  expectContrast("text", "paper", 7);
  expectContrast("sub", "paper", 4.5);
  expectContrast("ink", "paper", 4.5);
  expectContrast("on-ink", "ink", 4.5);
  expectContrast("accent-ink", "yellow", 4.5);
  expectContrast("on-red", "red", 4.5);
  expectContrast("hero-text", "hero-bg", 7);
  expectContrast("hero-sub", "hero-bg", 4.5);
  assert.doesNotMatch(darkBlock, /#(?:fff|ffffff)\b/i);
});

test("components use semantic inverse and accent text colors", () => {
  assert.match(html, /\.tab\.on\{background:var\(--ink\);color:var\(--on-ink\);\}/);
  assert.match(html, /\.seg button\.on\{background:var\(--ink\);color:var\(--on-ink\);\}/);
  assert.match(html, /\.hero\{[^}]*background:var\(--hero-bg\);color:var\(--hero-text\);/);
  assert.match(html, /\.gsize\{[^}]*color:var\(--accent-ink\);/);
});

test("borders and shadows are drawn with their own tokens, never the text ink", () => {
  expectContrast("line", "paper", 1.5);
  const lineRatio = contrast(token("line"), token("text"));
  assert.ok(lineRatio >= 2, `--line was only ${lineRatio.toFixed(2)}:1 from --text, so borders still read as text ink`);
  for (const file of ["index.html", "guide.html"]) {
    const markup = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(markup, /border[a-z-]*\s*:[^;{}]*var\(--ink\)/,
      `${file} paints a border with --ink; use --line`);
    assert.doesNotMatch(markup, /box-shadow\s*:[^;{}]*var\(--ink\)/,
      `${file} paints a shadow with --ink; use --shadow`);
  }
});
