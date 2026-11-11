// Screenshot any URL; logs into Grafana first when the URL is on the Grafana host.
// usage: node url-shot.mjs --url <url> --out file.png [--width 1600] [--height 900] [--full] [--clip-selector css]
import { chromium } from 'playwright-core';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' }, width: { type: 'string', default: '1600' },
  height: { type: 'string', default: '900' }, full: { type: 'boolean', default: false }, selector: { type: 'string' }, wait: { type: 'string', default: '5000' } } });
const grafana = process.env.GRAFANA_URL ?? 'https://grafana.136-71-37-219.sslip.io';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: +a.width, height: +a.height }, deviceScaleFactor: 1.5, colorScheme: 'light' });
if (a.url.startsWith(grafana)) {
  await p.goto(`${grafana}/login`);
  await p.fill('input[name="user"]', process.env.GRAFANA_USER ?? 'admin');
  await p.fill('input[name="password"]', process.env.GRAFANA_PASSWORD);
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
}
await p.goto(a.url); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(+a.wait);
if (a.selector) await p.locator(a.selector).first().screenshot({ path: a.out });
else await p.screenshot({ path: a.out, fullPage: a.full });
await b.close(); console.log(`saved ${a.out}`);
