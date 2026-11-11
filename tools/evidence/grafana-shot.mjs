// Screenshot a Grafana dashboard (or a single panel) for a fixed time window.
// usage: node grafana-shot.mjs --out file.png --from <epoch ms|now-1h> --to <epoch ms|now>
//          [--env pfd-prod] [--panel <id>] [--width 1600] [--height 2400] [--path /d/pfd-overview]
// Credentials: GRAFANA_URL, GRAFANA_USER (default admin), GRAFANA_PASSWORD
import { chromium } from 'playwright-core';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: {
  out: { type: 'string' }, from: { type: 'string', default: 'now-1h' }, to: { type: 'string', default: 'now' },
  env: { type: 'string', default: 'pfd-prod' }, panel: { type: 'string' }, path: { type: 'string', default: '/d/pfd-overview' },
  width: { type: 'string', default: '1600' }, height: { type: 'string', default: '2600' },
} });
const base = process.env.GRAFANA_URL ?? 'https://grafana.136-71-37-219.sslip.io';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: +a.width, height: a.panel ? 500 : +a.height }, deviceScaleFactor: 1.5 });
await page.goto(`${base}/login`);
await page.fill('input[name="user"]', process.env.GRAFANA_USER ?? 'admin');
await page.fill('input[name="password"]', process.env.GRAFANA_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'));
const q = new URLSearchParams({ from: a.from, to: a.to, 'var-namespace': a.env, kiosk: '1', theme: 'light' });
if (a.panel) q.set('viewPanel', a.panel);
await page.goto(`${base}${a.path}?${q}`);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(4000); // let panels finish rendering
await page.screenshot({ path: a.out, fullPage: !a.panel });
await browser.close();
console.log(`saved ${a.out}`);
