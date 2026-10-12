// 拋棄式 spike（#10）：在 Node 以 noworker 載入 build 出來的 variant，確認 demux／decode／patch／atempo 都能動。
// 用法：node smoke.mjs <dist 目錄> <variant> <媒體檔...>
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const [dist, variant, ...files] = process.argv.slice(2);
const { default: LibAV } = await import(`${dist}/libav-6.10.9.0-${variant}.mjs`);
const libav = await LibAV.LibAV({ noworker: true, base: dist });
const hasFilter = typeof libav.avfilter_graph_send_command === "function";

const ts = (lo, hi) => (hi === -2147483648 && lo === 0 ? "NOPTS" : hi * 2 ** 32 + (lo >>> 0));

for (const file of files) {
  const name = basename(file);
  await libav.writeFile(name, new Uint8Array(await readFile(file)));
  const [fmt, streams] = await libav.ff_init_demuxer_file(name);
  const pkt = await libav.av_packet_alloc();
  const [, all] = await libav.ff_read_frame_multi(fmt, pkt);
  console.log(`# ${name}`);
  for (const st of streams) {
    const codec = await libav.avcodec_get_name(st.codec_id);
    const disp = await libav.AVStream_disposition(st.ptr);
    const start = ts(await libav.AVStream_start_time(st.ptr), await libav.AVStream_start_timehi(st.ptr));
    const meta = await libav.ff_copyout_dict(await libav.AVStream_metadata(st.ptr));
    const pkts = all[st.index] || [];
    let extra = "";
    if (st.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
      const [, c, dpkt, frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar });
      const n = (a) => a.reduce((s, f) => s + f.nb_samples, 0);
      const fmtIn = await libav.AVCodecContext_sample_fmt(c);
      if (!hasFilter) {
        const frames = await libav.ff_decode_multi(c, dpkt, frame, pkts, true);
        const f0 = frames[0];
        extra = `decoded ${frames.length} frames / ${n(frames)} samples, fmt=${f0.format} rate=${f0.sample_rate} ch=${f0.channels} data=${f0.data ? "ok" : "NULL"}`;
      } else {
        // Engine 的實際路徑：decode → atempo → 統一輸出 fltp，全部在 wasm 內，中途改速
        // 無 channel mask 的 WAV（例如 IEEE float）layout 是 unspecified（mask=0），abuffer 會拒收，要自己補預設 layout
        const mask = await libav.AVCodecContext_channel_layoutmask(c);
        const chs = await libav.AVCodecContext_channels(c);
        const io = {
          sample_rate: await libav.AVCodecContext_sample_rate(c),
          channel_layout: mask || (chs === 1 ? 0x4 : 0x3),
        };
        const [graph, src, sink] = await libav.ff_init_filter_graph("atempo=1.5",
          { ...io, sample_fmt: fmtIn }, { ...io, sample_fmt: libav.AV_SAMPLE_FMT_FLTP });
        const half = Math.floor(pkts.length / 2);
        const out1 = await libav.ff_decode_filter_multi(c, src, sink, dpkt, frame, pkts.slice(0, half));
        const r = await libav.avfilter_graph_send_command(graph, "atempo", "tempo", "0.75", 0, 0, 0);
        const out2 = await libav.ff_decode_filter_multi(c, src, sink, dpkt, frame, pkts.slice(half), true);
        const o = out1[0] ?? out2[0];
        extra = `decoder fmt=${fmtIn} | atempo 1.5→0.75 (send_command=${r}): ${n(out1)}+${n(out2)} samples, out fmt=${o.format} rate=${o.sample_rate} ch=${o.channels}`;
        await libav.avfilter_graph_free_js(graph);
      }
      await libav.ff_free_decoder(c, dpkt, frame);
    } else if (pkts.length) {
      const p = pkts[0];
      const text = new TextDecoder().decode(p.data).slice(0, 60).replace(/\n/g, "\\n");
      const par = await libav.ff_copyout_codecpar(st.codecpar);
      extra = `first pkt pts=${p.pts} dur=${p.duration} "${st.codec_type === libav.AVMEDIA_TYPE_SUBTITLE ? text : p.data.length + " bytes"}"` +
        ` extradata=${par.extradata ? par.extradata.length + "B" : "none"}` +
        (st.codec_type === libav.AVMEDIA_TYPE_VIDEO ? ` ${par.width}x${par.height} keyframe=${p.flags & 1}` : "");
    }
    console.log(`  [${st.index}] ${codec} disposition=${disp} start_time=${start} tb=${st.time_base_num}/${st.time_base_den}` +
      ` meta=${JSON.stringify(meta)} pkts=${pkts.length} ${extra}`);
  }
  await libav.av_packet_free_js(pkt);
  await libav.avformat_close_input_js(fmt);
  await libav.unlink(name);
}
