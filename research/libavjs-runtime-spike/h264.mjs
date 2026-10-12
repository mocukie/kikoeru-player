// 拋棄式 spike（#17）：H.264 Annex B 原始串流的最小解析（AUD 分 access unit）與 Annex B → AVCC／avcC 轉換。
export function nals(u8) {
  const out = [];
  let i = 0, start = -1;
  while (i + 3 <= u8.length) {
    if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
      const sc = u8[i + 2] === 1 ? 3 : 4;
      if (start >= 0) out.push({ body: u8.subarray(start, i) });
      start = i + sc;
      i += sc;
    } else i++;
  }
  if (start >= 0) out.push({ body: u8.subarray(start) });
  return out.map((n) => ({ type: n.body[0] & 0x1f, body: n.body }));
}

// 以 AUD（type 9）切 access unit；回傳 Annex B 原樣的 chunk、AVCC chunk、keyframe 與 SPS／PPS
export function accessUnits(u8) {
  const ns = nals(u8);
  const aus = [];
  let cur = null, sps = null, pps = null;
  for (const n of ns) {
    if (n.type === 7 && !sps) sps = n.body;
    if (n.type === 8 && !pps) pps = n.body;
    if (n.type === 9 || !cur) { cur = { nals: [] }; aus.push(cur); }
    cur.nals.push(n);
  }
  return {
    sps, pps,
    codec: "avc1." + [...sps.subarray(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    aus: aus.map((a, i) => ({
      key: a.nals.some((n) => n.type === 5),
      hasSps: a.nals.some((n) => n.type === 7),
      annexb: concat(a.nals.flatMap((n) => [new Uint8Array([0, 0, 0, 1]), n.body])),
      annexbNoPs: concat(a.nals.filter((n) => n.type !== 7 && n.type !== 8).flatMap((n) => [new Uint8Array([0, 0, 0, 1]), n.body])),
      avcc: concat(a.nals.flatMap((n) => [be32(n.body.length), n.body])),
      ts: Math.round(i * 1e6 / 30),
    })),
    avcC: concat([new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), be16(sps.length), sps,
      new Uint8Array([1]), be16(pps.length), pps]),
  };
}
const be32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const be16 = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 解完整條串流，回報 output 數、錯誤與耗時
export async function decodeAll(stream, mode, { width, height, onFrame } = {}) {
  const config = { codec: stream.codec, codedWidth: width, codedHeight: height,
    ...(mode === "avcc" && { description: stream.avcC }) };
  const r = { mode, config: { ...config, description: config.description ? `${config.description.length}B avcC` : undefined } };
  try { r.isConfigSupported = (await VideoDecoder.isConfigSupported(config)).supported; }
  catch (e) { r.isConfigSupported = `threw ${e.name}: ${e.message}`; }
  let outputs = 0, error = null;
  const dec = new VideoDecoder({
    output: (f) => { outputs++; onFrame ? onFrame(f) : f.close(); },
    error: (e) => { error = `${e.name}: ${e.message}`; },
  });
  const t0 = performance.now();
  try {
    dec.configure(config);
    for (const au of stream.aus) {
      if (dec.state !== "configured") break;
      dec.decode(new EncodedVideoChunk({ type: au.key ? "key" : "delta", timestamp: au.ts, data: { avcc: au.avcc, annexb: au.annexb, "annexb-nops": au.annexbNoPs }[mode] }));
    }
    if (dec.state === "configured") await dec.flush();
  } catch (e) { error ??= `${e.name}: ${e.message}`; }
  r.ms = +(performance.now() - t0).toFixed(0);
  r.inputs = stream.aus.length; r.outputs = outputs; r.error = error; r.state = dec.state;
  if (dec.state !== "closed") dec.close();
  return r;
}
