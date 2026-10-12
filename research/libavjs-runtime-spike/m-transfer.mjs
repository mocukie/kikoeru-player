// 拋棄式 spike（#17）：VideoFrame 從 Worker transfer 回主執行緒，再 drawImage 到 2D canvas 的代價。
// 量：Worker 送出 → 主執行緒收到的延遲、drawImage 的同步耗時、每 10 張做一次 1px getImageData 強迫完成繪製的耗時、整體 fps。
import { pct, median } from "./lib.mjs";

export async function run({ file = "v1920x1080.h264", source = "decode", fps = 30, frames = 300 } = {}, log) {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const w = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  const lat = [], draw = [], readback = [];
  let first = 0, last = 0, n = 0, format = null;
  const result = await new Promise((res, rej) => {
    w.onerror = (e) => rej(new Error(e.message));
    w.onmessage = (e) => {
      const d = e.data;
      if (d.ready) { w.postMessage({ test: "vframes", params: { file, source, fps, frames } }); return; }
      if (d.vf) {
        const t = performance.timeOrigin + performance.now();
        lat.push(t - d.t);
        if (!first) first = t;
        format ??= d.vf.format;
        const t0 = performance.now();
        ctx.drawImage(d.vf, 0, 0, canvas.width, canvas.height);
        draw.push(performance.now() - t0);
        d.vf.close();
        if (++n % 10 === 0) { const t1 = performance.now(); ctx.getImageData(0, 0, 1, 1); readback.push(performance.now() - t1); }
        last = performance.timeOrigin + performance.now();
        w.postMessage("ack");
        return;
      }
      if (d.error) rej(new Error(d.error)); else if ("result" in d) res(d.result);
    };
  });
  w.terminate();
  const s = (a) => ({ p50: +median(a).toFixed(2), p95: +pct(a, 0.95).toFixed(2), max: +Math.max(...a).toFixed(2) });
  return { file, source, fps, frames: n, format, ...result, transferLatencyMs: s(lat), drawImageMs: s(draw), readback1pxMs: s(readback),
    achievedFps: +(n / ((last - first) / 1000)).toFixed(1) };
}
