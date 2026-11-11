// Render a text log (e.g. docs/evidence/.../p3-tests.log) as a terminal-style PNG for slides.
// usage: node terminal-shot.mjs --in file.log --out file.png [--title "..."] [--grep regex]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' },
  title: { type: 'string', default: '' }, grep: { type: 'string' } } });
let lines = readFileSync(a.in, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
if (a.grep) lines = lines.filter((l) => new RegExp(a.grep).test(l));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const color = (l) => /PASS|ALL CHECKS PASSED/.test(l) ? '#4ade80' : /FAIL/.test(l) ? '#f87171'
  : /^\[[\d:Z]+\] P3-|STOP|RESTORE/.test(l) ? '#facc15' : '#e5e7eb';
const html = `<html><body style="margin:0;background:#0b1020">
<div style="font:600 15px system-ui;color:#9ca3af;padding:14px 20px;border-bottom:1px solid #1f2937">● ● ●&nbsp;&nbsp; ${esc(a.title)}</div>
<pre style="margin:0;padding:16px 20px;font:14px/1.45 'DejaVu Sans Mono',monospace;white-space:pre-wrap">${
  lines.map((l) => `<span style="color:${color(l)}">${esc(l)}</span>`).join('\n')}</pre></body></html>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 400 }, deviceScaleFactor: 1.5 });
await page.setContent(html);
await page.screenshot({ path: a.out, fullPage: true });
await browser.close();
console.log(`saved ${a.out}`);
