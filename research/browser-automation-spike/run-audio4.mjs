import { chromium, firefox, webkit } from 'playwright';
const bts = { chromium, firefox, webkit };
for (const name of (process.env.ONLY || 'chromium,firefox,webkit').split(',')) for (const q of ['inhandler', 'sticky']) {
  const b = await bts[name].launch({ headless: true }); const p = await b.newPage();
  await p.goto('http://localhost:8000/audio.html?' + q); await p.waitForFunction(() => window.__ready);
  await p.click('#b'); await p.waitForFunction(() => window.__click, null, { timeout: 20000 }); const r = await p.evaluate(() => window.__click);
  console.log(JSON.stringify({ env: process.env.ENVTAG, browser: name, mode: 'after-real-click-' + q, stateAtCreate: r.stateAtCreate, resume: r.resume, stateAfter: r.stateAfter, dt: r.currentTimeDelta, calls: r.workletProcessCalls }));
  await b.close();
}
