import { test } from 'vitest';
import { userEvent, page } from 'vitest/browser';
import { audio, webcodecs, wasmWorker } from '../site/lib.js';
const tag = () => `[${navigator.userAgent.match(/(Firefox|Chrome|Version)\/[\d.]+/)?.[0]}]`;
const brief = a => ({ policy: a.getAutoplayPolicy, stateAtCreate: a.stateAtCreate, resume: a.resume, stateAfter: a.stateAfter, dt: a.currentTimeDelta, calls: a.workletProcessCalls, err: a.error, offlinePeak: a.offlineWorkletPeak });
test('audio without gesture', async () => { console.log('RES', tag(), 'audio-no-gesture', JSON.stringify(brief(await audio()))); }, 30000);
test('audio after userEvent.click', async () => {
  const b = document.createElement('button'); b.textContent = 'go'; document.body.appendChild(b);
  await userEvent.click(b);
  console.log('RES', tag(), 'audio-after-click', JSON.stringify(brief(await audio())));
}, 30000);
test('webcodecs', async () => { const w = await webcodecs(); const o = {}; for (const [k, v] of Object.entries(w)) o[k] = v && v.label ? [v.supported, v.framesOut, v.error || '', v.firstFrame && v.firstFrame.fmt, v['supported_prefer-hardware']] : v; console.log('RES', tag(), 'webcodecs', JSON.stringify(o)); }, 60000);
test('wasm worker', async () => { console.log('RES', tag(), 'wasm', JSON.stringify(await wasmWorker())); });
