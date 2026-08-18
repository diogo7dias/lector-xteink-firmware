import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderGuide, renderMarkdown } from "./scripts/build-guide.mjs";

// The guide page is generated from USER_GUIDE.md in the firmware repository, so
// nothing on the site restates what the firmware does. These tests pin the two
// jobs that generation has to do: turn the markdown the guide actually uses into
// the site's markup, and refuse to build a page that describes a different
// firmware build than the one this site serves.

test("headings become anchored sections", () => {
  const html = renderMarkdown("## 2. Power & Startup\n");
  assert.match(html, /<h2 id="2-power-startup">2\. Power &amp; Startup<\/h2>/);
});

test("paragraphs carry bold, inline code and links", () => {
  const html = renderMarkdown("Press **Menu**, then `OK`, see [the docs](https://example.com/a).\n");
  assert.match(html, /<strong>Menu<\/strong>/);
  assert.match(html, /<code>OK<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a">the docs<\/a>/);
});

test("fenced code blocks keep their contents verbatim", () => {
  const html = renderMarkdown("```bash\nidf.py monitor | grep -i \"heap\"\n```\n");
  assert.match(html, /<pre><code class="lang-bash">idf\.py monitor \| grep -i &quot;heap&quot;\n<\/code><\/pre>/);
});

test("tables become real tables", () => {
  const html = renderMarkdown("| Location | Buttons |\n| --- | --- |\n| Right edge | Up, Down |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>Location<\/th>/);
  assert.match(html, /<td>Right edge<\/td>/);
});

test("nested list items stay nested", () => {
  const html = renderMarkdown("- Settings\n  - Display\n- Reader\n");
  assert.match(html, /<ul>\s*<li>Settings\s*<ul>\s*<li>Display<\/li>\s*<\/ul>\s*<\/li>\s*<li>Reader<\/li>\s*<\/ul>/);
});

test("markdown the renderer does not understand fails the build", () => {
  assert.throws(
    () => renderMarkdown("<details>a raw HTML block the renderer has never been taught</details>\n"),
    /unsupported markdown/i,
  );
});

test("a guide stamped for another build fails to render", () => {
  const markdown = "<!-- lector-version: 0.23.0 -->\n\n# Lector User Guide\n";
  assert.throws(
    () => renderGuide(markdown, { publishedVersion: "lector 0.24.0" }),
    /0\.23\.0.*0\.24\.0/s,
  );
});

test("an unstamped guide fails to render", () => {
  assert.throws(
    () => renderGuide("# Lector User Guide\n", { publishedVersion: "lector 0.24.0" }),
    /lector-version/,
  );
});

test("a matching stamp renders a full page", () => {
  const markdown = "<!-- lector-version: 0.24.0 -->\n\n# Lector User Guide\n\nWelcome.\n";
  const html = renderGuide(markdown, { publishedVersion: "lector 0.24.0" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<h1 id="lector-user-guide">Lector User Guide<\/h1>/);
  assert.match(html, /<p>Welcome\.<\/p>/);
});

test("a bare number in prose is not mistaken for a code span", () => {
  const html = renderMarkdown("Hold `OK` for 3 seconds, then wait 0 more.\n");
  assert.match(html, /<code>OK<\/code>/);
  assert.match(html, /for 3 seconds, then wait 0 more\./);
});

test("GitHub alert blockquotes become callouts", () => {
  const html = renderMarkdown("> [!NOTE]\n> Screenshots land in `/screenshots`.\n");
  assert.match(html, /<aside class="callout callout-note">/);
  assert.match(html, /<p class="callout-label">Note<\/p>/);
  assert.match(html, /<code>\/screenshots<\/code>/);
});

test("a plain blockquote becomes a quote", () => {
  const html = renderMarkdown("> Hold the button.\n");
  assert.match(html, /<blockquote>\s*<p>Hold the button\.<\/p>\s*<\/blockquote>/);
});

test("a raw img tag passes through, other raw HTML does not", () => {
  const html = renderMarkdown('<img width="420" alt="Home screen" src="https://example.com/a.png" />\n');
  assert.match(html, /<p><img width="420" alt="Home screen" src="https:\/\/example\.com\/a\.png" \/><\/p>/);
  assert.throws(() => renderMarkdown('<script>alert(1)</script>\n'), /unsupported markdown/i);
});

test("the deploy workflow builds the guide before publishing", () => {
  const workflow = readFileSync(new URL("./.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /USER_GUIDE\.md/, "the deploy no longer fetches the guide from the firmware repository");
  assert.match(workflow, /scripts\/build-guide\.mjs/, "the deploy no longer renders guide.html");
});

test("backslash-escaped punctuation loses the backslash", () => {
  const html = renderMarkdown("Power \\& Startup, a pipe \\| and an asterisk \\*.\n");
  assert.match(html, /<p>Power &amp; Startup, a pipe \| and an asterisk \*\.<\/p>/);
});

test("the tools page links to the guide", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /href="\.\/guide\.html"/, "index.html no longer links to the firmware guide");
});
