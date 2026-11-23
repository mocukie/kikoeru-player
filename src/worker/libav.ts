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
} from './audio-pipeline.js';
import { Demuxer, type DemuxerOptions, type HoldableLane, type PacketReader } from './demuxer.js';
import { AudioDecoderError, crashReason, WorkerError } from './errors.js';
import type { RawMedia, RawStream } from './probe.js';
import type { ByteSource } from './source.js';
import type { SubtitlePacket } from './subtitles.js';
import type { Stereo, Stretcher } from './tempo.js';
import { withParameterSets } from './video-codec.js';
import type { VideoChunk } from './video-pipeline.js';

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
/** block reader device 每次至少要這麼多 bytes（一個 Range 快取的區塊），減少 wasm 與 JS 之間的往返。 */
const READ_BLOCK = 256 * 1024;
/** 每次 demux 讀出的封包量（bytes）。 */
const READ_LIMIT = 32 * 1024;

/** `AVSEEK_FLAG_BACKWARD`：跳到目標之前（含）最近的 keyframe。 */
const AVSEEK_FLAG_BACKWARD = 1;
const AV_DISCARD_DEFAULT = 0;
const AV_DISCARD_ALL = 48;
/** `AV_PKT_DATA_DISPLAYMATRIX`：codecpar 的 coded side data 中的 display matrix。 */
const AV_PKT_DATA_DISPLAYMATRIX = 5;
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
  readonly #libav: LibAV;
  /** 媒體時間軸的原點（秒）：預設為容器的 `start_time`（沒有時為 0），`alignTo()` 改為一條 stream 的開頭。 */
  #origin: number;
  /** 各 stream 的第一個可播放 sample（`AVStream.start_time`，秒，FFmpeg 已加上要跳過的 sample）；沒有記錄時為 null。 */
  readonly #streamStarts: readonly (number | null)[];
  readonly #fmt: number;
  readonly #streams: readonly libavjs.Stream[];
  readonly #reads: ReadGate;
  /** instance 的 linear memory；glue 收下 instance 時找不到時為 null。 */
  readonly #memory: WebAssembly.Memory | null;
  /** demux 專用的 AVPacket：demux 與解碼同時進行，不能共用 decoder 的 packet。 */
  readonly #demuxPkt: number;
  /** 目前音軌的 decoder；換音軌時釋放，seek 時 flush 後沿用。 */
  #decoder: LibavAudioDecoder | null = null;
  /** 目前沒有 discard 的 stream（`audio,video,subtitle`）；選擇改變時重設各 stream 的 discard。 */
  #selection = '';

  private constructor(
    libav: LibAV,
    fmt: number,
    streams: libavjs.Stream[],
    raw: RawMedia,
    origin: number,
    streamStarts: readonly (number | null)[],
    reads: ReadGate,
    demuxPkt: number,
    memory: WebAssembly.Memory | null,
  ) {
    this.#memory = memory;
    this.#libav = libav;
    this.#demuxPkt = demuxPkt;
    this.#fmt = fmt;
    this.#streams = streams;
    this.raw = raw;
    this.#origin = origin;
    this.#streamStarts = streamStarts;
    this.#reads = reads;
  }

  /** 媒體時間軸的原點（秒）：容器時間 − 原點 = 媒體時間。 */
  get origin(): number {
    return this.#origin;
  }

  /**
   * 以 `stream` 的第一個可播放 sample 為媒體時間軸的原點（外掛音軌：它自己的 0 點對齊媒體的 0，不是容器的
   * `start_time`）。解碼的時間、demux 的進度與 seek 都依它換算。stream 沒有記錄開頭時沿用容器的 `start_time`。
   * 在第一次 `startOutput()` 之前呼叫。
   */
  alignTo(stream: number): void {
    const start = this.#streamStarts[stream];
    if (start != null) this.#origin = start;
  }

  /** instance 的 wasm heap（linear memory）目前的大小（bytes）。 */
  get heapBytes(): number {
    return this.#memory?.buffer.byteLength ?? 0;
  }

  /**
   * 中止進行中的來源讀取：等待它的 libav 呼叫（demux、seek）以錯誤結束。之後要先經 `startOutput()` 的 seek
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
    const { libav, memory } = await createInstance(assets);
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
      if (error instanceof WorkerError || crashReason(error) !== null) throw error;
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
    const streamStarts = await Promise.all(
      streams.map(async (s) => {
        const ts = int64(
          libav,
          await libav.AVStream_start_time(s.ptr),
          await libav.AVStream_start_timehi(s.ptr),
        );
        const { time_base_num: num, time_base_den: den } = s;
        return ts === null || !(num > 0 && den > 0) ? null : (ts * num) / den;
      }),
    );
    const demuxPkt = await libav.av_packet_alloc();
    return new LibavMedia(
      libav,
      fmt,
      streams,
      raw,
      start === null ? 0 : start / 1e6,
      streamStarts,
      reads,
      demuxPkt,
      memory(),
    );
  }

  /**
   * 開始一個 epoch 的輸出：只 demux 選用的音軌、影片軌與字幕軌（其餘 discard），回傳這個 epoch 的 demuxer、音訊的供料
   * 與影片的封包 lane；字幕軌的封包不進封包佇列，每批 demux 讀到的直接交給 `subtitle.onPackets`。音軌的 decoder 與
   * filter graph 在換音軌時建立，同一條音軌沿用。
   *
   * `seek` 時先跳到 `startTime` 往前 preroll 的 keyframe（有影片軌時，libavformat 以影片軌的 keyframe 為準），再 flush
   * 音訊的 decoder 與 filter graph；pipeline 解碼並丟掉起點之前的 sample，輸出的第一個 sample 落在 `startTime`
   *（ADR-0003）。不 seek 時接著 demuxer 目前的位置讀，只用於開檔後的第一次輸出。呼叫端要先停下前一個輸出。
   *
   * `audioOffset`（音軌 offset，秒）：音訊從來源的 `startTime − audioOffset` 開始（小於 0 時從頭開始，pipeline 在起點前
   * 補靜音）。同時 demux 影片軌或字幕軌時跳到兩者中較早的位置，影片的 pipeline 丟掉起點之前的 frame。只 demux 音軌時，
   * demux 的進度（`onDemux`）換算回媒體時間。
   */
  async startOutput(options: {
    audio: number | null;
    video: number | null;
    subtitle: { stream: number; onPackets: (packets: SubtitlePacket[]) => void } | null;
    /** 音軌 offset（秒）；省略時為 0。 */
    audioOffset?: number;
    seek: boolean;
    startTime: number;
    signal: AbortSignal;
    demux: Omit<DemuxerOptions<Packet>, 'reader' | 'streams' | 'sparse' | 'startTime'>;
    audioOptions: Omit<
      AudioPipelineOptions<Packet>,
      'packets' | 'fatal' | 'decoder' | 'createStretcher' | 'startTime' | 'signal'
    >;
  }): Promise<{
    demuxer: Demuxer<Packet>;
    audio: AudioPipeline<Packet> | null;
    /** 影片軌的 lane，封包已轉成 chunk（沒有時間戳的封包為 null）。 */
    video: HoldableLane<VideoChunk | null> | null;
  }> {
    const libav = this.#libav;
    const streams = [options.audio, options.video].filter((s): s is number => s !== null);
    const subtitle = options.subtitle;
    // 只 demux 字幕軌：另外 demux 一條音軌（沒有時影片軌）推進 demux 進度，封包直接丟掉（見 `DemuxerOptions.progress`）。
    const progress = streams.length === 0 && subtitle ? this.#progressStream() : null;
    const demuxed = [
      ...streams,
      ...(subtitle ? [subtitle.stream] : []),
      ...(progress === null ? [] : [progress]),
    ];
    for (const index of demuxed) {
      if (!this.#streams[index]) throw new WorkerError('INTERNAL', `沒有 stream ${String(index)}`);
    }
    const selection = [options.audio, options.video, subtitle?.stream ?? null, progress].join(',');
    if (selection !== this.#selection) {
      for (const s of this.#streams) {
        await libav.AVStream_discard_s(
          s.ptr,
          demuxed.includes(s.index) ? AV_DISCARD_DEFAULT : AV_DISCARD_ALL,
        );
      }
      this.#selection = selection;
    }
    let decoder = this.#decoder;
    if (options.audio !== null && decoder?.streamIndex !== options.audio) {
      await decoder?.free();
      this.#decoder = null;
      const stream = this.#streams[options.audio];
      if (!stream) throw new WorkerError('INTERNAL', `沒有 stream ${String(options.audio)}`);
      decoder = await LibavAudioDecoder.create(
        libav,
        stream,
        this.origin,
        options.audioOptions.sampleRate,
      );
      this.#decoder = decoder;
    }
    const audioDecoder = options.audio === null ? null : decoder;
    const audioOffset = options.audioOffset ?? 0;
    // 只 demux 音軌：demuxer 的時間是來源的時間（媒體時間 − offset）。
    const audioOnly = audioDecoder !== null && options.video === null && subtitle === null;
    if (options.seek) {
      const codec = options.audio === null ? '' : (this.raw.streams[options.audio]?.codec ?? '');
      const preroll = audioDecoder ? await audioDecoder.preroll(codec) : 0;
      const audioStart = options.startTime - audioOffset - preroll;
      // 落點在開頭附近時也往前跳：容器的第一個封包可能早於 0（例如 MP4 的 priming）。
      const target = !audioDecoder
        ? options.startTime
        : audioOnly
          ? audioStart
          : Math.min(options.startTime, audioStart);
      await this.#seek(target, options.signal);
      await audioDecoder?.reset();
    }
    const { onDemux } = options.demux;
    const demuxOptions =
      audioOnly && audioOffset !== 0 && onDemux
        ? {
            ...options.demux,
            onDemux: (end: number, eof: boolean) => {
              onDemux(end + audioOffset, eof);
            },
          }
        : options.demux;
    const reader: PacketReader<Packet> = {
      read: async () => {
        const [result, packets] = await libav.ff_read_frame_multi(this.#fmt, this.#demuxPkt, {
          limit: READ_LIMIT,
        });
        const selected = demuxed.flatMap((index) => packets[index] ?? []);
        if (result === libav.AVERROR_EOF) return { packets: selected, eof: true };
        if (result < 0 && result !== -libav.EAGAIN) {
          const text = await libav.ff_error(result);
          // AVERROR(ENOMEM)：wasm 記憶體用完，交給 crash 的路線（crashReason）。
          const error = new Error(`demux 失敗：${text}`);
          if (crashReason(error) !== null) throw error;
          throw new WorkerError('FORMAT_CORRUPT', error.message);
        }
        return { packets: selected, eof: false };
      },
      measure: (packet) => ({
        stream: packet.stream_index ?? -1,
        bytes: packet.data.byteLength,
        time: this.#packetTime(packet),
        duration: packetDuration(packet),
      }),
    };
    const demuxer = new Demuxer<Packet>({
      ...demuxOptions,
      reader,
      streams,
      ...(progress !== null && { progress: [progress] }),
      ...(subtitle && {
        sparse: {
          streams: [subtitle.stream],
          onPackets: (packets) => {
            subtitle.onPackets(
              packets.map((packet) => ({
                time: this.#packetTime(packet),
                duration: packetDuration(packet),
                data: packet.data,
              })),
            );
          },
        },
      }),
      startTime: audioOnly ? options.startTime - audioOffset : options.startTime,
    });
    const audio = audioDecoder
      ? new AudioPipeline({
          ...options.audioOptions,
          packets: demuxer.lane(audioDecoder.streamIndex),
          fatal: demuxer.fatal,
          decoder: audioDecoder,
          startTime: options.startTime,
          offset: audioOffset,
          signal: options.signal,
          createStretcher: (rate) => this.createStretcher(options.audioOptions.sampleRate, rate),
        })
      : null;
    return {
      demuxer,
      audio,
      video: options.video === null ? null : this.#videoLane(demuxer, options.video),
    };
  }

  /** 推進 demux 進度用的軌：位元率最低的音軌，沒有音軌時第一條影片軌；都沒有時為 null。 */
  #progressStream(): number | null {
    const audio = this.raw.streams
      .filter((s) => s.type === 'audio')
      .sort((a, b) => a.bitRate - b.bitRate);
    return (audio[0] ?? this.raw.streams.find((s) => s.type === 'video'))?.index ?? null;
  }

  /**
   * 影片軌的封包轉成 `VideoDecoder` 的 chunk：timestamp 是媒體時間軸上的 µs（沒有 pts 時用 dts，例如 AVI），
   * Annex B 的 keyframe 補上 extradata 的參數集。沒有時間戳的封包為 null。
   */
  #videoLane(demuxer: Demuxer<Packet>, streamIndex: number): HoldableLane<VideoChunk | null> {
    const lane = demuxer.lane(streamIndex);
    const toChunk = this.#videoChunks(streamIndex);
    const keyFlag = this.#libav.AV_PKT_FLAG_KEY;
    return {
      next: async (signal) => {
        const packet = await lane.next(signal);
        return packet === undefined ? undefined : toChunk(packet);
      },
      get drained() {
        return lane.drained;
      },
      hold: (held) => {
        lane.hold(held);
      },
      entries: () =>
        lane.packets().map((packet) => ({
          key: ((packet.flags ?? 0) & keyFlag) !== 0,
          time: this.#packetTime(packet),
        })),
      trim: (count) => {
        lane.trim(count);
      },
      changed: (signal) => lane.changed(signal),
      size: (chunk) => chunk?.data.byteLength ?? 0,
      retain: (bytes) => {
        lane.retain(bytes);
      },
    };
  }

  #videoChunks(streamIndex: number): (packet: Packet) => VideoChunk | null {
    const raw = this.raw.streams[streamIndex];
    const codec = raw?.codec ?? '';
    const extradata = raw?.extradata ?? null;
    const keyFlag = this.#libav.AV_PKT_FLAG_KEY;
    return (packet) => {
      const time = this.#packetTime(packet);
      if (time === null) return null;
      const key = ((packet.flags ?? 0) & keyFlag) !== 0;
      const duration = packetDuration(packet);
      return {
        type: key ? 'key' : 'delta',
        timestamp: Math.round(time * 1e6),
        ...(duration > 0 && { duration: Math.round(duration * 1e6) }),
        data: key ? withParameterSets(codec, packet.data, extradata) : packet.data,
      };
    };
  }

  /** 建立速度為 `rate` 的 `atempo` stretcher（`sampleRate` 的 stereo fltp）。 */
  createStretcher(sampleRate: number, rate: number): Promise<Stretcher> {
    return LibavStretcher.create(this.#libav, sampleRate, rate);
  }

  /** 封包的 pts（沒有時用 dts）換算到媒體時間軸（秒）；都沒有時為 null。 */
  #packetTime(packet: Packet): number | null {
    const num = packet.time_base_num ?? 0;
    const den = packet.time_base_den ?? 0;
    if (!(num > 0 && den > 0)) return null;
    const pts = packet.pts === undefined ? null : int64(this.#libav, packet.pts, packet.ptshi ?? 0);
    const dts = packet.dts === undefined ? null : int64(this.#libav, packet.dts, packet.dtshi ?? 0);
    const ts = pts ?? dts;
    return ts === null ? null : (ts * num) / den - this.origin;
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

/**
 * `atempo` 的 stretcher：abuffer → atempo → abuffersink，輸入與輸出都是 `sampleRate` 的 stereo fltp
 * （`atempo` 只接受 packed 格式，FFmpeg 自動在前後插入轉換）。速度固定，改速度時換一個新的（tempo.ts）。
 */
class LibavStretcher implements Stretcher {
  readonly #libav: LibAV;
  readonly #graph: number;
  readonly #src: number;
  readonly #sink: number;
  readonly #frame: number;
  readonly #sampleRate: number;
  /** 下一個輸入 frame 的 pts（以 1/sampleRate 計）。 */
  #pts = 0;
  #freed = false;

  private constructor(
    libav: LibAV,
    graph: number,
    src: number,
    sink: number,
    frame: number,
    sampleRate: number,
  ) {
    this.#libav = libav;
    this.#graph = graph;
    this.#src = src;
    this.#sink = sink;
    this.#frame = frame;
    this.#sampleRate = sampleRate;
  }

  static async create(libav: LibAV, sampleRate: number, rate: number): Promise<LibavStretcher> {
    const io = {
      sample_rate: sampleRate,
      channel_layout: AV_CHANNEL_STEREO,
      sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
    };
    const [graph, src, sink] = await libav.ff_init_filter_graph(
      `atempo=tempo=${String(rate)}`,
      { ...io, time_base: [1, sampleRate] },
      io,
    );
    const frame = await libav.av_frame_alloc();
    return new LibavStretcher(libav, graph, src, sink, frame, sampleRate);
  }

  async push(input: Stereo): Promise<Stereo[]> {
    const frames = input[0].length;
    if (frames === 0) return [];
    const pts = this.#pts;
    this.#pts += frames;
    const out = await this.#libav.ff_filter_multi(this.#src, this.#sink, this.#frame, [
      {
        data: [input[0], input[1]],
        format: this.#libav.AV_SAMPLE_FMT_FLTP,
        channel_layout: AV_CHANNEL_STEREO,
        sample_rate: this.#sampleRate,
        nb_samples: frames,
        pts,
      },
    ]);
    return out.map(stereoOf);
  }

  async drain(): Promise<Stereo[]> {
    const out = await this.#libav.ff_filter_multi(this.#src, this.#sink, this.#frame, [], true);
    return out.map(stereoOf);
  }

  async free(): Promise<void> {
    if (this.#freed) return;
    this.#freed = true;
    await this.#libav.avfilter_graph_free_js(this.#graph);
    await this.#libav.av_frame_free_js(this.#frame);
  }
}

function stereoOf(frame: Frame): Stereo {
  const [left, right] = frame.data as Float32Array[];
  if (!left) return [new Float32Array(), new Float32Array()];
  return [left, right ?? left];
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
    if (!(inputRate > 0)) throw new AudioDecoderError('音軌沒有取樣率');
    let opened: [number, number, number, number];
    try {
      // 封包與 frame 的時間戳都換成 1/輸入取樣率，與 filter graph 的 abuffer 一致。
      opened = await libav.ff_init_decoder(stream.codec_id, {
        codecpar: stream.codecpar,
        time_base: [1, inputRate],
      });
    } catch (error) {
      throw new AudioDecoderError('無法開啟音訊 decoder', { cause: error });
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
    return packetDuration(packet);
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
   * filter graph：abuffer → aformat（fltp、`sampleRate`、mono 或 stereo）→ abuffersink。變速的 `atempo` 不在這裡：
   * 它接在對齊媒體時間（丟掉 preroll、補上空缺）之後，見 tempo.ts 與 `LibavStretcher`。
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
      // 不轉換的 filter；轉換由 FFmpeg 自動插入的 aresample 處理。
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

/**
 * 建立 libav instance。`memory()` 回傳 instance 匯出的 linear memory（export 名稱經過壓縮，以型別找出），
 * 供 `getStats().wasmHeapBytes`。
 */
async function createInstance(
  assets: LibavAssets,
): Promise<{ libav: LibAV; memory: () => WebAssembly.Memory | null }> {
  glue ??= import(/* @vite-ignore */ assets.glueUrl).then(
    (m: { default: unknown }) => m.default,
    (error: unknown) => {
      glue = null;
      throw new WorkerError('ASSET_LOAD_FAILED', `無法載入 ${assets.glueUrl}`, { cause: error });
    },
  );
  const factory = (await glue) as (options: object) => Promise<unknown>;
  const instantiate = assets.instantiate ?? ((m, imports) => WebAssembly.instantiate(m, imports));
  let memory: WebAssembly.Memory | null = null;
  const libav = await libavjs.LibAV({
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
              .then((instance) => {
                memory =
                  Object.values(instance.exports).find(
                    (value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory,
                  ) ?? null;
                receive(instance);
              })
              .catch((error: unknown) => {
                reject(instantiateError(error));
              });
            return {};
          },
        }).then(resolve, reject);
      }),
  });
  return { libav, memory: () => memory };
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
    (type === 'subtitle' || type === 'video') && extradataSize > 0
      ? await libav.copyout_u8(await libav.AVCodecParameters_extradata(cp), extradataSize)
      : null;
  const video = type === 'video';
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
    bitRate: await libav.AVCodecParameters_bit_rate(cp),
    profile: await libav.AVCodecParameters_profile(cp),
    level: await libav.AVCodecParameters_level(cp),
    displayMatrix: video ? await displayMatrix(libav, cp) : null,
    sampleAspectRatio: video ? await streamSampleAspectRatio(libav, s) : null,
  };
}

