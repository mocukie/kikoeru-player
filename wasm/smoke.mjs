// wasm 的 smoke test（由 build.sh 在 build image 內執行）：在 Node 以 noworker 載入產物，
// 對每個媒體檔 demux、解碼並經 filter graph 輸出 fltp，也確認 libavjs-accessors.patch 加入的函式可用。
// 用法：node smoke.mjs <dist 目錄> <產物名稱，例如 libav-6.10.9.0-kikoeru> <媒體目錄>
// 媒體由 build.sh 產生：每個檔案 1 秒、48 kHz stereo、振幅約 0.09 的正弦波；multi.mka 的兩軌分別是 default 與 forced，容器時間從 1 秒開始。
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distArg, name, mediaDir] = process.argv.slice(2);
// frontend 以 base 組出 glue 的路徑再 import，所以要用絕對路徑。
const dist = resolve(distArg);
const { default: LibAV } = await import(pathToFileURL(join(dist, `${name}.mjs`)).href);
const libav = await LibAV.LibAV({ noworker: true, base: dist });

const SAMPLE_RATE = 48000;
const AV_DISPOSITION_DEFAULT = 0x1;
const AV_DISPOSITION_FORCED = 0x40;
const failures = [];

function check(ok, message) {
  if (!ok) failures.push(message);
}

/** libav.js 以 lo／hi 兩個 32-bit 數字表示 int64。 */
function int64(lo, hi) {
  return hi * 2 ** 32 + (lo >>> 0);
}

/** 解碼一條音軌：前半與後半之間以 avfilter_graph_send_command 改 atempo（patch 加入的函式）。 */
async function decode(stream, packets) {
  const [, ctx, pkt, frame] = await libav.ff_init_decoder(stream.codec_id, {
    codecpar: stream.codecpar,
  });
  // 沒有 channel mask 的 WAV（例如 IEEE float）layout 未指定，abuffer 不收，依聲道數補上預設值。
  const mask = await libav.AVCodecContext_channel_layoutmask(ctx);
  const channels = await libav.AVCodecContext_channels(ctx);
  const io = {
    sample_rate: await libav.AVCodecContext_sample_rate(ctx),
    channel_layout: mask || (channels === 1 ? 0x4 : 0x3),
  };
  // libav.js 的 ff_init_filter_graph 把 sample_fmt 為 0（u8）當成未指定而改用 flt，所以 u8 以名稱傳入。
  const sampleFormat = await libav.AVCodecContext_sample_fmt(ctx);
  const [graph, src, sink] = await libav.ff_init_filter_graph(
    'atempo=1',
    { ...io, sample_fmt: sampleFormat === libav.AV_SAMPLE_FMT_U8 ? 'u8' : sampleFormat },
    { ...io, sample_fmt: libav.AV_SAMPLE_FMT_FLTP },
  );
  const half = Math.floor(packets.length / 2);
  const first = await libav.ff_decode_filter_multi(
    ctx,
    src,
    sink,
    pkt,
    frame,
    packets.slice(0, half),
  );
  const command = await libav.avfilter_graph_send_command(graph, 'atempo', 'tempo', '1', 0, 0, 0);
  const rest = await libav.ff_decode_filter_multi(
    ctx,
    src,
    sink,
    pkt,
    frame,
    packets.slice(half),
    true,
  );
  await libav.avfilter_graph_free_js(graph);
  await libav.ff_free_decoder(ctx, pkt, frame);

  const frames = [...first, ...rest];
  let peak = 0;
  for (const f of frames)
    for (const plane of f.data) for (const s of plane) peak = Math.max(peak, Math.abs(s));
  return {
    command,
    samples: frames.reduce((sum, f) => sum + f.nb_samples, 0),
    formats: new Set(frames.map((f) => f.format)),
    rates: new Set(frames.map((f) => f.sample_rate)),
    peak,
  };
}

