const B = '/site/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);

export async function audio() {
  const a = {};
  try {
    a.getAutoplayPolicy = navigator.getAutoplayPolicy ? navigator.getAutoplayPolicy('audiocontext') : 'n/a';
    const ctx = new AudioContext();
    a.stateAtCreate = ctx.state; a.sampleRate = ctx.sampleRate;
    a.baseLatency = ctx.baseLatency; a.outputLatency = ctx.outputLatency;
    a.hasAudioWorklet = !!ctx.audioWorklet;
    await ctx.audioWorklet.addModule(B + 'worklet.js');
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
    await off.audioWorklet.addModule(B + 'worklet.js');
    new AudioWorkletNode(off, 'sine').connect(off.destination);
    const buf = await off.startRendering();
    const d = buf.getChannelData(0); let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v));
    a.offlineWorkletPeak = +peak.toFixed(3);
  } catch (e) { a.offlineError = String(e); }
  try { const el = document.createElement('audio'); el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; a.htmlAudioPlay = await withTimeout(el.play().then(() => 'resolved', e => 'rejected:' + e.name), 3000); } catch (e) { a.htmlAudioPlay = 'threw:' + e; }
  return a;
}

function ivfFrames(buf) {
  const v = new DataView(buf); const hdr = v.getUint16(6, true); const out = []; let p = hdr;
  while (p + 12 <= buf.byteLength) { const sz = v.getUint32(p, true); out.push(new Uint8Array(buf, p + 12, sz)); p += 12 + sz; }
  return out;
}
function vp9Key(f) { const b = f[0]; return ((b >> 3) & 1) === 0 && ((b >> 2) & 1) === 0; }
function av1Key(f) { // look for sequence header OBU (type 1) in first few OBUs
  let p = 0; for (let k = 0; k < 3 && p < f.length; k++) { const h = f[p]; const type = (h >> 3) & 15; const ext = (h >> 2) & 1; const hasSize = (h >> 1) & 1;
    if (type === 1) return true; p += 1 + ext; if (!hasSize) break; let size = 0, shift = 0, b; do { b = f[p++]; size |= (b & 127) << shift; shift += 7; } while (b & 128); p += size; }
  return false;
}
function annexbNals(u8) { const nals = []; let i = 0, start = -1;
  while (i + 3 <= u8.length) { if (u8[i] === 0 && u8[i+1] === 0 && (u8[i+2] === 1 || (u8[i+2] === 0 && u8[i+3] === 1))) { const sc = u8[i+2] === 1 ? 3 : 4; if (start >= 0) nals.push(u8.subarray(start, i)); start = i + sc; i += sc; } else i++; }
  if (start >= 0) nals.push(u8.subarray(start)); return nals.map(n => { let e = n.length; while (e > 0 && n[e-1] === 0) e--; return n.subarray(0, e); }); }
function h264Units(buf) { const nals = annexbNals(new Uint8Array(buf)); const aus = []; let cur = null;
  for (const n of nals) { const t = n[0] & 31; if (t === 9) { cur = []; aus.push(cur); } else if (cur) cur.push(n); }
  let sps, pps; for (const n of nals) { const t = n[0] & 31; if (t === 7 && !sps) sps = n; if (t === 8 && !pps) pps = n; }
  const annexb = aus.map(au => { const parts = []; for (const n of au) { parts.push(new Uint8Array([0,0,0,1]), n); } const len = parts.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(len); let q = 0; for (const x of parts) { o.set(x, q); q += x.length; } return { data: o, key: au.some(n => (n[0] & 31) === 5) }; });
  const avcc = aus.map(au => { const sel = au.filter(n => ![7,8].includes(n[0] & 31)); const len = sel.reduce((s, n) => s + 4 + n.length, 0); const o = new Uint8Array(len); const dv = new DataView(o.buffer); let q = 0; for (const n of sel) { dv.setUint32(q, n.length); o.set(n, q + 4); q += 4 + n.length; } return { data: o, key: au.some(n => (n[0] & 31) === 5) }; });
  const desc = new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255, ...sps, 1, pps.length >> 8, pps.length & 255, ...pps]);
  return { annexb, avcc, desc };
}

