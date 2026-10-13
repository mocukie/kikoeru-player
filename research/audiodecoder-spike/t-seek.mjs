// 拋棄式 spike（#18）：seek 後要從目標封包往前多送幾個封包（preroll），輸出才會與連續解碼一致。
// 兩條路線各自與「自己的連續解碼」比較：AudioDecoder 每次 reset() + configure()，wasm 用 avcodec_flush_buffers（Engine 的 seek 程序）。
// 也量「照 AudioData.timestamp 擺放 sample 會差幾個 sample」（tsErr）。
import { createLibAV } from "./lib.mjs";
import { openAudio, readAllPackets, adDecode, adConfig, findLag, diff, usOf, concatPlanes } from "./audio.mjs";

const FILES = ["acc-aac.m4a", "acc-aac.aac", "acc-mp3.mp3", "acc-opus.opus", "acc-opus.webm", "acc-flac.flac", "acc-vorbis.ogg"];
const KS = [0, 1, 2, 3, 4, 6, 8, 12];

// libav.js 的 audio frame → 每聲道 Float32Array（planar／packed、f32／s16／s32）
function frameToPlanes(f) {
  const ch = f.channels, planar = f.format >= 5;
  const scale = (a) => a instanceof Float32Array ? a : a instanceof Int16Array ? Float32Array.from(a, (x) => x / 32768) : Float32Array.from(a, (x) => x / 2147483648);
  if (planar) return f.data.map(scale);
  const all = scale(f.data), n = all.length / ch;
  return Array.from({ length: ch }, (_, c) => { const p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = all[i * ch + c]; return p; });
}
async function wasmRun(lib, d, packets) {
  const fs = await lib.ff_decode_multi(d.c, d.pkt, d.frame, packets.map((p) => ({ ...p, side_data: null })), { fin: true, ignoreErrors: true });
  return concatPlanes(fs.filter((f) => f.nb_samples).map(frameToPlanes));
}

// tsOffset：所有 chunk timestamp 加上的偏移（µs）。預設 +1 秒，避免負的 timestamp（WebKit 會亂掉、Chromium 會改寫）
export async function run({ files = FILES, ks = KS, targetSec = 10, win = 2048, tsOffset = 1e6 } = {}, progress) {
  const lib = await createLibAV();
  const out = {};
  for (const f of files) {
    progress?.(f);
    const r = out[f] = {};
    try {
      const o = await openAudio(lib, `/media/${f}`);
      const { info } = o;
      const pk = await readAllPackets(lib, o.fmt, info.index);
      const sr = info.sample_rate;
      const durSamples = (p) => Math.round(p.duration * info.tb_num / info.tb_den * sr);
      const iT = pk.findIndex((p) => usOf(info, p) >= targetSec * 1e6);
      r.target = { pkt: iT, us: usOf(info, pk[iT]), pktDur: durSamples(pk[iT]) };
      // 連續解碼（基準）
      const cont = await adDecode(info, pk, { tsOffset });
      const C = cont.planes[0];
      const first = (m) => m.find((x) => x.n) ?? m[0];
      const contPos = (ts) => Math.round((ts - first(cont.meta).ts) * sr / 1e6);
      const [, c, dp, frame] = await lib.ff_init_decoder(info.codec_id, { codecpar: o.stream.codecpar });
      const d = { c, pkt: dp, frame };
      const W = (await wasmRun(lib, d, pk))[0];
      // 目標封包在連續輸出中的位置：用 AudioDecoder 的 timestamp 換算；wasm 用 lag 對到 AD 的座標
      const posT = contPos(usOf(info, pk[iT]) - usOf(info, pk[0]) + first(cont.meta).ts);
      const wLag = findLag(C, W, { from: 3 * sr, maxLag: 3000 }).lag; // C[i] ≈ W[i + wLag]
      r.ad = {}; r.wasm = {};
      const span = 10; // 目標之後再送幾個封包
      for (const k of ks) {
        const p0 = iT - k;
        if (p0 < 0) continue;
        const seg = pk.slice(p0, iT + span);
        // AudioDecoder：新的 decoder（等同 reset() + configure()）
        const s = await adDecode(info, seg, { tsOffset });
        const S = s.planes?.[0];
        if (!S?.length) { r.ad[k] = { error: s.error }; continue; }
        // S[j] ≈ C[j + L]
        const dT = r.target.pktDur;
        // 對齊用的視窗放在目標後 4 個封包（那裡一定已收斂）
        const L = findLag(S, C, { from: Math.min(S.length - 1100, Math.max(0, posT - contPos(first(s.meta).ts) + 4 * dT)), win: 1024, maxLag: 4000, center: contPos(first(s.meta).ts) }).lag;
        const at = posT - L; // 目標在 S 的位置
        r.ad[k] = { firstTs: first(s.meta).ts, chunkTs: usOf(info, pk[p0]) + tsOffset, firstN: first(s.meta).n, zero: s.meta.filter((x) => !x.n).length, tsErr: L - contPos(first(s.meta).ts),
          atTarget: diff(S, C, L, { from: at, len: win }), error: s.error };
        // wasm：flush 後從 p0 開始解
        await lib.avcodec_flush_buffers(c);
        const X = (await wasmRun(lib, d, seg))[0];
        const posTW = posT + wLag;
        const centerW = Math.round((usOf(info, pk[p0]) - usOf(info, pk[0])) * sr / 1e6);
        const LW = findLag(X, W, { from: Math.min(X.length - 1100, Math.max(0, (k + 4) * dT)), win: 1024, maxLag: 4000, center: centerW }).lag;
        r.wasm[k] = { atTarget: diff(X, W, LW, { from: posTW - LW, len: win }) };
      }
      await lib.ff_free_decoder(c, dp, frame);
      await lib.avformat_close_input_js(o.fmt);
      await lib.unlink(o.name);
    } catch (e) { r.error = String(e?.stack ?? e).slice(0, 800); }
  }
  return out;
}
