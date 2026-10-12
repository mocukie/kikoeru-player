// 拋棄式 spike（#17）：指令式的測試 Worker（記憶體、多 instance、開關循環）。主執行緒用 {id, cmd, args} 呼叫，回 {id, ok, value}。
// 主執行緒在每個檢查點讀 process PSS，所以 Worker 只負責做事與回報 wasm heap 大小、CPU 時間。
import { createLibAV, openReader, now, errInfo } from "./lib.mjs";

let module = null;
let sameLib = null;
const insts = [];

async function getModule() {
  return module ??= await WebAssembly.compileStreaming(fetch("/dist/libav-6.10.9.0-kikoeru-af.wasm.wasm"));
}

// 一個「來源」：一個 libav instance + demuxer + 音訊 decoder + filter graph（atempo → fltp），與 Engine 的單一來源相同
async function openSource(file, { lat = 0, chunk = 256 * 1024, lib = null } = {}) {
  lib ??= await createLibAV({ module: await getModule() });
  await openReader(lib, "f", `/media/${file}`, { lat, chunk });
  const [fmt, streams] = await lib.ff_init_demuxer_file("f");
  const pkt = await lib.av_packet_alloc();
  const a = streams.find((s) => s.codec_type === lib.AVMEDIA_TYPE_AUDIO);
  const [, c, dpkt, frame] = await lib.ff_init_decoder(a.codec_id, { codecpar: a.codecpar });
  const io = { sample_rate: await lib.AVCodecContext_sample_rate(c), channel_layout: 3 };
  const [graph, src, sink] = await lib.ff_init_filter_graph("atempo=1.0",
    { ...io, sample_fmt: await lib.AVCodecContext_sample_fmt(c) }, { ...io, sample_fmt: lib.AV_SAMPLE_FMT_FLTP });
  return { file, lib, fmt, pkt, a, c, dpkt, frame, graph, src, sink, pos: 0, demuxMs: 0, decodeMs: 0, fetchMs: 0 };
}
// 往前 demux＋解碼 sec 秒的媒體；分開記錄 demux（扣掉等網路的時間）與解碼＋filter 的 CPU 時間
async function advance(s, sec) {
  const tb = s.a.time_base_num / s.a.time_base_den;
  const until = s.pos + sec;
  const rd = s.lib.readers.f;
  while (s.pos < until) {
    const f0 = rd.fetchMs, t0 = now();
    const [res, ps] = await s.lib.ff_read_frame_multi(s.fmt, s.pkt, { limit: 64 * 1024 });
    s.demuxMs += now() - t0 - (rd.fetchMs - f0);
    s.fetchMs += rd.fetchMs - f0;
    const ap = ps[s.a.index] ?? [];
    if (ap.length) {
      const t1 = now();
      await s.lib.ff_decode_filter_multi(s.c, s.src, s.sink, s.dpkt, s.frame, ap);
      s.decodeMs += now() - t1;
      s.pos = ap[ap.length - 1].pts * tb;
    }
    if (res !== -6) break;
  }
}
async function closeSource(s) {
  await s.lib.avfilter_graph_free_js(s.graph);
  await s.lib.ff_free_decoder(s.c, s.dpkt, s.frame);
  await s.lib.av_packet_free_js(s.pkt);
  await s.lib.avformat_close_input_js(s.fmt);
  await s.lib.unlink("f");
}
const heapMiB = (s) => +(s.lib.HEAPU8.length / 1048576).toFixed(1);

const CMDS = {
  async setModule({ module: m }) { module = m; return true; },
  async add({ file }) { const s = await openSource(file); insts.push(s); return insts.length; },
  // 所有 instance 輪流前進（模擬主檔＋外掛音軌同時播放），回報每個 instance 的 CPU ms／媒體秒
  async play({ sec = 30, step = 1 }) {
    for (const s of insts) {
      await s.lib.av_seek_frame(s.fmt, -1, 0, 0, 1);
      await s.lib.avcodec_flush_buffers(s.c);
      Object.assign(s, { pos: 0, demuxMs: 0, decodeMs: 0, fetchMs: 0 });
    }
    const t0 = now();
    for (let t = 0; t < sec; t += step) for (const s of insts) await advance(s, step);
    const r = (x) => +(x / sec).toFixed(2);
    return { wallMs: +(now() - t0).toFixed(0),
      per: insts.map((s) => ({ file: s.file, demuxMsPerSec: r(s.demuxMs), decodeMsPerSec: r(s.decodeMs), fetchMsPerSec: r(s.fetchMs), heapMiB: heapMiB(s) })) };
  },
  async heap() { return insts.map(heapMiB); },
  async drop() { for (const s of insts.splice(0)) await closeSource(s); globalThis.gc?.(); return true; },
  // 重用 Worker：連續 n 次。what=full：建立 instance→開檔→解碼約 2 秒→關閉→丟掉 instance；
  // what=instance：只建立再丟掉 instance；what=fetch：只做相同的 Range 請求；what=same：同一個 instance 重複開檔→解碼→關閉（instance 不丟）
  async cycles({ n, file = "ab.mp3", sec = 2, what = "full" }) {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = now();
      if (what === "instance") {
        await createLibAV({ module: await getModule() });
      } else if (what === "fetch") {
        // 對照組：不碰 libav.js，只做跟 full 相同的 Range 請求（1 個 size 探測＋2 個 256 KiB）
        for (const r of ["0-0", "0-262143", "262144-524287"])
          await (await fetch(`/media/${file}?lat=0`, { headers: { Range: `bytes=${r}` } })).arrayBuffer();
      } else {
        const s = await openSource(file, what === "same" ? { lib: sameLib ??= await createLibAV({ module: await getModule() }) } : {});
        await advance(s, sec);
        await closeSource(s);
      }
      times.push(now() - t0);
    }
    globalThis.gc?.();
    return { avgMs: +(times.reduce((a, b) => a + b, 0) / n).toFixed(1), heapMiB: sameLib ? +(sameLib.HEAPU8.length / 1048576).toFixed(1) : undefined };
  },
  async gc() { globalThis.gc?.(); return !!globalThis.gc; },
};

export function run(_params, _progress, self) {
  return new Promise((resolve) => {
    self.onmessage = async (e) => {
      const { id, cmd, args } = e.data;
      if (cmd === "end") { resolve(true); return; }
      try { self.postMessage({ id, ok: true, value: await CMDS[cmd](args ?? {}) }); }
      catch (err) { self.postMessage({ id, ok: false, value: errInfo(err) + "\n" + err?.stack }); }
    };
    self.postMessage({ svcReady: true });
  });
}
