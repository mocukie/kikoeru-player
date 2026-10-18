// Engine 對 libav.js 的薄介面：Worker 的其他模組只透過這裡使用 libav.js，libav.js 的型別不離開這個檔案。
// libav.js 以 noworker 模式在 media Worker 內執行；每個來源一個 instance，demux 與 decode 共用（ADR-0001）。

// libav.js 的 frontend（0BSD）照常 bundle 進 Worker；glue 與 wasm 是原封不動的資產，由主執行緒給 URL 與 Module
//（ADR-0005）。`#libav` 是 package.json 的 subpath import：runtime 取 frontend，型別取同一個 Release 的
// libav.types.d.ts（frontend 沒有自己的 .d.mts）。
import * as libavjs from '#libav';
import {
  AudioPipeline,
  type AudioDecoder,
  type AudioPipelineOptions,
  type DecodedAudio,
  type PacketReader,
} from './audio-pipeline.js';
import { WorkerError } from './errors.js';
import type { RawMedia, RawStream } from './probe.js';
import type { ByteSource } from './source.js';

type LibAV = libavjs.LibAV;
type Packet = libavjs.Packet;
type Frame = libavjs.Frame;

/** 以 compile 好的 Module 建立 instance；與 `WebAssembly.instantiate(module, imports)` 相同。 */
export type Instantiate = (
  module: WebAssembly.Module,
  imports: WebAssembly.Imports,
) => Promise<WebAssembly.Instance>;

/** 建立 libav instance 需要的東西：主執行緒 compile 好的 wasm、glue 的 URL，以及建立 instance 的方式。 */
export interface LibavAssets {
  module: WebAssembly.Module;
  glueUrl: string;
  /** 預設為 `WebAssembly.instantiate`；測試以它模擬建立 instance 失敗。 */
  instantiate?: Instantiate;
}

/** block reader device 在 wasm 內的檔名。 */
const DEVICE = 'input';
/** 每次 cache miss 至少讀這麼多 bytes，減少 http 請求數；快取與預讀由 Range 快取的 issue 加入。 */
const READ_BLOCK = 256 * 1024;
/** 每次 demux 讀出的封包量（bytes）。 */
const READ_LIMIT = 32 * 1024;

/** `AVSEEK_FLAG_BACKWARD`：跳到目標之前（含）最近的 keyframe。 */
const AVSEEK_FLAG_BACKWARD = 1;
const AV_DISCARD_DEFAULT = 0;
const AV_DISCARD_ALL = 48;
const AV_CHANNEL_MONO = 0x4;
const AV_CHANNEL_STEREO = 0x3;
/** `av_channel_layout_default()` 對常見聲道數的 mask；容器沒有記錄 layout 時使用。 */
const defaultChannelMasks: Readonly<Record<number, number>> = {
  1: 0x4,
  2: 0x3,
  3: 0x7,
  4: 0x107,
  5: 0x37,
  6: 0x3f,
  7: 0x13f,
  8: 0x63f,
};

let glue: Promise<unknown> | null = null;

/**
 * 來源讀取的中止：每個讀取取當下的 `signal`。`abort()` 中止進行中的讀取，之後的讀取換用新的 signal；
 * load 被中止時一律中止。
 */
class ReadGate {
  readonly #load: AbortSignal;
  #controller = new AbortController();

