const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);
async function audio() {
  const a = {};
  try {
    a.getAutoplayPolicy = navigator.getAutoplayPolicy ? navigator.getAutoplayPolicy('audiocontext') : 'n/a';
    const ctx = new AudioContext();
    a.stateAtCreate = ctx.state; a.sampleRate = ctx.sampleRate;
    a.baseLatency = ctx.baseLatency; a.outputLatency = ctx.outputLatency;
    a.hasAudioWorklet = !!ctx.audioWorklet;
    await ctx.audioWorklet.addModule('worklet.js');
    const node = new AudioWorkletNode(ctx, 'sine');
    let calls = 0; node.port.onmessage = e => { calls = e.data; };
    node.connect(ctx.destination);
    a.resume = await withTimeout(ctx.resume().then(() => 'resolved', e => 'rejected:' + e), 3000);
    const t0 = ctx.currentTime; await sleep(1500);
    a.stateAfter = ctx.state; a.currentTimeDelta = +(ctx.currentTime - t0).toFixed(3);
    a.workletProcessCalls = calls;
    if (ctx.getOutputTimestamp) { const ts = ctx.getOutputTimestamp(); a.outputTimestamp = { contextTime: ts.contextTime, perf: ts.performanceTime }; }
    await ctx.close();
  } catch (e) { a.error = String(e); }
  try {
    const off = new OfflineAudioContext(1, 48000, 48000);
    await off.audioWorklet.addModule('worklet.js');
    new AudioWorkletNode(off, 'sine').connect(off.destination);
    const buf = await off.startRendering();
    const d = buf.getChannelData(0); let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v));
    a.offlineWorkletPeak = +peak.toFixed(3);
  } catch (e) { a.offlineError = String(e); }
  if(0) try { const el = document.createElement('audio'); el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; a.htmlAudioPlay = await withTimeout(el.play().then(() => 'resolved', e => 'rejected:' + e.name), 3000); } catch (e) { a.htmlAudioPlay = 'threw:' + e; }
  return a;
}

window.runAudio = audio; window.__ready = true;
if (location.search.includes('auto')) audio().then(r => { window.__auto = r; });
document.getElementById('b').addEventListener('click', () => {
  if (location.search.includes('inhandler')) audio().then(r => { window.__click = r; });
  else setTimeout(() => audio().then(r => { window.__click = r; }), 500);
});
