// 拋棄式 spike（#20）：dav1d 解碼吞吐量。在 module Worker（瀏覽器）或 Node 跑。
// 流程：kikoeru-af 把整個 MP4 demux 成封包（不計時）→ 指定的 dav1d wasm 逐封包解碼並計時。
// params：
//   file, flavor（oz／o3／o3s）, noasy, target（wasm／thr）, threads, maxFrameDelay, skip（"nonref"）, grain（false＝不套 grain）
//   out："none"（只解碼）／"copy"（取出 I420，10-bit 轉 8-bit）／"copy10"（10-bit 保留 I420P10）／"vf"（再建 VideoFrame 後 close）／
//        "post"（建 VideoFrame 並 transfer 給主執行緒，主執行緒 ack 控制在途數）
//   frames（最多解幾個 frame）, warm（前幾個 frame 不計入統計）, pool（thr 時覆寫 navigator.hardwareConcurrency 以控制 pthread pool 大小）
import { createLibAV, demuxAll, stat } from "./lib.mjs";
import { openDecoder, closeDecoder, decodePacket, copyoutI420 } from "./dec.mjs";

export async function run(p = {}, progress = () => {}, self = null) {
  const { file, variant = "kikoeru-dav1d", flavor = "oz", noasy = false, target = "wasm", threads = 1, maxFrameDelay = 0, skip = null, grain = null,
    out = "none", frames = 1e9, warm = 10, maxInFlight = 4, pool = null } = p;
  if (target === "thr" && pool && typeof navigator !== "undefined") {
    Object.defineProperty(Object.getPrototypeOf(navigator), "hardwareConcurrency", { get: () => pool, configurable: true });
  }
  // thr build 的已知問題：pthread（dav1d 的 worker thread）讓 shared memory grow 之後，direct 模式下 JS 端的
  // Module.HEAPU8 不會更新，libav.js 的 ff_copyin_packet 等丟 RangeError。量測時把 shared memory 的初始大小
  // 直接開到 initMiB（預設 512 MiB），避免執行中 grow。initMiB=0 則不處理（用來重現問題）。
  const initMiB = p.initMiB ?? 512;
  if (target === "thr" && initMiB && !WebAssembly.Memory.__patched) {
    const M = WebAssembly.Memory;
    const P = function (d) { if (d?.shared) d = { ...d, initial: Math.max(d.initial, initMiB * 16) }; return new M(d); };
    P.prototype = M.prototype; P.__patched = true;
    WebAssembly.Memory = P;
  }
  const { codecpar, packets, timeBase } = await demuxAll(file);
  const L = await createLibAV({ variant, flavor, noasy, target });
  const d = openDecoder(L, codecpar, { threads, maxFrameDelay, skip, grain });

  // post 模式：主執行緒 ack 一張就少一張在途
  let inFlight = 0, wake = null;
  if (out === "post") self.onmessage = (e) => { if (e.data === "ack") { inFlight--; wake?.(); } };
  const postFrame = async (vf) => {
    while (inFlight >= maxInFlight) await new Promise((r) => (wake = r));
    inFlight++;
    self.postMessage({ vf, t: performance.timeOrigin + performance.now() }, [vf]);
  };

  const dec = [], copy = [], vfc = [], perPkt = [], decAll = [], totAll = [], outN = [];
  let nFrames = 0, keys = 0, fmt = null, lastPts = 0, vfErr = null, pending = [];
  const onFrame = (f) => {
    nFrames++;
    if (out === "none") { if (fmt === null) fmt = L.AVFrame_format_sync(f); return; }
    const t0 = performance.now();
    const o = copyoutI420(L, f, { to8: out !== "copy10" });
    const t1 = performance.now();
    copy.push(t1 - t0);
    fmt ??= `${o.info.format}/${o.format}/${o.w}x${o.h}`;
    if (out === "vf" || out === "post") {
      try {
        const vf = new VideoFrame(o.buf, { format: o.format, codedWidth: o.w, codedHeight: o.h, timestamp: Math.round(nFrames * 33333),
          transfer: p.transfer ? [o.buf.buffer] : undefined });
        vfc.push(performance.now() - t1);
        if (out === "vf") vf.close(); else pending.push(vf);
      } catch (e) { vfErr ??= `${e.name}: ${e.message}`; }
    }
  };

  const tStart = performance.now();
  let i = 0;
  for (const pkt of packets) {
    if (nFrames >= frames) break;
    const before = nFrames;
    const t0 = performance.now();
    decodePacket(L, d, pkt, onFrame);
    const t1 = performance.now();
    // 「純解碼」時間 = 這次呼叫的總時間扣掉 onFrame 內的取出／建 frame 時間
    const extra = copy.slice(copy.length - (nFrames - before)).reduce((a, b) => a + b, 0) + vfc.slice(vfc.length - (nFrames - before)).reduce((a, b) => a + b, 0);
    if (i >= warm) { perPkt.push(t1 - t0 - extra); }
    decAll.push(t1 - t0 - extra); totAll.push(t1 - t0); outN.push(nFrames - before);
    if (pkt.flags & 1) keys++;
    for (const vf of pending.splice(0)) await postFrame(vf);
    if (++i % 100 === 0) progress(`${i}/${packets.length} pkts, ${nFrames} frames`);
  }
  const tFlush = performance.now();
  decodePacket(L, d, null, onFrame);
  for (const vf of pending.splice(0)) await postFrame(vf);
  if (out === "post") while (inFlight > 0) await new Promise((r) => (wake = r));
  const tEnd = performance.now();
  closeDecoder(L, d);

  const wall = tEnd - tStart;
  // 內容 fps（由封包 pts 推得）與「要預先解好多少才不會掉格」：
  // 第 k 個輸出 frame 的完成時間 C_k ≤ D + k/fps 對所有 k 成立的最小 D（ms）。平均跟不上時 D 會隨片長成長。
  const pts = packets.map((q) => q.pts + (q.ptshi ?? 0) * 0x100000000).sort((a, b) => a - b);
  const contentFps = (pts.length - 1) / ((pts[pts.length - 1] - pts[0]) * timeBase[0] / timeBase[1]);
  const preroll = (arr) => { let t = 0, k = 0, D = 0; arr.forEach((x, j) => { t += x; for (let m = 0; m < outN[j]; m++) { D = Math.max(D, t - (k * 1000) / contentFps); k++; } }); return +D.toFixed(0); };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    contentFps: +contentFps.toFixed(3), decodeOnlyFps: +(nFrames / (sum(decAll) / 1000)).toFixed(1),
    realtimeFactor: +((nFrames / (sum(decAll) / 1000)) / contentFps).toFixed(2),
    prerollMsDecodeOnly: preroll(decAll), prerollMsWithOutput: preroll(totAll),
    file, wasm: L.wasmName, threads, maxFrameDelay, skip, grain, out, packets: Math.min(i, packets.length), frames: nFrames, keys, fmt,
    loadMs: +L.loadMs.toFixed(0), wallMs: +wall.toFixed(0), flushMs: +(tEnd - tFlush).toFixed(0),
    decodeFps: +(nFrames / (wall / 1000)).toFixed(1),
    perPacketDecodeMs: stat(perPkt), copyMs: stat(copy), videoFrameMs: stat(vfc), vfErr,
    crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : null,
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null,
  };
}
