import fs from "node:fs";
import assert from "node:assert/strict";

const css = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
}
function luminance(color) {
  const [r, g, b] = color.slice(1).match(/../g).map((hex) => parseInt(hex, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}
const dark = tokens(":root");
const light = { ...dark, ...tokens(':root[data-theme="light"]') };
const pairs = [
  ["text", "bg"], ["text", "panel"], ["text", "panel-2"],
  ["muted", "bg"], ["muted", "panel"], ["muted", "panel-2"],
  ["accent", "bg"], ["accent", "panel"], ["accent", "accent-subtle"],
  ["accent-contrast", "accent-solid"], ["good", "good-subtle"],
  ["warn", "warn-subtle"], ["bad", "bad-subtle"]
];
let checks = 0;
for (const [name, theme] of [["dark", dark], ["light", light]]) {
  for (const [foreground, background] of pairs) {
    assert.ok(theme[foreground] && theme[background]);
    const a = luminance(theme[foreground]), b = luminance(theme[background]);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, `${name} ${foreground}/${background}: ${ratio.toFixed(2)} < WCAG AA 4.5`);
    checks++;
  }
}
console.log(JSON.stringify({ ok: true, checks, standard: "WCAG AA text token pairs", offline: true }));
