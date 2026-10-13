// 拋棄式 spike（#18）：demux（libav.js）、兩條音訊解碼路線（wasm／AudioDecoder）與比對工具。Worker 與主執行緒都能用。
export const AV_PKT_DATA_SKIP_SAMPLES = 11;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 整個檔案放進 MEMFS（本 spike 不測 I/O，#17 已測過 block reader），開檔並讀出第一條音軌的參數
export async function openAudio(lib, url) {
  const name = url.split("/").pop();
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  await lib.writeFile(name, data);
  const [fmt, streams] = await lib.ff_init_demuxer_file(name);
  const s = streams.find((x) => x.codec_type === lib.AVMEDIA_TYPE_AUDIO);
  const cp = s.codecpar;
  const stPtr = await lib.AVFormatContext_streams_a(fmt, s.index);
  const par = await lib.ff_copyout_codecpar(cp);
  const info = {
    file: name, index: s.index, codec_id: s.codec_id,
    codec: await lib.avcodec_get_name(s.codec_id),
    profile: par.profile, sample_rate: par.sample_rate,
    channels: await lib.AVCodecParameters_ch_layout_nb_channels(cp),
    channel_layoutmask: await lib.AVCodecParameters_channel_layoutmask(cp),
    // 以下是 codecpar-accessors.patch 新增的 accessor
    initial_padding: await lib.AVCodecParameters_initial_padding(cp),
    trailing_padding: await lib.AVCodecParameters_trailing_padding(cp),
    seek_preroll: await lib.AVCodecParameters_seek_preroll(cp),
    frame_size: await lib.AVCodecParameters_frame_size(cp),
    bits_per_raw_sample: await lib.AVCodecParameters_bits_per_raw_sample(cp),
    tb_num: s.time_base_num, tb_den: s.time_base_den,
    start_time: await lib.AVStream_start_time(stPtr),   // #10 的 accessor patch
    extradata: par.extradata ?? null,
  };
  return { fmt, stream: s, info, name };
}

export async function readAllPackets(lib, fmt, index) {
  const pkt = await lib.av_packet_alloc();
  const out = [];
  for (;;) {
    const [res, ps] = await lib.ff_read_frame_multi(fmt, pkt, { limit: 8 * 1024 * 1024 });
    if (ps[index]) out.push(...ps[index]);
    if (res !== -6) break; // -EAGAIN 以外（EOF 或錯誤）就停
  }
  await lib.av_packet_free_js(pkt);
  return out;
}

export function skipInfo(p) {
  const sd = p.side_data?.find((x) => x.type === AV_PKT_DATA_SKIP_SAMPLES);
  if (!sd) return null;
  const v = new DataView(sd.data.buffer, sd.data.byteOffset, sd.data.byteLength);
  return { start: v.getUint32(0, true), end: v.getUint32(4, true) };
}

// libav.js 的 64-bit 時間戳拆成 lo（signed 32）＋hi
export const ts64 = (lo, hi) => (hi ?? 0) * 0x100000000 + (lo >>> 0);
export function pktTime(info, p) { // 秒
  return ts64(p.pts, p.ptshi) * info.tb_num / info.tb_den;
}

const LAYOUT = { 1: 4, 2: 3, 6: 0x60f, 8: 0x63f };
export function layoutOf(info) { return info.channel_layoutmask || LAYOUT[info.channels] || 3; }

// wasm 路線：FFmpeg decoder → filter graph（預設只轉 fltp）。strip=true 時拿掉 AV_PKT_DATA_SKIP_SAMPLES，看 decoder 的原始輸出
export async function wasmDecode(lib, info, cp, packets, { strip = false, filter = "aformat=sample_fmts=fltp", keepFrames = true } = {}) {
  // FFmpeg 開 decoder 時會把 codecpar 的 initial_padding 當成 avctx->delay，一開始就裁掉（libavcodec/avcodec.c）。
  // strip=true 時連它一起暫時歸零，才拿得到 decoder 真正的原始輸出
  const pad = await lib.AVCodecParameters_initial_padding(cp);
  if (strip) await lib.AVCodecParameters_initial_padding_s(cp, 0);
  const [, c, pkt, frame] = await lib.ff_init_decoder(info.codec_id, { codecpar: cp });
  if (strip) await lib.AVCodecParameters_initial_padding_s(cp, pad);
  const io = { sample_rate: await lib.AVCodecContext_sample_rate(c), channel_layout: layoutOf(info) };
  const [graph, src, sink] = await lib.ff_init_filter_graph(filter,
    { ...io, sample_fmt: await lib.AVCodecContext_sample_fmt(c) }, { ...io, sample_fmt: lib.AV_SAMPLE_FMT_FLTP });
  const pk = strip ? packets.map((p) => ({ ...p, side_data: null })) : packets;
  const frames = [];
  for (let i = 0; i < pk.length; i += 256) {
    const fs = await lib.ff_decode_filter_multi(c, src, sink, pkt, frame, pk.slice(i, i + 256), { fin: i + 256 >= pk.length, ignoreErrors: true });
    if (keepFrames) frames.push(...fs);
  }
  await lib.avfilter_graph_free_js(graph);
  await lib.ff_free_decoder(c, pkt, frame);
  return keepFrames ? concatPlanes(frames.map((f) => f.data)) : null;
}

