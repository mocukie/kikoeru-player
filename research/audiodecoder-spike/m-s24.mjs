// 拋棄式 spike（#18）：Chromium 解 pcm-s24 時 renderer crash 的最小重現（不經 libav.js）。
// params：{rate, ch, frames, chunks, codec}
export async function run({ rate = 48000, ch = 2, frames = 1024, chunks = 4, codec = "pcm-s24", copy = null } = {}, log) {
  const bps = { "pcm-s24": 3, "pcm-s16": 2, "pcm-s32": 4, "pcm-f32": 4, "pcm-u8": 1 }[codec];
  let outputs = 0, error = null;
  let fmt = null;
  const dec = new AudioDecoder({ output: (ad) => {
    outputs++; fmt = ad.format;
    // copy："f32-planar" 等格式轉換，或 "native"（不指定 format）
    if (copy) { const opt = copy === "native" ? { planeIndex: 0 } : { planeIndex: 0, format: copy }; const buf = new ArrayBuffer(ad.allocationSize(opt)); ad.copyTo(buf, opt); }
    ad.close(); }, error: (e) => { error = `${e.name}: ${e.message}`; } });
  dec.configure({ codec, sampleRate: rate, numberOfChannels: ch });
  for (let i = 0; i < chunks; i++) {
    const data = new Uint8Array(frames * ch * bps); // 靜音
    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(i * frames / rate * 1e6), data }));
  }
  await dec.flush().catch((e) => { error ??= String(e); });
  log(`${codec} ${rate}/${ch} copy=${copy}: outputs ${outputs} format ${fmt} ${error ?? ""}`);
  return { outputs, format: fmt, error };
}