/** 封包的時長（秒）；容器沒有記錄時為 0。 */
function packetDuration(packet: Packet): number {
  const duration = (packet.duration ?? 0) + (packet.durationhi ?? 0) * 2 ** 32;
  const num = packet.time_base_num ?? 0;
  const den = packet.time_base_den ?? 0;
  return duration > 0 && num > 0 && den > 0 ? (duration * num) / den : 0;
}

/**
 * codecpar 的 coded side data 中的 display matrix（9 個 int32）；沒有時為 null。FFmpeg 7 起 demuxer（例如 mov 的
 * `tkhd`）把它放在這裡。
 */
async function displayMatrix(libav: LibAV, codecpar: number): Promise<Int32Array | null> {
  const count = await libav.AVCodecParameters_nb_coded_side_data(codecpar);
  const list = await libav.AVCodecParameters_coded_side_data(codecpar);
  for (let i = 0; i < count; i++) {
    if ((await libav.AVPacketSideData_type(list, i)) !== AV_PKT_DATA_DISPLAYMATRIX) continue;
    if ((await libav.AVPacketSideData_size(list, i)) < 36) continue;
    return libav.copyout_s32(await libav.AVPacketSideData_data(list, i), 9);
  }
  return null;
}

/** `AVStream` 中各欄位以 int32 計的位置（wasm32）：index、codecpar、disposition 與 sample_aspect_ratio。 */
const STREAM_INDEX_WORD = 1;
const STREAM_CODECPAR_WORD = 3;
const STREAM_DISPOSITION_WORD = 14;
const STREAM_SAR_WORD = 16;