async function decode(label, config, units) {
  const r = { label };
  try {
    for (const hw of [undefined, 'prefer-software', 'prefer-hardware']) {
      const c = { ...config }; if (hw) c.hardwareAcceleration = hw;
      try { const s = await VideoDecoder.isConfigSupported(c); r['supported' + (hw ? '_' + hw : '')] = s.supported; } catch (e) { r['supported' + (hw ? '_' + hw : '')] = 'threw:' + e.name; }
    }
    let frames = 0, err = null, first = null;
    const dec = new VideoDecoder({ output: f => { if (!first) { const cv = (document.getElementById('c') || Object.assign(document.body.appendChild(document.createElement('canvas')), { id: 'c', width: 320, height: 240 })); const g = cv.getContext('2d'); g.drawImage(f, 0, 0); const px = g.getImageData(0, 0, 320, 240).data; let sum = 0; for (let i = 0; i < px.length; i += 97) sum += px[i]; first = { fmt: f.format, w: f.codedWidth, h: f.codedHeight, pixelSum: sum }; } frames++; f.close(); }, error: e => { err = e.name + ': ' + e.message; } });
    dec.configure(config);
    units.forEach((u, i) => dec.decode(new EncodedVideoChunk({ type: u.key ? 'key' : 'delta', timestamp: i * 33333, data: u.data })));
    const fl = await withTimeout(dec.flush().then(() => 'ok', e => 'rejected:' + e.name + ': ' + e.message), 10000);
    r.flush = fl; r.chunks = units.length; r.framesOut = frames; r.firstFrame = first; if (err) r.error = err;
    try { dec.close(); } catch {}
  } catch (e) { r.threw = String(e); }
  return r;
}

export async function webcodecs() {
  const w = { VideoDecoder: typeof VideoDecoder, AudioDecoder: typeof AudioDecoder, VideoEncoder: typeof VideoEncoder };
  if (typeof VideoDecoder === 'undefined') return w;
  const get = async n => (await fetch(B + n)).arrayBuffer();
  const h = h264Units(await get('h264.264'));
  w.h264_annexb = await decode('h264 annexb', { codec: 'avc1.64001f', codedWidth: 320, codedHeight: 240 }, h.annexb);
  w.h264_avcc = await decode('h264 avcc', { codec: 'avc1.64001f', codedWidth: 320, codedHeight: 240, description: h.desc }, h.avcc);
  const vp9 = ivfFrames(await get('vp9.ivf')).map(d => ({ data: d, key: vp9Key(d) }));
  w.vp9 = await decode('vp9', { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 240 }, vp9);
  const av1 = ivfFrames(await get('av1.ivf')).map(d => ({ data: d, key: av1Key(d) }));
  w.av1 = await decode('av1', { codec: 'av01.0.00M.08', codedWidth: 320, codedHeight: 240 }, av1);
  w.audioConfigs = {};
  if (typeof AudioDecoder !== 'undefined') for (const [k, c] of Object.entries({ aac: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }, opus: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }, flac: { codec: 'flac', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([102,76,97,67,128,0,0,34,16,0,16,0,0,0,0,0,0,0,11,184,1,112,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]) }, mp3: { codec: 'mp3', sampleRate: 48000, numberOfChannels: 2 } })) {
    try { w.audioConfigs[k] = (await AudioDecoder.isConfigSupported(c)).supported; } catch (e) { w.audioConfigs[k] = 'threw:' + e.name; }
  }
  const v = document.createElement('video');
  w.canPlayType = { h264: v.canPlayType('video/mp4; codecs="avc1.64001f"'), vp9: v.canPlayType('video/webm; codecs="vp9"'), av1: v.canPlayType('video/mp4; codecs="av01.0.00M.08"'), aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"') };
  return w;
}

export function wasmWorker() { return withTimeout(new Promise(res => { const wk = new Worker(B + 'worker.js'); wk.onmessage = e => res(e.data); wk.onerror = e => res({ error: e.message }); wk.postMessage(0); }), 5000); }

