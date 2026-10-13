// 拋棄式 spike（#20）：dav1d（libav.js 的 libdav1d decoder）的開啟、逐封包解碼、frame 取出成 I420 buffer。
// 用 *_sync 直接呼叫（direct 模式下 libav.js 提供），避免每個呼叫一個 Promise。
export const AVERROR_EOF = -0x20464f45; // EAGAIN 依 emscripten 的 errno（6），從 L.EAGAIN 取

// opts：threads（AVCodecContext.thread_count；1 = dav1d 單執行緒）、maxFrameDelay（libdav1d 私有選項，0 = 自動）、
//       skip（skip_frame："nonref" → DAV1D_DECODEFRAMETYPE_REFERENCE；只在 open 時讀取）、grain（false → 不套 film grain）
export function openDecoder(L, codecpar, { threads = 1, maxFrameDelay = 0, skip = null, grain = null } = {}) {
  const codec = L.avcodec_find_decoder_by_name_sync("libdav1d");
  if (!codec) throw new Error("libdav1d not found");
  const c = L.avcodec_alloc_context3_sync(codec);
  const cp = L.avcodec_parameters_alloc_sync();
  L.ff_copyin_codecpar_sync(cp, codecpar);
  if (L.avcodec_parameters_to_context_sync(c, cp) < 0) throw new Error("parameters_to_context");
  L.avcodec_parameters_free_js_sync(cp);
  const set = (k, v) => { const r = L.av_opt_set_sync(c, k, String(v), 1 /* AV_OPT_SEARCH_CHILDREN */); if (r < 0) throw new Error(`av_opt_set ${k}=${v}: ${r}`); };
  set("threads", threads);
  if (maxFrameDelay) set("max_frame_delay", maxFrameDelay);
  if (skip) set("skip_frame", skip);
  if (grain === false) set("export_side_data", "film_grain");
  const r = L.avcodec_open2_sync(c, codec, 0);
  if (r < 0) throw new Error(`avcodec_open2: ${r}`);
  return { c, pkt: L.av_packet_alloc_sync(), frame: L.av_frame_alloc_sync() };
}

export function closeDecoder(L, d) {
  L.ff_free_decoder_sync(d.c, d.pkt, d.frame);
}

// 送一個封包（null = flush），每取得一個 frame 就呼叫 onFrame(framePtr)，回傳取得的 frame 數
export function decodePacket(L, d, packet, onFrame) {
  if (packet) {
    L.ff_copyin_packet_sync(d.pkt, packet);
    const r = L.avcodec_send_packet_sync(d.c, d.pkt);
    L.av_packet_unref_sync(d.pkt);
    if (r < 0 && r !== -L.EAGAIN) throw new Error(`send_packet ${r}`);
  } else {
    L.avcodec_send_packet_sync(d.c, 0);
  }
  let n = 0;
  for (;;) {
    const r = L.avcodec_receive_frame_sync(d.c, d.frame);
    if (r === -L.EAGAIN || r === AVERROR_EOF) break;
    if (r < 0) throw new Error(`receive_frame ${r}`);
    n++;
    onFrame?.(d.frame);
    L.av_frame_unref_sync(d.frame);
  }
  return n;
}

export function frameInfo(L, f) {
  const w = L.AVFrame_width_sync(f), h = L.AVFrame_height_sync(f);
  const ls = [0, 1, 2].map((i) => L.AVFrame_linesize_a_sync(f, i));
  const data = [0, 1, 2].map((i) => L.AVFrame_data_a_sync(f, i));
  const bps = ls[0] >= 2 * w ? 2 : 1; // dav1d 的 stride 只對齊到 64/128 byte，不會到兩倍寬
  return { w, h, ls, data, bps, format: L.AVFrame_format_sync(f), key: L.AVFrame_key_frame_sync(f), pictType: L.AVFrame_pict_type_sync(f) };
}

// 從 wasm heap 取出成緊密排列的 I420（8-bit）。to8：10-bit 時右移 2 位轉成 8-bit；否則 10-bit 保留成 I420P10（Uint16 LE）。
export function copyoutI420(L, f, { to8 = true } = {}) {
  const fi = frameInfo(L, f);
  const { w, h, ls, data, bps } = fi;
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const heap = L.HEAPU8;
  const planes = [[w, h], [cw, ch], [cw, ch]];
  if (bps === 1) {
    const out = new Uint8Array(w * h + 2 * cw * ch);
    let o = 0;
    planes.forEach(([pw, ph], i) => {
      for (let y = 0; y < ph; y++) { out.set(heap.subarray(data[i] + y * ls[i], data[i] + y * ls[i] + pw), o); o += pw; }
    });
    return { buf: out, format: "I420", w, h, info: fi };
  }
  if (!to8) {
    const out = new Uint8Array((w * h + 2 * cw * ch) * 2);
    let o = 0;
    planes.forEach(([pw, ph], i) => {
      for (let y = 0; y < ph; y++) { out.set(heap.subarray(data[i] + y * ls[i], data[i] + y * ls[i] + pw * 2), o); o += pw * 2; }
    });
    return { buf: out, format: "I420P10", w, h, info: fi };
  }
  // 10-bit → 8-bit：單純右移（不做 dither），JS 迴圈
  const out = new Uint8Array(w * h + 2 * cw * ch);
  const h16 = new Uint16Array(heap.buffer, heap.byteOffset, heap.byteLength >> 1);
  let o = 0;
  planes.forEach(([pw, ph], i) => {
    for (let y = 0; y < ph; y++) {
      let s = (data[i] + y * ls[i]) >> 1;
      for (let x = 0; x < pw; x++) out[o++] = h16[s++] >> 2;
    }
  });
  return { buf: out, format: "I420", w, h, info: fi };
}
