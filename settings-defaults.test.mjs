import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("converter starts with requested X3 line-art defaults", () => {
  assert.match(html, /data-w="528" data-h="792" class="on">X3/);
  assert.match(html, /data-fmt="pxc" class="on">PXC/);
  assert.match(html, /option value="stretch" selected/);
  assert.match(html, /option value="threshold" selected>Threshold \(line art\)/);
  assert.match(html, /id="segContrast">[\s\S]*?data-v="1" class="on">On/);
  assert.match(html, /id="segInvert">[\s\S]*?data-v="0" class="on">Off/);
  assert.match(html, /id="segDither">[\s\S]*?data-v="solid" class="on">Solid/);
  assert.match(html, /const S = \{ w:528, h:792, fmt:"pxc", fit:"stretch", mode:"threshold", contrast:1, invert:0, ditherStyle:"solid"/);
  // Solid is the only style offered, but the other three stay in the page so
  // restoring the choice is one attribute rather than a rewrite.
  assert.match(html, /id="ctlDither" hidden/);
  assert.match(html, /data-v="clean">Clean/);
  assert.match(html, /data-v="smooth">Smooth/);
  assert.match(html, /data-v="classic">Classic/);
});