  constructor(load: AbortSignal) {
    this.#load = load;
    load.addEventListener(
      'abort',
      () => {
        this.#controller.abort(load.reason);
      },
      { once: true },
    );
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(): void {
    this.#controller.abort(new DOMException('讀取被 seek 中止', 'AbortError'));
    this.#controller = new AbortController();
    if (this.#load.aborted) this.#controller.abort(this.#load.reason);
  }
}

/**
 * 一個來源的 libav instance 與開好的 demuxer。被丟棄（取代、錯誤）時只要放掉參照；wasm 記憶體在 Worker
 * terminate 時歸還（ADR-0002）。
 */
export class LibavMedia {
  readonly raw: RawMedia;
  /** 媒體時間軸的原點：容器的 `start_time`（秒），沒有時為 0。 */
  readonly origin: number;
  readonly #libav: LibAV;
  readonly #fmt: number;
  readonly #streams: readonly libavjs.Stream[];
  readonly #reads: ReadGate;
  /** 目前音軌的 decoder；換音軌時釋放，seek 時 flush 後沿用。 */
  #decoder: LibavAudioDecoder | null = null;

  private constructor(
    libav: LibAV,
    fmt: number,
    streams: libavjs.Stream[],
    raw: RawMedia,
    origin: number,
    reads: ReadGate,
  ) {
    this.#libav = libav;
    this.#fmt = fmt;
    this.#streams = streams;
    this.raw = raw;
    this.origin = origin;
    this.#reads = reads;
  }

  /**
   * 中止進行中的來源讀取：等待它的 libav 呼叫（demux、seek）以錯誤結束。之後要先經 `startAudio()` 的 seek
   * 才能繼續讀（中止後直接續讀會讀到錯位的封包）。
   */
  abortReads(): void {
    this.#reads.abort();
  }

  /**
   * 建立 instance、把來源接上 block reader device 並開檔 probe。讀取以 `signal` 中止；
   * 中止後 instance 處於未知狀態，呼叫端要丟掉它。
   */
  static async open(
    assets: LibavAssets,
    source: ByteSource,
    signal: AbortSignal,
  ): Promise<LibavMedia> {
    const libav = await createInstance(assets);
    signal.throwIfAborted();
    const reads = new ReadGate(signal);
    // 同步的 AVIO 讀取經 Asyncify 接到非同步的來源；同一個 instance 同時只有一個 pending 的讀取。
    libav.onblockread = (name, position, length) => {
      const readSignal = reads.signal;
      void (async () => {
        try {
          const data = await source.read(position, Math.max(length, READ_BLOCK), readSignal);
          await libav.ff_block_reader_dev_send(name, position, data);
        } catch (error) {
          // 中止與讀取失敗都交給等待中的 libav 呼叫，它會以這個錯誤 reject。
          await libav.ff_block_reader_dev_send(name, position, null, { error });
        }
      })();
    };
    await libav.mkblockreaderdev(DEVICE, source.size);

    let fmt: number;
    let streams: libavjs.Stream[];
    try {
      [fmt, streams] = await libav.ff_init_demuxer_file(DEVICE);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WorkerError || error instanceof WebAssembly.RuntimeError) throw error;
      throw new WorkerError('FORMAT_UNSUPPORTED', '無法辨識的媒體格式', { cause: error });
    }
    signal.throwIfAborted();

    const format = await libav.AVInputFormat_name(await libav.AVFormatContext_iformat(fmt));
    const duration = int64(
      libav,
      await libav.AVFormatContext_duration(fmt),
      await libav.AVFormatContext_durationhi(fmt),
    );
    const start = int64(
      libav,
      await libav.AVFormatContext_start_time(fmt),
      await libav.AVFormatContext_start_timehi(fmt),
    );
    const raw: RawMedia = {
      format,
      duration,
      size: source.size,
      streams: await Promise.all(streams.map((s) => rawStream(libav, s))),
    };
    return new LibavMedia(libav, fmt, streams, raw, start === null ? 0 : start / 1e6, reads);
  }

  /**
   * 只讀選用的音軌（其餘 discard），回傳從 `options.startTime` 開始的這個 epoch 的供料。音軌的 decoder 與
   * filter graph 在換音軌時建立，同一條音軌沿用。
   *
   * `seek` 時先跳到 `startTime` 往前 preroll 的 keyframe，再 flush decoder 與 filter graph；pipeline 解碼並丟掉
   * 起點之前的 sample，輸出的第一個 sample 落在 `startTime`（ADR-0003）。不 seek 時接著 demuxer 目前的位置讀，
   * 只用於開檔後的第一次輸出。呼叫端要先停下前一個供料。
   */
  async startAudio(
    streamIndex: number,
    options: Omit<AudioPipelineOptions<Packet>, 'reader' | 'decoder'> & { seek: boolean },
  ): Promise<{ run(): Promise<void> }> {
    const libav = this.#libav;
    const stream = this.#streams[streamIndex];
    if (!stream) throw new WorkerError('INTERNAL', `沒有 stream ${String(streamIndex)}`);
    let decoder = this.#decoder;
    if (decoder?.streamIndex !== streamIndex) {
      for (const s of this.#streams) {
        await libav.AVStream_discard_s(s.ptr, s === stream ? AV_DISCARD_DEFAULT : AV_DISCARD_ALL);
      }
      await this.#decoder?.free();
      this.#decoder = null;
      decoder = await LibavAudioDecoder.create(libav, stream, this.origin, options.sampleRate);
      this.#decoder = decoder;
    }
    if (options.seek) {
      const codec = this.raw.streams[streamIndex]?.codec ?? '';
      // 落點在開頭附近時也往前跳：容器的第一個封包可能早於 0（例如 MP4 的 priming）。
      await this.#seek(options.startTime - (await decoder.preroll(codec)), options.signal);
      await decoder.reset();
    }
    const reader: PacketReader<Packet> = {
      read: async () => {
        const [result, packets] = await libav.ff_read_frame_multi(this.#fmt, decoder.pkt, {
          limit: READ_LIMIT,
        });
        const selected = packets[streamIndex] ?? [];
        if (result === libav.AVERROR_EOF) return { packets: selected, eof: true };
        if (result < 0 && result !== -libav.EAGAIN) {
          throw new WorkerError('FORMAT_CORRUPT', `demux 失敗：${await libav.ff_error(result)}`);
        }
        return { packets: selected, eof: false };
      },
    };
    return new AudioPipeline({ ...options, reader, decoder });
  }

