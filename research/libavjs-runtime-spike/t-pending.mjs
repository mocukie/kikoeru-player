// 拋棄式 spike（#17）：同一個 instance 有 read 掛起（Asyncify 暫停中）時，解碼呼叫會不會被擋、結果對不對。
// direct 模式下 ff_decode_multi／ff_decode_filter_multi 是同步 JS（只呼叫同步 export），不經過 serially()；
// av_read_frame、ff_read_frame_multi、ff_init_demuxer_file、av_seek_frame 才會排進同一條 serially() 佇列。
import { createLibAV, openReader, pktSig, fnv, now, sleep, errInfo } from "./lib.mjs";

function frameSig(frames) {
  let s = "";
  for (const f of frames) {
    const planes = Array.isArray(f.data) ? f.data : [f.data];
    for (const p of planes) s = fnv(new TextEncoder().encode(s + fnv(new Uint8Array(p.buffer, p.byteOffset, p.byteLength))));
  }
  return `${frames.length}f:${s}`;
}

async function prepare(module, file, lat, nAudio) {
  const lib = await createLibAV({ module });
  const rd = await openReader(lib, "f", `/media/${file}`, { lat });
  const [fmt, streams] = await lib.ff_init_demuxer_file("f");
  const pkt = await lib.av_packet_alloc();
  const a = streams.find((s) => s.codec_type === lib.AVMEDIA_TYPE_AUDIO);
  const audio = [];
  while (audio.length < nAudio) {
    const [, ps] = await lib.ff_read_frame_multi(fmt, pkt, { limit: 1, unify: true });
    for (const p of ps[0] ?? []) if (p.stream_index === a.index) audio.push(p);
  }
  const [, c, dpkt, frame] = await lib.ff_init_decoder(a.codec_id, { codecpar: a.codecpar });
  const io = { sample_rate: await lib.AVCodecContext_sample_rate(c), channel_layout: 3 };
  const [graph, src, sink] = await lib.ff_init_filter_graph("atempo=1.25",
    { ...io, sample_fmt: await lib.AVCodecContext_sample_fmt(c) }, { ...io, sample_fmt: lib.AV_SAMPLE_FMT_FLTP });
  return { lib, rd, fmt, pkt, a, audio, c, dpkt, frame, graph, src, sink };
}

export async function run({ file = "ab.mp4", lat = 2, stallMs = 1500, nAudio = 300 } = {}) {
  const module = await WebAssembly.compileStreaming(fetch("/dist/libav-6.10.9.0-kikoeru-af.wasm.wasm"));
  const out = { file, stallMs };

  // 參考：沒有掛起的情況
  const R = await prepare(module, file, lat, nAudio);
  let t = now();
  const refDec = frameSig(await R.lib.ff_decode_multi(R.c, R.dpkt, R.frame, R.audio.slice(0, nAudio / 2)));
  out.refDecodeMs = +(now() - t).toFixed(1);
  t = now();
  const refFilt = frameSig(await R.lib.ff_decode_filter_multi(R.c, R.src, R.sink, R.dpkt, R.frame, R.audio.slice(nAudio / 2)));
  out.refDecodeFilterMs = +(now() - t).toFixed(1);
  const refNext = (await R.lib.ff_read_frame_multi(R.fmt, R.pkt, { limit: 512 * 1024, unify: true }))[1][0].map(pktSig);

  // 同一個 instance：read 掛起中呼叫解碼
  const A = await prepare(module, file, lat, nAudio);
  A.rd.lat = stallMs;
  const tRead = now();
  let readDoneAt = null;
  const readP = A.lib.ff_read_frame_multi(A.fmt, A.pkt, { limit: 512 * 1024, unify: true }).then((r) => { readDoneAt = now(); return r; });
  while (!A.rd.pending) await sleep(1);
  A.rd.lat = lat;  // 只有第一個 fetch 掛起 stallMs，之後的 cache miss 恢復正常
  await sleep(20);
  const ev = {};
  t = now();
  try {
    ev.decode = frameSig(await A.lib.ff_decode_multi(A.c, A.dpkt, A.frame, A.audio.slice(0, nAudio / 2)));
  } catch (e) { ev.decode = `threw ${errInfo(e)}`; }
  ev.decodeMs = +(now() - t).toFixed(1);
  ev.decodeFinishedBeforeRead = readDoneAt === null;
  t = now();
  try {
    ev.decodeFilter = frameSig(await A.lib.ff_decode_filter_multi(A.c, A.src, A.sink, A.dpkt, A.frame, A.audio.slice(nAudio / 2)));
  } catch (e) { ev.decodeFilter = `threw ${errInfo(e)}`; }
  ev.decodeFilterMs = +(now() - t).toFixed(1);
  ev.decodeMatchesRef = ev.decode === refDec;
  ev.decodeFilterMatchesRef = ev.decodeFilter === refFilt;
  // 同步 accessor 與 malloc/free 也能在暫停中呼叫嗎
  t = now();
  try { const p = await A.lib.av_packet_alloc(); await A.lib.av_packet_free_js(p); ev.syncAllocFree = "ok"; } catch (e) { ev.syncAllocFree = `threw ${errInfo(e)}`; }
  // 走 serially() 的呼叫：同一個 instance 開第二個檔（它自己的讀取沒有延遲），看它何時完成
  await openReader(A.lib, "g", "/media/ab.mp3", { lat });
  const tOpen = now();
  let openDoneAt = null;
  const openP = A.lib.ff_init_demuxer_file("g").then((r) => { openDoneAt = now(); return r; });
  const [, nextPs] = await readP;
  await openP;
  ev.readMs = +(readDoneAt - tRead).toFixed(1);
  ev.secondOpenWaitedForRead = openDoneAt >= readDoneAt;
  ev.secondOpenMs = +(openDoneAt - tOpen).toFixed(1);
  const next = nextPs[0].map(pktSig);
  ev.pendingReadPacketsMatchRef = next.length === refNext.length && next.every((s, i) => s === refNext[i]);
  ev.pendingReadPackets = next.length;
  out.sameInstance = ev;

  // 另一個 instance：A 的 read 掛起時，B 解碼不受影響
  const B = await prepare(module, file, lat, nAudio);
  A.rd.lat = stallMs;
  const readP2 = A.lib.ff_read_frame_multi(A.fmt, A.pkt, { limit: 512 * 1024, unify: true });
  while (!A.rd.pending) await sleep(1);
  A.rd.lat = lat;
  t = now();
  const bDec = frameSig(await B.lib.ff_decode_multi(B.c, B.dpkt, B.frame, B.audio.slice(0, nAudio / 2)));
  out.otherInstance = { decodeMs: +(now() - t).toFixed(1), matchesRef: bDec === refDec };
  await readP2;
  return out;
}
