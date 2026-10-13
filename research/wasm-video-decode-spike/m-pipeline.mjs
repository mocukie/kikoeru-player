// 拋棄式 spike（#20，沿用 #17 的 m-transfer）：Engine 的完整影片路徑
//   Worker：dav1d 解碼 → 從 wasm heap 取出 I420（10-bit 轉 8-bit）→ new VideoFrame → transfer
//   主執行緒：drawImage 到 1280×720 的 2D canvas → close → ack（在途 ≤ maxInFlight）；每 10 張做一次 1px getImageData 強迫完成繪製。
// 不限速，量整條管線能跑到的 fps 與各段耗時。
import { runInWorker } from "./main.mjs";
import { stat } from "./lib.mjs";

export async function run(params = {}) {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const lat = [], draw = [], readback = [];
  let first = 0, last = 0, n = 0, format = null;
  const result = await runInWorker("decode", { ...params, out: "post" }, (d, w) => {
    if (!d.vf) return false;
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
    return true;
  });
  return { ...result, drawn: n, drawnFormat: format, transferLatencyMs: stat(lat), drawImageMs: stat(draw), readback1pxMs: stat(readback),
    pipelineFps: +(n / ((last - first) / 1000)).toFixed(1) };
}
