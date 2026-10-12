// 拋棄式 spike（#17）：Asyncify 對 demux／解碼速度的影響。同一份 FFmpeg 物件檔，有／無 Asyncify 兩種 link。
// 檔案整個放進 MEMFS（無 Asyncify 的版本不能用 block reader），量開檔＋讀完所有封包、解碼、解碼＋filter graph（atempo 1.0 以外的速度 → fltp）。
import { createLibAV, now, median, errInfo } from "./lib.mjs";

export async function run({ files = ["sp.mp3", "sp.m4a", "sp.flac", "sp.opus", "sp.wav"], reps = 3,
  variants = ["kikoeru-af", "kikoeru-af-noasyncify"] } = {}, progress) {
  const data = {};
  for (const f of files) data[f] = new Uint8Array(await (await fetch(`/media/${f}`)).arrayBuffer());
  const out = {};
  for (const variant of variants) {
    const module = await WebAssembly.compileStreaming(fetch(`/dist/libav-6.10.9.0-${variant}.wasm.wasm`));
    out[variant] = {};
    for (const f of files) {
      progress?.(`${variant} ${f}`);
      const m = { demux: [], decode: [], filter: [] };
      try {
        for (let rep = 0; rep < reps; rep++) {
          const lib = await createLibAV({ variant, module });
          await lib.writeFile(f, data[f]);
          let t = now();
          const [fmt, streams] = await lib.ff_init_demuxer_file(f);
          const pkt = await lib.av_packet_alloc();
          const a = streams.find((s) => s.codec_type === lib.AVMEDIA_TYPE_AUDIO);
          const pkts = [];
          for (;;) {
            const [res, ps] = await lib.ff_read_frame_multi(fmt, pkt, { limit: 4 * 1024 * 1024 });
            if (ps[a.index]) pkts.push(...ps[a.index]);
            if (res !== -6) break;
          }
          m.demux.push(now() - t);
          const dur = pkts.reduce((s, p) => s + p.duration, 0) * a.time_base_num / a.time_base_den;
          m.mediaSec = +dur.toFixed(1);
          // 純解碼
          let [, c, dpkt, frame] = await lib.ff_init_decoder(a.codec_id, { codecpar: a.codecpar });
          t = now();
          for (let i = 0; i < pkts.length; i += 500)
            await lib.ff_decode_multi(c, dpkt, frame, pkts.slice(i, i + 500), i + 500 >= pkts.length);
          m.decode.push(now() - t);
          await lib.ff_free_decoder(c, dpkt, frame);
          // 解碼 + filter graph（Engine 的實際路徑：atempo 1.25 → fltp）
          [, c, dpkt, frame] = await lib.ff_init_decoder(a.codec_id, { codecpar: a.codecpar });
          const io = { sample_rate: await lib.AVCodecContext_sample_rate(c), channel_layout: 3 };
          const [graph, src, sink] = await lib.ff_init_filter_graph("atempo=1.25",
            { ...io, sample_fmt: await lib.AVCodecContext_sample_fmt(c) }, { ...io, sample_fmt: lib.AV_SAMPLE_FMT_FLTP });
          t = now();
          for (let i = 0; i < pkts.length; i += 500)
            await lib.ff_decode_filter_multi(c, src, sink, dpkt, frame, pkts.slice(i, i + 500), i + 500 >= pkts.length);
          m.filter.push(now() - t);
          await lib.avfilter_graph_free_js(graph);
          await lib.ff_free_decoder(c, dpkt, frame);
          await lib.avformat_close_input_js(fmt);
          await lib.unlink(f);
          globalThis.gc?.();
        }
        out[variant][f] = { mediaSec: m.mediaSec, demuxMs: +median(m.demux).toFixed(0), decodeMs: +median(m.decode).toFixed(0), decodeFilterMs: +median(m.filter).toFixed(0),
          all: { demux: m.demux.map((x) => +x.toFixed(0)), decode: m.decode.map((x) => +x.toFixed(0)), filter: m.filter.map((x) => +x.toFixed(0)) } };
      } catch (e) { out[variant][f] = { error: errInfo(e) }; }
    }
  }
  return out;
}