  /**
   * demuxer 跳到 `time`（媒體時間，秒）之前最近的 keyframe。中止的讀取會在 block reader device 與 `pb` 留下錯誤
   * （讀到檔尾時會重丟舊的 AbortError），所以兩邊都先清掉；EOF 之後也要重設 `eof_reached`（#17）。
   * 被中止的 seek 仍回傳 0，回傳值不用來判斷中止，中止一律看 `signal`。
   */
  async #seek(time: number, signal: AbortSignal): Promise<void> {
    const libav = this.#libav;
    await libav.ff_block_reader_dev_send(DEVICE, 0, new Uint8Array(0));
    const pb = await libav.AVFormatContext_pb(this.#fmt);
    await libav.AVIOContext_error_s(pb, 0);
    await libav.AVIOContext_eof_reached_s(pb, 0);
    const seekTo = (t: number) => {
      // stream -1：以 AV_TIME_BASE（µs）表示、包含容器 start_time 的時間戳。
      const [lo, hi] = libav.f64toi64(Math.round((t + this.origin) * 1e6));
      return libav.av_seek_frame(this.#fmt, -1, lo, hi, AVSEEK_FLAG_BACKWARD);
    };
    let result = await seekTo(time);
    // 早於開頭的時間：有些 demuxer（MP3、ADTS）找不到之前的 keyframe 而失敗，改跳到開頭。
    if (result < 0 && time < 0 && !signal.aborted) result = await seekTo(0);
    signal.throwIfAborted();
    if (result < 0) {
      throw new WorkerError('FORMAT_CORRUPT', `seek 失敗：${await libav.ff_error(result)}`);
    }
  }
}

/** 一條音軌的 decoder 與 filter graph（重採樣、downmix 到 stereo、轉 fltp）。 */
class LibavAudioDecoder implements AudioDecoder<Packet> {
  readonly streamIndex: number;
  readonly channels: 1 | 2;
  readonly pkt: number;
  readonly #libav: LibAV;
  readonly #ctx: number;
  readonly #frame: number;
  readonly #origin: number;
  readonly #sampleRate: number;
  /** decoder 的 time_base 是 1/這個取樣率，frame 的 pts 以它為單位。 */
  readonly #inputRate: number;
  /** 依第一個 frame 的格式建立；格式中途改變時重建。 */
  #graph: { key: string; graph: number; src: number; sink: number } | null = null;

