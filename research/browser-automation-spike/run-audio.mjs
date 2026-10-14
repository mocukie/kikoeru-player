import { chromium, firefox, webkit } from 'playwright';
const variants = {
  chromium: [['default', {}], ['autoplay-flag', { args: ['--autoplay-policy=no-user-gesture-required'] }]],
  firefox: [['default', {}], ['autoplay-prefs', { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } }]],
  webkit: [['default', {}]],
};
const bts = { chromium, firefox, webkit };
for (const [name, vs] of Object.entries(variants)) for (const [vn, opts] of vs) for (const gesture of [false, true]) {
  const b = await bts[name].launch({ headless: true, ...opts });
  const p = await b.newPage();
  await p.goto('http://localhost:8000/audio.html'); await p.waitForFunction(() => window.__ready);
  if (gesture) await p.click('#b');
  const r = await p.evaluate(() => window.runAudio());
  console.log(JSON.stringify({ env: process.env.ENVTAG, browser: name, variant: vn, gesture, stateAtCreate: r.stateAtCreate, resume: r.resume, stateAfter: r.stateAfter, dt: r.currentTimeDelta, calls: r.workletProcessCalls, policy: r.getAutoplayPolicy, err: r.error, offlinePeak: r.offlineWorkletPeak }));
  await b.close();
}
