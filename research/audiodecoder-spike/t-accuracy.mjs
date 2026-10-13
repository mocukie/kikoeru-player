// 拋棄式 spike（#18）：AudioDecoder 與 FFmpeg（wasm）的輸出是否逐 sample 對齊。
// 基準（truth）：同一訊號的 FLAC（無失真、沒有 encoder delay）經 FFmpeg 解碼。lag = 輸出比 truth 多出的前導 sample 數。
import { createLibAV } from "./lib.mjs";
import { openAudio, readAllPackets, skipInfo, wasmDecode, adDecode, adConfig, findLag, diff, usOf, supported } from "./audio.mjs";

const FILES = ["acc-aac.m4a", "acc-fdk.m4a", "acc-aac.aac", "acc-mp3.mp3", "acc-mp3-noxing.mp3", "acc-opus.opus", "acc-opus.webm",
  "acc-flac.flac", "acc-vorbis.ogg", "acc-vorbis.webm"];

export async function run({ files = FILES } = {}, progress) {
  const lib = await createLibAV();
  const truth = {};
  const getTruth = async (sr) => {
    if (truth[sr]) return truth[sr];
    const f = sr === 44100 ? "acc-flac44.flac" : "acc-flac.flac";
    const o = await openAudio(lib, `/media/${f}`);
    const pk = await readAllPackets(lib, o.fmt, o.index ?? o.info.index);
    truth[sr] = (await wasmDecode(lib, o.info, o.stream.codecpar, pk))[0];
    return truth[sr];
  };
  const out = {};
  for (const f of files) {
    progress?.(f);
    const r = out[f] = {};
    try {
      const o = await openAudio(lib, `/media/${f}`);
      const { info } = o;
      const pk = await readAllPackets(lib, o.fmt, info.index);
      const sr = info.sample_rate;
      const T = await getTruth(sr);
      const skips = pk.map((p, i) => [i, skipInfo(p)]).filter(([, s]) => s).map(([i, s]) => ({ pkt: i, ...s }));
      r.info = { codec: info.codec, sr, ch: info.channels, initial_padding: info.initial_padding, trailing_padding: info.trailing_padding,
        seek_preroll: info.seek_preroll, frame_size: info.frame_size, start_time: info.start_time, tb: `${info.tb_num}/${info.tb_den}`,
        packets: pk.length, firstPktUs: usOf(info, pk[0]), firstPktDur: pk[0].duration, skips, extradata: info.extradata?.length ?? 0,
        config: { ...adConfig(info), description: adConfig(info).description?.length } };
      const from = 3 * sr;
      const ff = (await wasmDecode(lib, info, o.stream.codecpar, pk))[0];
      const ffRaw = (await wasmDecode(lib, info, o.stream.codecpar, pk, { strip: true }))[0];
      const ffLag = findLag(T, ff, { from }), ffRawLag = findLag(T, ffRaw, { from });
      r.ffmpeg = { len: ff.length, lenDiff: ff.length - T.length, lag: ffLag.lag, corr: ffLag.corr, vsTruth: diff(T, ff, ffLag.lag, { skipHead: 2048, skipTail: 2048 }),
        rawLen: ffRaw.length, rawLag: ffRawLag.lag };
      r.truthLen = T.length;
      const variants = { ad: adConfig(info) };
      if (info.codec === "opus" || (info.codec === "aac" && info.extradata)) variants.adNoDesc = adConfig(info, { withDescription: false });
      variants.adShift = adConfig(info); // 所有 timestamp +1 秒：看輸出 timestamp 是照抄輸入還是被改寫
      for (const [k, cfg] of Object.entries(variants)) {
        let sup = null;
        progress?.(`${f} ${k}`);
        sup = await supported(cfg);
        const a = await adDecode(info, pk, { config: cfg, tsOffset: k === "adShift" ? 1e6 : 0 });
        const x = r[k] = { supported: sup, error: a.error, format: a.format, converted: a.converted, outputs: a.meta.length };
        if (!a.planes?.length || !a.planes[0].length) continue;
        const A = a.planes[0];
        const lag = findLag(T, A, { from });
        // timestamp：第一個輸出與第一個封包；相鄰 AudioData 的 timestamp 是否連續
        let maxGapUs = 0;
        for (let i = 1; i < a.meta.length; i++) {
          const exp = a.meta[i - 1].ts + a.meta[i - 1].n / a.meta[i - 1].sr * 1e6;
          maxGapUs = Math.max(maxGapUs, Math.abs(a.meta[i].ts - exp));
        }
        Object.assign(x, {
          len: A.length, lenDiff: A.length - T.length, lag: lag.lag, corr: lag.corr,
          tailExtra: (A.length - lag.lag) - T.length,
          firstTs: a.meta.find((m) => m.n).ts, firstN: a.meta.find((m) => m.n).n, zeroOutputs: a.meta.filter((m) => !m.n).length, outSr: a.meta[0].sr, outCh: a.meta[0].ch, maxTsGapUs: Math.round(maxGapUs),
          vsTruth: diff(T, A, lag.lag, { skipHead: 2048, skipTail: 2048 }),
          // 與 FFmpeg 未裁切輸出逐 sample 比較（對齊後）
          vsFFmpegRaw: diff(ffRaw, A, lag.lag - ffRawLag.lag, { skipHead: 0, skipTail: 0 }),
          vsFFmpegRawInterior: diff(ffRaw, A, lag.lag - ffRawLag.lag, { skipHead: 4096, skipTail: 4096 }),
        });
      }
      await lib.avformat_close_input_js(o.fmt);
      await lib.unlink(o.name);
    } catch (e) { r.error = String(e?.stack ?? e).slice(0, 800); }
  }
  return out;
}