export function concatPlanes(list) {
  if (!list.length) return [];
  const ch = list[0].length;
  const n = list.reduce((s, x) => s + x[0].length, 0);
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  let o = 0;
  for (const planes of list) { for (let c = 0; c < ch; c++) out[c].set(planes[c], o); o += planes[0].length; }
  return out;
}

// WebCodecs 的 codec 字串與 description
export function adConfig(info, { withDescription = true } = {}) {
  const base = { sampleRate: info.sample_rate, numberOfChannels: info.channels };
  const ed = info.extradata;
  switch (info.codec) {
    case "aac": {
      // ASC 的 audioObjectType（前 5 bit）；沒有 extradata 時是 ADTS，不給 description
      const aot = ed ? ed[0] >> 3 : 2;
      return { ...base, codec: `mp4a.40.${aot}`, ...(ed && withDescription && { description: ed }) };
    }
    case "mp3": return { ...base, codec: "mp3" };
    case "opus": return { ...base, codec: "opus", ...(ed && withDescription && { description: ed }) };
    case "vorbis": return { ...base, codec: "vorbis", description: ed };
    case "flac": {
      // registry：description 是 "fLaC" + metadata block（至少 STREAMINFO）。libavformat 的 extradata 只有 34 bytes 的 STREAMINFO
      let d = ed;
      if (ed && ed.length === 34) { d = new Uint8Array(42); d.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]); d.set(ed, 8); }
      return { ...base, codec: "flac", description: d };
    }
    case "ac3": return { ...base, codec: "ac-3" };
    case "eac3": return { ...base, codec: "ec-3" };
    case "alac": return { ...base, codec: "alac", description: ed };
    case "pcm_s16le": return { ...base, codec: "pcm-s16" };
    case "pcm_s24le": return { ...base, codec: "pcm-s24" };
    case "pcm_s32le": return { ...base, codec: "pcm-s32" };
    case "pcm_f32le": return { ...base, codec: "pcm-f32" };
    case "pcm_u8": return { ...base, codec: "pcm-u8" };
    default: return { ...base, codec: info.codec };
  }
}

// AudioData → 每聲道 Float32Array。先試 f32-planar 轉換，不支援時自己轉
export function audioDataToPlanes(ad) {
  const n = ad.numberOfFrames, ch = ad.numberOfChannels;
  const planes = [];
  if (n === 0) return { planes: Array.from({ length: ch }, () => new Float32Array(0)), converted: false }; // Firefox 會輸出 0 frame 的 AudioData
  try {
    for (let c = 0; c < ch; c++) { const a = new Float32Array(n); ad.copyTo(a, { planeIndex: c, format: "f32-planar" }); planes.push(a); }
    return { planes, converted: false };
  } catch {
    const fmt = ad.format, planar = fmt.endsWith("-planar");
    const T = { u8: Uint8Array, s16: Int16Array, s32: Int32Array, f32: Float32Array }[fmt.replace("-planar", "")];
    const scale = { u8: (x) => (x - 128) / 128, s16: (x) => x / 32768, s32: (x) => x / 2147483648, f32: (x) => x }[fmt.replace("-planar", "")];
    if (planar) {
      for (let c = 0; c < ch; c++) { const a = new T(n); ad.copyTo(a, { planeIndex: c }); planes.push(Float32Array.from(a, scale)); }
    } else {
      const a = new T(n * ch); ad.copyTo(a, { planeIndex: 0 });
      for (let c = 0; c < ch; c++) { const p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = scale(a[i * ch + c]); planes.push(p); }
    }
    return { planes, converted: true };
  }
}

