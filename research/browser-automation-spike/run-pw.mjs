import { chromium, firefox, webkit } from 'playwright';
const which = process.argv.slice(2);
for (const [name, bt] of Object.entries({ chromium, firefox, webkit })) {
  if (which.length && !which.includes(name)) continue;
  const b = await bt.launch({ headless: true });
  const p = await b.newPage();
  p.on('console', m => m.type() === 'error' && console.error(name, 'console:', m.text()));
  await p.goto('http://localhost:8000/');
  try { await p.waitForFunction(() => window.__done, null, { timeout: 60000 }); console.log(JSON.stringify({ browser: name, version: b.version(), ...(await p.evaluate(() => window.__results)) }, null, 1)); }
  catch (e) { console.log(name, 'FAILED', e.message); }
  await b.close();
}