const files = (await readdir(mediaDir)).sort();
check(files.length > 0, `${mediaDir} 沒有媒體檔`);
for (const file of files) {
  await libav.writeFile(file, new Uint8Array(await readFile(join(mediaDir, file))));
  const [fmt, streams] = await libav.ff_init_demuxer_file(file);
  const pkt = await libav.av_packet_alloc();
  const [, packets] = await libav.ff_read_frame_multi(fmt, pkt);
  const audio = streams.filter((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);
  check(audio.length > 0, `${file}：沒有音軌`);

  // 容器格式名稱的 accessor（MediaInfo.format）。
  const formatName = await libav.AVInputFormat_name(await libav.AVFormatContext_iformat(fmt));
  check(
    typeof formatName === 'string' && formatName.length > 0,
    `${file}：容器格式名稱是 ${formatName}`,
  );
  if (file === 'multi.mka') {
    check(formatName === 'matroska,webm', `multi.mka：容器格式名稱是 ${formatName}`);
  }

  for (const stream of audio) {
    const codec = await libav.avcodec_get_name(stream.codec_id);
    const label = `${file} #${stream.index}（${codec}）`;
    const result = await decode(stream, packets[stream.index] ?? []);
    // 開頭的 priming 與結尾的 padding 不一定被裁掉（ADTS 等），容許 ±10%。
    check(
      Math.abs(result.samples - SAMPLE_RATE) <= SAMPLE_RATE * 0.1,
      `${label}：解出 ${result.samples} 個 sample`,
    );
    check(
      result.formats.size === 1 && result.formats.has(libav.AV_SAMPLE_FMT_FLTP),
      `${label}：輸出不是 fltp`,
    );
    check(
      result.rates.size === 1 && result.rates.has(SAMPLE_RATE),
      `${label}：取樣率不是 ${SAMPLE_RATE}`,
    );
    check(result.peak > 0.05, `${label}：輸出是靜音（peak ${result.peak}）`);
    check(result.command === 0, `${label}：avfilter_graph_send_command 回傳 ${result.command}`);
    console.log(`${label}：${result.samples} samples，peak ${result.peak.toFixed(2)}`);
  }

  if (file === 'multi.mka') {
    const disposition = await Promise.all(audio.map((s) => libav.AVStream_disposition(s.ptr)));
    check(
      disposition.length === 2 &&
        (disposition[0] & AV_DISPOSITION_DEFAULT) !== 0 &&
        (disposition[1] & AV_DISPOSITION_FORCED) !== 0,
      `multi.mka：disposition 是 ${disposition.join(', ')}`,
    );
    for (const s of audio) {
      const start = int64(
        await libav.AVStream_start_time(s.ptr),
        await libav.AVStream_start_timehi(s.ptr),
      );
      const seconds = (start * s.time_base_num) / s.time_base_den;
      check(Math.abs(seconds - 1) < 0.05, `multi.mka #${s.index}：start_time 是 ${seconds} 秒`);
    }
  }

  // AVIOContext 的 accessor：讀取被中止後，Engine 以 setter 把 error／eof_reached 清為 0。
  const pb = await libav.AVFormatContext_pb(fmt);
  for (const [field, value] of [
    ['error', -1],
    ['eof_reached', 1],
  ]) {
    await libav[`AVIOContext_${field}_s`](pb, value);
    const set = await libav[`AVIOContext_${field}`](pb);
    await libav[`AVIOContext_${field}_s`](pb, 0);
    const cleared = await libav[`AVIOContext_${field}`](pb);
    check(
      set === value && cleared === 0,
      `${file}：AVIOContext_${field} 讀寫不一致（${set}、${cleared}）`,
    );
  }

  await libav.av_packet_free_js(pkt);
  await libav.avformat_close_input_js(fmt);
  await libav.unlink(file);
}
// 中止讀取後清掉 block reader device 的錯誤要用這個函式（libav.js 本身就有，確認 variant 有包含）。
check(typeof libav.ff_block_reader_dev_send === 'function', '沒有 ff_block_reader_dev_send');

libav.terminate();
if (failures.length > 0) {
  console.error(`smoke test 失敗：\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`smoke test 通過：${files.length} 個檔案`);