export const usOf = (info, p) => Math.round(pktTime(info, p) * 1e6);

// isConfigSupported（WebKit 曾經不回應，所以加 timeout）：true／false／"timeout"／"throws <name>"
export async function supported(cfg, ms = 5000) {
  try {
    return await Promise.race([AudioDecoder.isConfigSupported(cfg).then((r) => r.supported), sleep(ms).then(() => "timeout")]);
  } catch (e) { return `throws ${e.name}`; }
}

// AudioDecoder 路線：解 packets，回傳每聲道的完整輸出與每個 AudioData 的 timestamp／長度
export async function adDecode(info, packets, { config = adConfig(info), keep = true, onData = null, tsOffset = 0 } = {}) {
  const outs = [], meta = [];
  let error = null, fmt = null, converted = false;
  const dec = new AudioDecoder({
    output: (ad) => { try {
      fmt ??= ad.format;
      meta.push({ ts: ad.timestamp, n: ad.numberOfFrames, sr: ad.sampleRate, ch: ad.numberOfChannels });
      if (keep || onData) {
        const r = audioDataToPlanes(ad); converted ||= r.converted;
        if (keep) outs.push(r.planes);
        onData?.(r.planes);
      }
      ad.close();
    } catch (e) { error ??= e; } },
    error: (e) => { error ??= e; },
  });
  dec.configure(config);
  for (const p of packets) {
    if (error || dec.state === "closed") break;
    const durUs = Math.round(p.duration * info.tb_num / info.tb_den * 1e6);
    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: usOf(info, p) + tsOffset, ...(durUs > 0 && { duration: durUs }), data: p.data }));
    if (dec.decodeQueueSize > 32) {
      // dequeue 事件不一定會來（WebKit），加 timeout 並記錄
      const ok = await Promise.race([new Promise((r) => dec.addEventListener("dequeue", () => r(true), { once: true })), sleep(5000).then(() => false)]);
      if (!ok) { error ??= new Error(`dequeue timeout (queue ${dec.decodeQueueSize})`); break; }
    }
  }
  try {
    if (!error && dec.state !== "closed") {
      const ok = await Promise.race([dec.flush().then(() => true), sleep(15000).then(() => false)]);
      if (!ok) error ??= new Error(`flush timeout (queue ${dec.decodeQueueSize}, outputs ${meta.length})`);
    }
  } catch (e) { error ??= e; }
  if (dec.state !== "closed") dec.close();
  return { planes: keep ? concatPlanes(outs) : null, meta, error: error && `${error.name}: ${error.message}`, format: fmt, converted };
}

// a[i] 對 b[i+lag]：在 a 的 [from, from+win) 視窗內，於 center±maxLag 範圍找最大正規化相關的 lag
export function findLag(a, b, { from, win = 4096, maxLag = 6000, center = 0 }) {
  let best = -2, bestLag = 0;
  let ea = 0; for (let i = 0; i < win; i++) ea += a[from + i] ** 2;
  for (let lag = center - maxLag; lag <= center + maxLag; lag++) {
    const o = from + lag;
    if (o < 0 || o + win > b.length) continue;
    let s = 0, eb = 0;
    for (let i = 0; i < win; i++) { const y = b[o + i]; s += a[from + i] * y; eb += y * y; }
    const r = s / Math.sqrt(ea * eb + 1e-30);
    if (r > best) { best = r; bestLag = lag; }
  }
  return { lag: bestLag, corr: +best.toFixed(5) };
}

// a[i] 與 b[i+lag] 的差異；skipHead／skipTail 為兩端略過的 sample 數
export function diff(a, b, lag, { skipHead = 0, skipTail = 0, from = null, len = null } = {}) {
  let i0 = Math.max(0, -lag) + skipHead, i1 = Math.min(a.length, b.length - lag) - skipTail;
  if (from != null) { i0 = Math.max(i0, from); i1 = Math.min(i1, from + len); }
  let max = 0, se = 0, sr = 0;
  for (let i = i0; i < i1; i++) { const d = Math.abs(a[i] - b[i + lag]); if (d > max) max = d; se += d * d; sr += a[i] * a[i]; }
  return { max: +max.toExponential(2), snrDb: se ? +(10 * Math.log10(sr / se)).toFixed(1) : Infinity, n: i1 - i0 };
}
