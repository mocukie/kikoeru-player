import { chromium, firefox, webkit } from 'playwright';
const bts = { chromium, firefox, webkit };
const fxVariants = [['default', {}], ['force_null_context', { 'media.cubeb.force_null_context': true }], ['force_mock_context', { 'media.cubeb.force_mock_context': true }], ['autoplay-default-0', { 'media.autoplay.default': 0 }]];
const only = (process.env.ONLY || 'chromium,firefox,webkit').split(',');
for (const name of only) for (const [vn, prefs] of (name === 'firefox' ? fxVariants : [['default', {}]])) for (const mode of ['auto-at-load', 'evaluate-later']) {
  const b = await bts[name].launch({ headless: true, ...(name === 'firefox' ? { firefoxUserPrefs: prefs } : {}) });
  const p = await b.newPage();
  let r;
  if (mode === 'auto-at-load') { await p.goto('http://localhost:8000/audio.html?auto'); await p.waitForFunction(() => window.__auto, null, { timeout: 20000 }); r = await p.evaluate(() => window.__auto); }
  else { await p.goto('http://localhost:8000/audio.html'); await p.waitForFunction(() => window.__ready); await new Promise(r => setTimeout(r, 1000)); r = await p.evaluate(() => window.runAudio()); }
  console.log(JSON.stringify({ env: process.env.ENVTAG, browser: name, variant: vn, mode, stateAtCreate: r.stateAtCreate, resume: r.resume, stateAfter: r.stateAfter, dt: r.currentTimeDelta, calls: r.workletProcessCalls, policy: r.getAutoplayPolicy, err: r.error }));
  await b.close();
}