  private constructor(
    libav: LibAV,
    streamIndex: number,
    ctx: number,
    pkt: number,
    frame: number,
    channels: 1 | 2,
    origin: number,
    sampleRate: number,
    inputRate: number,
  ) {
    this.#libav = libav;
    this.streamIndex = streamIndex;
    this.#ctx = ctx;
    this.pkt = pkt;
    this.#frame = frame;
    this.channels = channels;
    this.#origin = origin;
    this.#sampleRate = sampleRate;
    this.#inputRate = inputRate;
  }

  static async create(
    libav: LibAV,
    stream: libavjs.Stream,
    origin: number,
    sampleRate: number,
  ): Promise<LibavAudioDecoder> {
    const inputRate = await libav.AVCodecParameters_sample_rate(stream.codecpar);
    if (!(inputRate > 0)) throw new WorkerError('CODEC_UNSUPPORTED', '音軌沒有取樣率');
    let opened: [number, number, number, number];
    try {
      // 封包與 frame 的時間戳都換成 1/輸入取樣率，與 filter graph 的 abuffer 一致。
      opened = await libav.ff_init_decoder(stream.codec_id, {
        codecpar: stream.codecpar,
        time_base: [1, inputRate],
      });
    } catch (error) {
      throw new WorkerError('CODEC_UNSUPPORTED', '無法開啟音訊 decoder', { cause: error });
    }
    const [, ctx, pkt, frame] = opened;
    await libav.AVCodecContext_pkt_timebase_s(ctx, 1, inputRate);
    const channels = await libav.AVCodecContext_channels(ctx);
    return new LibavAudioDecoder(
      libav,
      stream.index,
      ctx,
      pkt,
      frame,
      channels === 1 ? 1 : 2,
      origin,
      sampleRate,
      inputRate,
    );
  }