/**
 * 容器記錄的 sample aspect ratio（`AVStream.sample_aspect_ratio`，MP4 的 `pasp`、Matroska 的 DisplayWidth／Height）。
 * libav.js 沒有這個欄位的 accessor，所以直接讀 `AVStream` 的記憶體：同一個 wasm Release 的 struct 排列是固定的，
 * 先以有 accessor 的欄位（index、codecpar、disposition）核對位置，不符時（排列改變）當成未知（null）。
 */
async function streamSampleAspectRatio(
  libav: LibAV,
  s: libavjs.Stream,
): Promise<[number, number] | null> {
  const words = await libav.copyout_s32(s.ptr, STREAM_SAR_WORD + 2);
  const matches =
    words[STREAM_INDEX_WORD] === s.index &&
    words[STREAM_CODECPAR_WORD] === s.codecpar &&
    words[STREAM_DISPOSITION_WORD] === (await libav.AVStream_disposition(s.ptr));
  const num = words[STREAM_SAR_WORD] ?? 0;
  const den = words[STREAM_SAR_WORD + 1] ?? 0;
  return matches && num > 0 && den > 0 ? [num, den] : null;
}

/** libav.js 以 lo／hi 兩個 32-bit 數字表示 int64；`AV_NOPTS_VALUE` 為 null。 */
function int64(libav: LibAV, lo: number, hi: number): number | null {
  const value = libav.i64tof64(lo, hi);
  return value === libav.AV_NOPTS_VALUE ? null : value;
}
