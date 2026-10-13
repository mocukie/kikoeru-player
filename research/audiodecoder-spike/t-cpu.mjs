// 拋棄式 spike（#18）：同一個檔案用 wasm 與 AudioDecoder 解碼的 CPU 時間（含 AudioData → fltp 的複製與 filter graph）。
// 每個階段前後 mark()，runner 加總所有瀏覽器 process 的 CPU（AudioDecoder 可能在別的執行緒或 process 解碼）。
// 封包事先讀進記憶體，不計 demux。filter graph 與 #17 的 t-speed 相同：atempo=1.25 → fltp。
import { createLibAV, now, median } from "./lib.mjs";
import { openAudio, readAllPackets, adDecode, adConfig, layoutOf, supported } from "./audio.mjs";

const FILES = ["cpu-mp3.mp3", "cpu-aac.m4a", "cpu-opus.opus", "cpu-vorbis.ogg", "cpu-flac.flac", "cpu-flac192.flac", "cpu-pcm192.wav"];

export async function run({ files = FILES, reps = 3, filter = "atempo=1.25", paths = ["wasm", "wasmNoFilter", "ad", "adNoFilter"] } = {}, progress, mark) {
  const lib = await createLibAV();
  const FLTP = lib.AV_SAMPLE_FMT_FLTP;
  const out = {};
  const measure = async (label, fn) => {
    const c0 = (await mark(`${label}:start`)).cpuMs, t0 = now();
    const extra = await fn();
    const wall = now() - t0, c1 = (await mark(`${label}:end`)).cpuMs;
    return { wall, cpu: c1 - c0, ...extra };
  };
  const graph = async (sr, layout, inFmt) => lib.ff_init_filter_graph(filter, { sample_rate: sr, channel_layout: layout, sample_fmt: inFmt }, { sample_rate: sr, channel_layout: layout, sample_fmt: FLTP });
  for (const f of files) {
    progress?.(f);
    const r = out[f] = {};
    try {
      const o = await openAudio(lib, `/media/${f}`);
      const { info } = o;
      const pk = await readAllPackets(lib, o.fmt, info.index);
      const mediaSec = pk.reduce((s, p) => s + p.duration, 0) * info.tb_num / info.tb_den;
      r.info = { codec: info.codec, sr: info.sample_rate, ch: info.channels, bits: info.bits_per_raw_sample, mediaSec: +mediaSec.toFixed(1), packets: pk.length };
      const layout = layoutOf(info);
      let sup = false;
      sup = (await supported(adConfig(info))) === true;
      r.adSupported = sup;
      const runs = {};
      for (let rep = 0; rep < reps; rep++) {
        for (const path of paths) {
          if (path.startsWith("ad") && (!sup || r[`${path}Error`])) continue;
          let res;
          if (path === "wasm" || path === "wasmNoFilter") {
            res = await measure(`${f}:${path}`, async () => {
              const [, c, dp, frame] = await lib.ff_init_decoder(info.codec_id, { codecpar: o.stream.codecpar });
              const [g, src, sink] = await graph(info.sample_rate, layout, await lib.AVCodecContext_sample_fmt(c));
              let n = 0;
              for (let i = 0; i < pk.length; i += 256) {
                const fin = i + 256 >= pk.length;
                const fs = path === "wasm"
                  ? await lib.ff_decode_filter_multi(c, src, sink, dp, frame, pk.slice(i, i + 256), { fin, ignoreErrors: true })
                  : await lib.ff_decode_multi(c, dp, frame, pk.slice(i, i + 256), { fin, ignoreErrors: true });
                for (const x of fs) n += x.nb_samples;
              }
              await lib.avfilter_graph_free_js(g);
              await lib.ff_free_decoder(c, dp, frame);
              return { samples: n };
            });
          } else {
            res = await measure(`${f}:${path}`, async () => {
             try {
              // AudioDecoder → copyTo(f32-planar) → （ad）libav.js frame → filter graph → fltp
              let n = 0, outN = 0, tDecode = 0;
              const pending = [];
              const t0 = now();
              const a = await adDecode(info, pk, { keep: false, onData: (planes) => { if (planes[0].length) pending.push(planes); n += planes[0].length; } /* Firefox 會給 0 frame 的 AudioData */ });
              tDecode = now() - t0;
              if (a.error) throw new Error(a.error);
              if (path === "ad") {
                const [g, src, sink] = await graph(info.sample_rate, layout, FLTP);
                const fr = await lib.av_frame_alloc();
                let pts = 0;
                for (let i = 0; i < pending.length; i += 256) {
                  const batch = pending.slice(i, i + 256).map((planes) => {
                    const fx = { data: planes, format: FLTP, sample_rate: info.sample_rate, channel_layout: layout, channels: info.channels, pts, time_base_num: 1, time_base_den: info.sample_rate };
                    pts += planes[0].length; return fx;
                  });
                  const fs = await lib.ff_filter_multi(src, sink, fr, batch, { fin: i + 256 >= pending.length });
                  for (const x of fs) outN += x.nb_samples;
                }
                await lib.av_frame_free_js(fr);
                await lib.avfilter_graph_free_js(g);
              }
              return { samples: n, filtered: outN, decodeWall: tDecode, format: a.format };
             } catch (e) { return { error: String(e?.message ?? e) }; }
            });
            if (res.error) { r[`${path}Error`] = res.error; continue; }
          }
          (runs[path] ??= []).push(res);
          globalThis.gc?.();
        }
      }
      for (const [path, rs] of Object.entries(runs)) {
        r[path] = { wallMs: +median(rs.map((x) => x.wall)).toFixed(0), cpuMs: median(rs.map((x) => x.cpu)),
          cpuMsPerMediaSec: +(median(rs.map((x) => x.cpu)) / mediaSec).toFixed(2), wallMsPerMediaSec: +(median(rs.map((x) => x.wall)) / mediaSec).toFixed(2),
          samples: rs[0].samples, filtered: rs[0].filtered, decodeWallMs: rs[0].decodeWall != null ? +median(rs.map((x) => x.decodeWall)).toFixed(0) : undefined,
          format: rs[0].format, all: rs.map((x) => [Math.round(x.wall), x.cpu]) };
      }
      await lib.avformat_close_input_js(o.fmt);
      await lib.unlink(o.name);
    } catch (e) { r.error = String(e?.stack ?? e).slice(0, 800); }
  }
  return out;
}
