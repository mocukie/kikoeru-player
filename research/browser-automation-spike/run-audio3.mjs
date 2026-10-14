import { chromium } from 'playwright';
for (const args of [[], ['--autoplay-policy=no-user-gesture-required']]) {
  const b = await chromium.launch({ headless: true, args }); const p = await b.newPage();
  await p.goto('http://localhost:8000/audio.html?auto'); await p.waitForFunction(() => window.__auto, null, { timeout: 20000 }); const r = await p.evaluate(() => window.__auto);
  console.log(JSON.stringify({ env: process.env.ENVTAG, browser: 'chromium', args, mode: 'auto-at-load', stateAtCreate: r.stateAtCreate, resume: r.resume, stateAfter: r.stateAfter, calls: r.workletProcessCalls }));
  await b.close();
}