  async decode(packet: Packet): Promise<DecodedAudio[]> {
    const frames = await this.#libav.ff_decode_multi(this.#ctx, this.pkt, this.#frame, [packet], {
      copyoutFrame: 'ptr',
    });
    return this.#filter(frames, false);
  }

  async flush(): Promise<DecodedAudio[]> {
    const frames = await this.#libav.ff_decode_multi(this.#ctx, this.pkt, this.#frame, [], {
      fin: true,
      copyoutFrame: 'ptr',
    });
    return this.#filter(frames, true);
  }

  /**
   * seek 時要往前多解的秒數，讓輸出在目標位置之前收斂（ADR-0003）：AAC 1 個 frame、MP3 2 個、Vorbis 1 個封包
   *（取最長的 block 4096 sample 估）、Opus 固定 80 ms（不讀容器的 `seek_preroll`，理由見 ADR-0003）、FLAC 與 PCM
   * 不需要。
   */
  async preroll(codec: string): Promise<number> {
    const frameSize = await this.#libav.AVCodecContext_frame_size(this.#ctx);
    switch (codec) {
      case 'aac':
        return (frameSize || 1024) / this.#inputRate;
      case 'mp3':
        return (2 * (frameSize || 1152)) / this.#inputRate;
      case 'vorbis':
        return 4096 / this.#inputRate;
      case 'opus':
        return 0.08;
      default:
        return 0;
    }
  }

  /** seek 之後：`avcodec_flush_buffers`（不重開 decoder，避免重裁 `initial_padding`），filter graph 重建。 */
  async reset(): Promise<void> {
    await this.#libav.avcodec_flush_buffers(this.#ctx);
    if (this.#graph) await this.#libav.avfilter_graph_free_js(this.#graph.graph);
    this.#graph = null;
  }

  /** 釋放 decoder 與 filter graph。 */
  async free(): Promise<void> {
    if (this.#graph) await this.#libav.avfilter_graph_free_js(this.#graph.graph);
    this.#graph = null;
    await this.#libav.ff_free_decoder(this.#ctx, this.pkt, this.#frame);
  }

  packetDuration(packet: Packet): number {
    const duration = (packet.duration ?? 0) + (packet.durationhi ?? 0) * 2 ** 32;
    const num = packet.time_base_num ?? 0;
    const den = packet.time_base_den ?? 0;
    return duration > 0 && num > 0 && den > 0 ? (duration * num) / den : 0;
  }

  async #filter(frames: number[], fin: boolean): Promise<DecodedAudio[]> {
    const libav = this.#libav;
    const out: Frame[] = [];
    for (const frame of frames) {
      const graph = await this.#graphFor(frame);
      out.push(...(await libav.ff_filter_multi(graph.src, graph.sink, this.#frame, [frame])));
    }
    if (fin && this.#graph) {
      out.push(
        ...(await libav.ff_filter_multi(this.#graph.src, this.#graph.sink, this.#frame, [], true)),
      );
    }
    return out.map((f) => ({ planes: f.data as Float32Array[], time: this.#time(f) }));
  }

  /**
   * filter graph：abuffer →（之後插入 atempo 的位置）→ aformat（fltp、`sampleRate`、mono 或 stereo）→ abuffersink。
   * 重採樣與 downmix 由 FFmpeg 自動插入的 aresample 以 swresample 的預設係數處理。mono 輸出 mono，
   * 由 pipeline 複製到兩個聲道（swresample 會把 mono 以 -3 dB 分到兩邊）。
   */
  async #graphFor(frame: number): Promise<{ graph: number; src: number; sink: number }> {
    const libav = this.#libav;
    const format = await libav.AVFrame_format(frame);
    const rate = await libav.AVFrame_sample_rate(frame);
    const channels = await libav.AVFrame_channels(frame);
    const mask =
      (await libav.AVFrame_channel_layoutmask(frame)) ||
      (defaultChannelMasks[channels] ?? AV_CHANNEL_STEREO);
    const key = `${String(format)}:${String(rate)}:${String(mask)}`;
    if (this.#graph?.key === key) return this.#graph;
    if (this.#graph) await libav.avfilter_graph_free_js(this.#graph.graph);
    const [graph, src, sink] = await libav.ff_init_filter_graph(
      // 不轉換的 filter；atempo 由變速的 issue 插在這裡。
      'aformat',
      {
        sample_rate: rate,
        channel_layout: mask,
        // ff_init_filter_graph 把 0（u8）當成未指定，所以 u8 以名稱傳入。
        sample_fmt: format === libav.AV_SAMPLE_FMT_U8 ? ('u8' as unknown as number) : format,
        // frame 的 pts 沿用 decoder 的 time_base。
        time_base: [1, this.#inputRate],
      },
      {
        sample_rate: this.#sampleRate,
        channel_layout: this.channels === 1 ? AV_CHANNEL_MONO : AV_CHANNEL_STEREO,
        sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
      },
    );
    this.#graph = { key, graph, src, sink };
    return this.#graph;
  }

  #time(frame: Frame): number | null {
    const num = frame.time_base_num ?? 0;
    const den = frame.time_base_den ?? 0;
    if (frame.pts === undefined || !(num > 0 && den > 0)) return null;
    const pts = int64(this.#libav, frame.pts, frame.ptshi ?? 0);
    if (pts === null) return null;
    return (pts * num) / den - this.#origin;
  }
}

async function createInstance(assets: LibavAssets): Promise<LibAV> {
  glue ??= import(/* @vite-ignore */ assets.glueUrl).then(
    (m: { default: unknown }) => m.default,
    (error: unknown) => {
      glue = null;
      throw new WorkerError('ASSET_LOAD_FAILED', `無法載入 ${assets.glueUrl}`, { cause: error });
    },
  );
  const factory = (await glue) as (options: object) => Promise<unknown>;
  const instantiate = assets.instantiate ?? ((m, imports) => WebAssembly.instantiate(m, imports));
  return libavjs.LibAV({
    noworker: true,
    // 用主執行緒 compile 好的 Module 建立 instance，不再下載與編譯 wasm。glue 的 instantiateWasm 沒有回報失敗的
    // 途徑：instantiate 失敗時它的 Module promise 永遠不會 settle，所以由外層的 promise 直接 reject。
    factory: (options: object) =>
      new Promise((resolve, reject) => {
        factory({
          ...options,
          instantiateWasm(
            imports: WebAssembly.Imports,
            receive: (instance: WebAssembly.Instance) => void,
          ) {
            instantiate(assets.module, imports)
              .then(receive)
              .catch((error: unknown) => {
                reject(instantiateError(error));
              });
            return {};
          },
        }).then(resolve, reject);
      }),
  });
}

/**
 * 建立 instance 失敗的分類：
 * - `RangeError`：配置不到 linear memory（記憶體吃緊、同一個 Worker 內 instance 過多）→ `MEMORY_LIMIT`。
 *   只有這個 load 失敗、Worker 仍可使用，所以以 `error` 回報，不走 `crash` 的 `out-of-memory`。
 * - 其他（imports 不符的 `LinkError`／`TypeError`、glue 收下 instance 時找不到 export）：資產與 glue 不相符
 *   → `ASSET_LOAD_FAILED`。
 */
function instantiateError(error: unknown): WorkerError {
  if (error instanceof RangeError) {
    return new WorkerError('MEMORY_LIMIT', '無法配置 wasm 記憶體', { cause: error });
  }
  return new WorkerError('ASSET_LOAD_FAILED', 'wasm 與 glue 不相符', { cause: error });
}

async function rawStream(libav: LibAV, s: libavjs.Stream): Promise<RawStream> {
  const cp = s.codecpar;
  const type =
    s.codec_type === libav.AVMEDIA_TYPE_AUDIO
      ? 'audio'
      : s.codec_type === libav.AVMEDIA_TYPE_VIDEO
        ? 'video'
        : s.codec_type === libav.AVMEDIA_TYPE_SUBTITLE
          ? 'subtitle'
          : 'other';
  const sampleFormat = type === 'audio' ? await libav.AVCodecParameters_format(cp) : -1;
  const frameRateNum = await libav.AVCodecParameters_framerate_num(cp);
  const frameRateDen = await libav.AVCodecParameters_framerate_den(cp);
  const extradataSize = await libav.AVCodecParameters_extradata_size(cp);
  const extradata =
    type === 'subtitle' && extradataSize > 0
      ? await libav.copyout_u8(await libav.AVCodecParameters_extradata(cp), extradataSize)
      : null;
  return {
    index: s.index,
    type,
    codec: await libav.avcodec_get_name(s.codec_id),
    decodable: (await libav.avcodec_find_decoder(s.codec_id)) !== 0,
    sampleRate: await libav.AVCodecParameters_sample_rate(cp),
    channels: await libav.AVCodecParameters_ch_layout_nb_channels(cp),
    channelMask: await libav.AVCodecParameters_channel_layoutmask(cp),
    sampleFormat: sampleFormat >= 0 ? await libav.av_get_sample_fmt_name(sampleFormat) : null,
    width: await libav.AVCodecParameters_width(cp),
    height: await libav.AVCodecParameters_height(cp),
    frameRate: frameRateNum > 0 && frameRateDen > 0 ? frameRateNum / frameRateDen : null,
    metadata: s.metadata ?? {},
    disposition: await libav.AVStream_disposition(s.ptr),
    extradata,
  };
}

/** libav.js 以 lo／hi 兩個 32-bit 數字表示 int64；`AV_NOPTS_VALUE` 為 null。 */
function int64(libav: LibAV, lo: number, hi: number): number | null {
  const value = libav.i64tof64(lo, hi);
  return value === libav.AV_NOPTS_VALUE ? null : value;
}
