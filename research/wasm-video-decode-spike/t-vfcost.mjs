// 拋棄式 spike（#20）：在 Worker 內由 CPU buffer 建立 VideoFrame 的代價（模擬 wasm 軟解的輸出），以及 10-bit 支援。
// 每種組合建 n 張，量 new VideoFrame 的同步耗時；另量「帶 stride 的 plane → 緊密 I420」的 JS 複製、10-bit → 8-bit 右移的耗時。
import { stat } from "./lib.mjs";

export async function run({ n = 200, sizes = [[1280, 720], [1920, 1080]] } = {}) {
  const out = [];
  for (const [w, h] of sizes) {
    const cw = w >> 1, ch = h >> 1, px = w * h + 2 * cw * ch;
    const cases = [
      ["I420", 1, false], ["I420", 1, true], ["NV12", 1, false], ["I420P10", 2, false], ["I420P10", 2, true],
    ];
    for (const [format, bps, transfer] of cases) {
      const t = [];
      let err = null, got = null;
      for (let i = 0; i < n && !err; i++) {
        const buf = new Uint8Array(px * bps);
        buf.fill(i & 255, 0, w * h * bps);
        const t0 = performance.now();
        try {
          const vf = new VideoFrame(buf, { format, codedWidth: w, codedHeight: h, timestamp: i * 33333, ...(transfer && { transfer: [buf.buffer] }) });
          t.push(performance.now() - t0);
          got ??= vf.format;
          vf.close();
        } catch (e) { err = `${e.name}: ${e.message}`; }
      }
      out.push({ w, h, format, transfer, ok: !err, err, resultFormat: got, newVideoFrameMs: stat(t) });
    }
    // 取出成本：模擬 dav1d 的 frame（stride 對齊 64 byte）→ 緊密 I420
    const stride = (x) => Math.ceil(x / 64) * 64;
    const heap8 = new Uint8Array(stride(w) * h + 2 * stride(cw) * ch);
    const heap16 = new Uint8Array((stride(w * 2) * h + 2 * stride(cw * 2) * ch));
    const planes = [[w, h], [cw, ch], [cw, ch]];
    const copy8 = [], conv10 = [];
    for (let i = 0; i < n; i++) {
      let t0 = performance.now();
      const o8 = new Uint8Array(px); let o = 0, base = 0;
      for (const [pw, ph] of planes) { const s = stride(pw); for (let y = 0; y < ph; y++) { o8.set(heap8.subarray(base + y * s, base + y * s + pw), o); o += pw; } base += s * ph; }
      copy8.push(performance.now() - t0);
      t0 = performance.now();
      const h16 = new Uint16Array(heap16.buffer);
      const o10 = new Uint8Array(px); o = 0; base = 0;
      for (const [pw, ph] of planes) { const s = stride(pw * 2) >> 1; for (let y = 0; y < ph; y++) { let k = base + y * s; for (let x = 0; x < pw; x++) o10[o++] = h16[k++] >> 2; } base += s * ph; }
      conv10.push(performance.now() - t0);
    }
    out.push({ w, h, copyStrided8To_I420Ms: stat(copy8), convert10to8Ms: stat(conv10) });
  }
  return out;
}
