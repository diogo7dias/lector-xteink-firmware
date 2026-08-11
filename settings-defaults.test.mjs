import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("converter starts with the requested X3 defaults", () => {
  assert.match(html, /data-w="528" data-h="792" class="on">X3/);
  assert.match(html, /data-fmt="pxc" class="on">PXC/);
  assert.match(html, /option value="stretch" selected/);
  // Rendering starts on Auto: the per-image badge is now the place a picture that
  // Auto reads wrong gets corrected, so the global control no longer has to guess
  // one answer for every image in the batch.
  assert.match(html, /option value="auto" selected>Auto \(detect per image\)/);
  assert.doesNotMatch(html, /option value="threshold" selected/);
  assert.match(html, /id="segContrast">[\s\S]*?data-v="1" class="on">On/);
  assert.match(html, /id="segInvert">[\s\S]*?data-v="0" class="on">Off/);
  assert.match(html, /id="segDither">[\s\S]*?data-v="solid" class="on">Solid/);
  assert.match(html, /const S = \{ w:528, h:792, fmt:"pxc", fit:"stretch", mode:"auto", contrast:1, invert:0, ditherStyle:"solid"/);
});

// Classic against Solid is the comparison Diogo asked to have on the page, so the
// control must not be hidden and both buttons must be visible. Clean and Smooth
// lost that comparison: they stay in the row as hidden buttons, which is what
// ?dither=1 reveals, so restoring them is never a rewrite.
test("the dither picker offers Classic against Solid, on the page by default", () => {
  assert.match(html, /<div class="ctl" id="ctlDither">/);
  assert.doesNotMatch(html, /id="ctlDither" hidden/);
  assert.match(html, /data-v="classic">Classic/);
  assert.match(html, /data-v="solid" class="on">Solid/);
  assert.match(html, /data-v="clean" hidden>Clean/);
  assert.match(html, /data-v="smooth" hidden>Smooth/);
  assert.match(html, /querySelectorAll\('#segDither button\[hidden\]'\)/);
});

// The per-image rendering picker must stay a real <select> built from STYLES: one tap
// shows the whole list. A button that stepped one style at a time made finding the
// right rendering an eleven-tap hunt, which is what Diogo asked to be rid of.
test("the per-image badge lists every rendering in one dropdown", () => {
  assert.match(html, /createElement\("select"\); tag\.className="pill pill-toggle pill-style"/);
  assert.match(html, /for\(const s of STYLES\)\{[\s\S]*?o\.textContent=STYLE_LABEL\[s\]/);
  assert.match(html, /tag\.value=knownStyle\(conv\.style\)/);
  assert.match(html, /tag\.addEventListener\("change"/);
  assert.match(html, /\.pill-style\{width:auto;min-height:0/);
});
