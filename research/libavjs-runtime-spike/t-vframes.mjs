// 拋棄式 spike（#17）：Worker 端。解 H.264（或產生 CPU 的 I420 frame），把 VideoFrame transfer 給主執行緒。
// fps>0：以固定速率送入 decoder（模擬播放）；fps=0：盡快，主執行緒 ack 控制同時在途的 frame 數（≤ maxInFlight）。
import { accessUnits } from "./h264.mjs";

export async function run({ file = "v1920x1080.h264", source = "decode", fps = 30, maxInFlight = 4, frames = 300 } = {}, _p, self) {
  const [width, height] = file.match(/(\d+)x(\d+)/).slice(1).map(Number);
  let inFlight = 0, sent = 0;
  const queue = [];
  let acked = () => {};
  self.onmessage = (e) => { if (e.data === "ack") { inFlight--; pump(); acked(); } };
  const pump = () => {
    while (queue.length && (fps > 0 || inFlight < maxInFlight)) {
      const f = queue.shift();
      inFlight++; sent++;
      self.postMessage({ vf: f, t: performance.timeOrigin + performance.now() }, [f]);
    }
  };
  const done = () => new Promise((r) => { acked = () => { if (sent === frames && inFlight === 0) r(); }; acked(); });
  const t0 = performance.now();
  if (source === "decode") {
    const s = accessUnits(new Uint8Array(await (await fetch(`/media/${file}`)).arrayBuffer()));
    const dec = new VideoDecoder({ output: (f) => { queue.push(f); pump(); }, error: (e) => { throw e; } });
    dec.configure({ codec: s.codec, codedWidth: width, codedHeight: height, description: s.avcC });
    for (let i = 0; i < frames; i++) {
      const au = s.aus[i];
      dec.decode(new EncodedVideoChunk({ type: au.key ? "key" : "delta", timestamp: au.ts, data: au.avcc }));
      if (fps > 0) await new Promise((r) => setTimeout(r, 1000 / fps));
      else while (dec.decodeQueueSize > 4 || queue.length > 4) await new Promise((r) => setTimeout(r, 1));
    }
    await dec.flush();
    dec.close();
  } else {
    // CPU 上的 I420 frame（例如 wasm 軟解的輸出），transfer 的是記憶體裡的 buffer
    const buf = new Uint8Array(width * height * 3 / 2);
    for (let i = 0; i < frames; i++) {
      buf.fill(i & 255, 0, width * height);
      queue.push(new VideoFrame(buf, { format: "I420", codedWidth: width, codedHeight: height, timestamp: Math.round(i * 1e6 / 30) }));
      pump();
      if (fps > 0) await new Promise((r) => setTimeout(r, 1000 / fps));
      else while (queue.length > 4) await new Promise((r) => setTimeout(r, 1));
    }
  }
  await done();
  return { workerMs: +(performance.now() - t0).toFixed(0), sent };
}
