// media Worker 的訊息處理：init、load（開檔與 probe）、addaudio／removeaudio（外掛音軌）、start、seek 與 select（音訊供料、
// 影片解碼與字幕 cue）、port（改接重建後的 worklet）、rate（變速）、frameclosed（影片 frame 的 backpressure）、videosuspend
//（背景時暫停影片解碼）與 stats。每個來源（主來源、每條外掛音軌）各一個 libav instance，各自 demux，讀取互不阻塞。
// 主執行緒每次 load 都 terminate 舊的 Worker（ADR-0002），但 Worker 也處理同一個 Worker 內的 load 取代：
// 前一個 load 的讀取被中止、instance 被丟棄。

import type {
  MainToWorkerMessage,
  ProbedAudioTrack,
  ProbedTrack,
  RetryPolicy,
  WorkerAddAudioMessage,
  WorkerBufferMessage,
  WorkerLimits,
  WorkerLoadMessage,
  WorkerPortMessage,
  WorkerStats,
  WorkerToMainMessage,
  WorkerToWorkletMessage,
  WorkerTrackSelection,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { BufferPool, Demand, type AudioPipeline } from './audio-pipeline.js';
import { BufferTracker } from './buffer-tracker.js';
import { initialByteRate } from './byte-rate.js';
import { withDemux, type Demuxer, type HoldableLane } from './demuxer.js';
import { AudioDecoderError, crashReason, toWireError, WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { LibavMedia, type Instantiate, type LibavAssets } from './libav.js';
import { createWorkerLogger, silentLogger, type Logger } from './log.js';
import { NORMAL_QUEUE_BYTES, NORMAL_QUEUE_SECONDS } from './packet-queue.js';
import { hasPlayableTrack, toProbedMedia, videoConfig, withPlatformSupport } from './probe.js';
import { RangeCache } from './range-cache.js';
import { openSource, sleep, type ByteSource } from './source.js';
import { cueReader, type SubtitlePacket } from './subtitles.js';
import type { VideoConfig } from './video-codec.js';
import {
  FrameCredit,
  VideoDecoding,
  type VideoChunk,
  type VideoDecoderInit,
  type VideoDecoderLike,
} from './video-pipeline.js';
import { createWebVideoDecoder, isVideoConfigSupported } from './webcodecs.js';

/**
 * 背景中估計播放位置時，從已經送給 worklet 的音訊往前扣的秒數：送出的 PCM 還要經過 worklet 的 ring buffer（桌面最多
 * 400 ms，2 倍速時是 0.8 媒體秒）才被聽到。估計得太晚只會讓恢復時從下一個 keyframe 開始。
 */
const PLAYED_MARGIN_SECONDS = 2;
/** 主來源只為字幕 demux 時，等播放進度前進的輪詢間隔（ms）。 */
const PACE_INTERVAL_MS = 100;
/**
 * 容器內音軌的 offset 絕對值超過它（秒）而且同時解碼影片時，音軌改在另開的 instance demux（同一個來源，共用 Range
 * 快取）：與影片共用 demuxer 時，封包佇列要多存 |offset| 秒的影片（或音訊）封包，很大時會超過硬上限。不超過時多存的
 * 不到平常的上限，不值得多開一個 instance。
 */
const SEPARATE_OFFSET_SECONDS = NORMAL_QUEUE_SECONDS;

export interface MediaWorkerDeps {
  /** 送給主執行緒；`frame` 的 `VideoFrame` 放在 `transfer`。 */
  postMessage(message: WorkerToMainMessage<WorkerHost>, transfer?: Transferable[]): void;
  /**
   * 開啟來源；預設為 `source.ts` 的實作（http 經過 Worker 的 Range 快取），測試可以換成可控制的來源。
   * 回傳的不是 `CachedSource` 時不預讀。
   */
  openSource?: (
    wire: WorkerLoadMessage<WorkerHost>['source'],
    signal: AbortSignal,
    retry: RetryPolicy,
  ) => Promise<ByteSource>;
  /** 建立 libav instance；預設為 `WebAssembly.instantiate`，測試可以模擬配置失敗。 */
  instantiate?: Instantiate;
  /** 瀏覽器是否支援影片的 config；預設為 `VideoDecoder.isConfigSupported`，測試可以模擬不支援的平台。 */
  isVideoConfigSupported?: (config: VideoConfig) => Promise<boolean>;
  /** 建立 `VideoDecoder`；預設為 WebCodecs，測試可以注入失敗的 decoder。 */
  createVideoDecoder?: (init: VideoDecoderInit<VideoFrame>) => VideoDecoderLike;
}

/** Worker 從 init 得到的環境。 */
interface Environment {
  assets: LibavAssets;
  port: MessagePort;
  sampleRate: number;
  retry: RetryPolicy;
  limits: WorkerLimits;
  /** Worker 內所有 http 來源共用的 Range 快取。 */
  cache: RangeCache;
  /** 目前的播放速度；`rate` 改變它，之後的 start／seek 沿用。 */
  rate: number;
}

/** stats 讀取的 demuxer 狀態。 */
type DemuxerView = Pick<Demuxer<unknown>, 'seconds' | 'bytes'>;

/** 目前輸出的 demuxer 與選用的軌（各來源的 pipeline 建立之後才填上）。 */
interface CurrentOutput {
  demuxers: DemuxerView[];
  audio: { demuxer: DemuxerView; stream: number; pipeline: AudioPipeline<unknown> } | null;
  video: { demuxer: DemuxerView; stream: number } | null;
  setRate: ((rate: number) => void) | null;
}

/** 輸出的音軌：來源（null 是主來源，否則是外掛音軌的 id）、它在來源內的 stream index 與音軌 offset。 */
interface AudioSelection {
  source: string | null;
  stream: number;
  offset: number;
}

/** 選用的各軌：`start`／`select` 決定，之後的 `seek`、`port` 沿用。 */
interface Selection {
  /** null 表示不輸出音訊。 */
  audio: AudioSelection | null;
  /** 選用影片軌的 stream index；null 表示不解碼影片。 */
  video: number | null;
  /** 選用字幕軌的 stream index；null 表示不送 cue。 */
  subtitle: number | null;
}

/** 在主來源以外的 instance demux 的音軌：外掛音軌，或 offset 很大的容器內音軌（`Load.separate`）。 */
interface SeparateAudio {
  holder: SourceInstance;
  media: LibavMedia;
  selection: AudioSelection;
}

/** 一個 epoch 的輸出：`start` 或 `seek`。 */
interface OutputRequest {
  epoch: number;
  time: number;
  /** null 表示不輸出音訊。 */
  audio: AudioSelection | null;
  /** 選用影片軌的 stream index；null 表示不解碼影片。 */
  video: number | null;
  /** 選用字幕軌的 stream index；null 表示不送 cue。 */
  subtitle: number | null;
  /** 先 seek 到 `time`；false 時接著 demuxer 目前的位置（開檔後的開頭）讀。 */
  seek: boolean;
}

/** 一個來源與它的 libav instance（主來源的 `Load` 與外掛音軌的 `External` 共通的部分）。 */
interface SourceInstance {
  controller: AbortController;
  /** 開檔完成後才有。 */
  media: LibavMedia | null;
  /** 開好的來源；http 時經過 Range 快取（`CachedSource`）。 */
  source: ByteSource | null;
  /** probe 之後才有。 */
  tracker: BufferTracker | null;
  /** 開檔、probe 中。輸出等它完成。 */
  opening: Promise<void>;
  /** 已建立（或正在建立）libav instance，計入 `libavInstances`。 */
  hasInstance: boolean;
  disposed: boolean;
}

/** 一條外掛音軌：它的來源與 instance。被選用時才 demux（才讀取、預讀）。 */
interface External extends SourceInstance {
  id: string;
  /** 選用的音軌（probe 之後才有）。 */
  track: ProbedAudioTrack | null;
}

/** 一次 load：一個來源與它的 libav instance。 */
interface Load {
  epoch: number;
  /** 開檔的來源；另開 instance（`separate`）時再開一次。 */
  wire: WorkerLoadMessage<WorkerHost>['source'];
  controller: AbortController;
  /** 開檔完成後才有。 */
  media: LibavMedia | null;
  /** 開好的來源；http 時經過 Range 快取（`CachedSource`）。 */
  source: ByteSource | null;
  /** probe 之後才有。 */
  tracker: BufferTracker | null;
  /** probe 到的軌道；probe 之後才有。 */
  tracks: readonly ProbedTrack[];
  /** 媒體的長度（秒，probe 之後才有；未知時為 NaN）：音訊的空缺只補到它（`AudioPipelineOptions.duration`）。 */
  duration: number;
  /** 開檔、probe 中。start 等它完成。 */
  opening: Promise<void>;
  /** 已建立（或正在建立）libav instance，計入 `libavInstances`。 */
  hasInstance: boolean;
  /** 選用影片軌的解碼；第一次輸出影片時建立，換影片軌、不再輸出影片或 load 結束時 close。 */
  video: VideoDecoding<VideoChunk | null, VideoFrame> | null;
  /** `video` 解碼的 stream index。 */
  videoStream: number | null;
  /** 換影片軌之前各條軌解出的 frame 數合計（`stats.video.decoded` 在 load 內累計）。 */
  decodedBefore: number;
  /**
   * 為 offset 很大的容器內音軌另開的 instance（見 `SEPARATE_OFFSET_SECONDS`）；需要時才開，不再需要（offset 變小、
   * 換音軌、不再解碼影片）時丟掉。
   */
  separate: SourceInstance | null;
  disposed: boolean;
}

export class MediaWorker {
  readonly #deps: MediaWorkerDeps;
  readonly #demand = new Demand();
  readonly #pool = new BufferPool();
  #env: Environment | null = null;
  #load: Load | null = null;
  /** 目前輸出中的音訊；start 取代前一個。 */
  #output: AbortController | null = null;
  /** 前一個 start 的供料，結束（含被中止）時 resolve；同一個 demuxer 上的下一個 start 等它停下。 */
  #outputDone: Promise<void> = Promise.resolve();
  /** 目前輸出的 demuxer（主來源與外掛音軌各一個）與選用的軌，供 stats 的封包佇列與 `rate`。 */
  #current: CurrentOutput | null = null;
  /** `start` 選用的各軌；之後的 `seek` 沿用。`start` 之前為 undefined。 */
  #tracks: Selection | undefined = undefined;
  /** 外掛音軌（id → instance），屬於這個 Worker 的媒體。 */
  readonly #externals = new Map<string, External>();
  /**
   * 目前輸出的各來源最後回報的資料備妥進度（還沒回報時為 null）；全部都回報了這個 epoch 才合併成一個 `buffer` 送出。
   */
  #buffers = new Map<BufferTracker, WorkerBufferMessage | null>();
  /** 主執行緒最後轉送的播放位置（`position`）；只對同一個 epoch 的輸出有效。 */
  #position: { epoch: number; time: number } | null = null;
  /** 背景中暫停影片解碼（`videosuspend`）；沿用到之後的 load。 */
  #videoSuspended = false;
  /** 還沒 close 的 `VideoFrame`（Worker 內暫留的加上送到主執行緒的），所有 load 共用。 */
  readonly #frames = new FrameCredit();
  #libavInstances = 0;
  /** init 之前什麼都不送。 */
  #log: Logger = silentLogger;

  constructor(deps: MediaWorkerDeps) {
    this.#deps = deps;
  }

  handle(message: MainToWorkerMessage<WorkerHost>): void {
    switch (message.type) {
      case 'init':
        this.#log = createWorkerLogger(message.logLevel, (m) => {
          this.#deps.postMessage(m);
        });
        this.#log.log('debug', 'worker', 'init', {
          sampleRate: message.sampleRate,
          limits: { ...message.limits },
          retry: { ...message.retry },
        });
        this.#env = {
          assets: {
            module: message.module,
            glueUrl: message.glueUrl,
            instantiate: this.#deps.instantiate,
          },
          port: message.workletPort,
          sampleRate: message.sampleRate,
          retry: message.retry,
          limits: message.limits,
          cache: new RangeCache(message.limits.cacheBytes),
          rate: message.rate,
        };
        this.#listen(message.workletPort);
        break;
      case 'port':
        this.#replacePort(message);
        break;
      case 'load':
        this.#startLoad(message);
        break;
      case 'addaudio':
        this.#addAudio(message);
        break;
      case 'removeaudio': {
        const external = this.#externals.get(message.id);
        if (external) this.#disposeExternal(external);
        // 主執行緒先換掉選用中的音軌才移除；仍被選用時之後的輸出不再有音訊。
        if (this.#tracks?.audio?.source === message.id) {
          this.#tracks = { ...this.#tracks, audio: null };
        }
        break;
      }
      case 'start': {
        this.#tracks = selectionOf(message);
        const { epoch, time } = message;
        // 開檔後 demuxer 在開頭；從其他位置開始要先 seek。
        this.#startOutput({ epoch, time, ...this.#tracks, seek: time > 0 });
        break;
      }
      case 'seek':
        if (this.#tracks === undefined) break;
        this.#startOutput({ ...message, ...this.#tracks, seek: true });
        break;
      case 'select': {
        if (this.#tracks === undefined) break;
        this.#tracks = selectionOf(message);
        const { epoch, time } = message;
        this.#startOutput({ epoch, time, ...this.#tracks, seek: true });
        break;
      }
      case 'rate':
        this.#log.log('debug', 'audio', '改變播放速度', { rate: message.rate });
        if (this.#env) this.#env.rate = message.rate;
        this.#current?.setRate?.(message.rate);
        break;
      case 'frameclosed':
        this.#frames.release(message.count);
        break;
      case 'videosuspend':
        this.#suspendVideo(message.suspended, message.time);
        break;
      case 'position':
        this.#position = { epoch: message.epoch, time: message.time };
        break;
      case 'stats':
        this.#deps.postMessage({ type: 'stats', id: message.id, stats: this.#stats() });
        break;
    }
  }

  #listen(port: MessagePort): void {
    port.onmessage = ({ data }: MessageEvent<WorkletToWorkerMessage>) => {
      if (port === this.#env?.port) this.#onWorkletMessage(data);
    };
  }

  /** 改接重建後的 worklet，從 `time` 以新的 epoch 重新供料。 */
  #replacePort(message: WorkerPortMessage<WorkerHost>): void {
    const env = this.#env;
    if (!env) {
      message.port.close();
      return;
    }
    this.#log.log('info', 'audio', '改接重建的 AudioWorklet，重新供料', {
      epoch: message.epoch,
      time: message.time,
    });
    env.port.onmessage = null;
    env.port.close();
    env.port = message.port;
    this.#listen(message.port);
    // 舊的 worklet 的要求已經沒有意義；新的 worklet 會以新的 epoch 要資料。重新供料走 seek 的流程。
    if (this.#tracks !== undefined) {
      this.#startOutput({
        epoch: message.epoch,
        time: message.time,
        ...this.#tracks,
        seek: true,
      });
    }
  }

  /** 背景時關閉 decoder、暫停影片解碼；回到前景時從 `time` 之前的 keyframe 重新解碼。 */
  #suspendVideo(suspended: boolean, time: number): void {
    if (suspended === this.#videoSuspended) return;
    this.#videoSuspended = suspended;
    const video = this.#load?.video;
    this.#log.log(
      'info',
      'video',
      suspended ? '背景：關閉 VideoDecoder，只播聲音' : '回到前景：從 keyframe 重建 VideoDecoder',
      { ...(!suspended && { time }), decoding: video != null },
    );
    if (suspended) video?.suspend();
    else video?.resume(time);
  }

  #onWorkletMessage(message: WorkletToWorkerMessage): void {
    switch (message.type) {
      case 'need':
        this.#demand.need(message.epoch, message.frames);
        break;
      case 'release':
        this.#pool.release(message.buffers);
        break;
    }
  }

  #startLoad(message: WorkerLoadMessage<WorkerHost>): void {
    this.#stopOutput();
    this.#tracks = undefined;
    this.#current = null;
    this.#log.log('debug', 'worker', 'load', { epoch: message.epoch, source: message.source.kind });
    if (this.#load) {
      this.#log.log('debug', 'worker', '前一個 load 被取代', { epoch: this.#load.epoch });
      this.#dispose(this.#load);
    }
    // 外掛音軌屬於上一份媒體。
    for (const external of this.#externals.values()) this.#disposeExternal(external);
    const load: Load = {
      epoch: message.epoch,
      wire: message.source,
      controller: new AbortController(),
      media: null,
      source: null,
      tracker: null,
      tracks: [],
      duration: NaN,
      opening: Promise.resolve(),
      hasInstance: false,
      video: null,
      videoStream: null,
      decodedBefore: 0,
      separate: null,
      disposed: false,
    };
    this.#load = load;
    load.opening = this.#open(load, message.source);
  }

  /**
   * 開啟來源（http 經過共用的 Range 快取）並建立 libav instance、開檔 probe。`holder.source` 與 `hasInstance` 在途中就記下，
   * 失敗或被中止時由呼叫端 dispose。
   */
  async #openInstance(
    holder: SourceInstance,
    wire: WorkerLoadMessage<WorkerHost>['source'],
  ): Promise<{ opened: ByteSource; media: LibavMedia }> {
    const { signal } = holder.controller;
    const env = this.#requireEnv();
    const open =
      this.#deps.openSource ??
      ((wire, signal, retry) =>
        openSource(wire, signal, {
          retry,
          cache: env.cache,
          log: this.#log,
          onRequestError: (error) => {
            if (!holder.disposed) {
              this.#deps.postMessage({ type: 'readerror', error: toWireError(error) });
            }
          },
        }));
    const opened = await open(wire, signal, env.retry);
    if (signal.aborted) {
      opened.close?.();
      signal.throwIfAborted();
    }
    holder.source = opened;
    // demux 讀取的位置與當時的 demux 進度用來修正位元組率。
    const source: ByteSource = {
      size: opened.size,
      read: (offset, length, readSignal) => {
        holder.tracker?.onRead(offset);
        return opened.read(offset, length, readSignal);
      },
    };
    holder.hasInstance = true;
    this.#libavInstances++;
    const media = await LibavMedia.open(env.assets, source, signal);
    signal.throwIfAborted();
    return { opened, media };
  }

  async #open(load: Load, wire: WorkerLoadMessage<WorkerHost>['source']): Promise<void> {
    const { signal } = load.controller;
    try {
      const env = this.#requireEnv();
      const { opened, media } = await this.#openInstance(load, wire);
      const isSupported = this.#deps.isVideoConfigSupported ?? isVideoConfigSupported;
      const probed = await withPlatformSupport(toProbedMedia(media.raw), media.raw, isSupported);
      signal.throwIfAborted();
      if (!hasPlayableTrack(probed)) {
        throw new WorkerError('CODEC_UNSUPPORTED', '沒有可以播放的音軌或影片軌');
      }
      load.media = media;
      load.tracks = probed.tracks;
      load.duration = probed.duration;
      load.tracker = this.#bufferTracker(load, opened, {
        size: probed.size,
        duration: probed.duration,
        bitRates: media.raw.streams
          .filter((s) => s.type === 'audio' || s.type === 'video')
          .map((s) => s.bitRate),
        readaheadSeconds: env.limits.readaheadSeconds,
      });
      this.#log.log('info', 'demux', `開檔完成：${probed.format}`, {
        epoch: load.epoch,
        duration: probed.duration,
        size: probed.size,
        tracks: probed.tracks.map((t) => `${t.kind}:${t.codec}${t.supported ? '' : '（不支援）'}`),
      });
      this.#deps.postMessage({ type: 'probe', epoch: load.epoch, media: probed });
    } catch (error) {
      // open／probe 被中止或失敗：丟掉這個 instance。被取代的 load 不回報。
      const superseded = signal.aborted;
      this.#dispose(load);
      if (!superseded) this.#reportError(load.epoch, error);
    }
  }

  /** 外掛音軌：開第二個（第三個…）instance 並 probe，回覆 `audioprobe` 或 `audioerror`。同一個 id 已經存在時取代它。 */
  #addAudio(message: WorkerAddAudioMessage<WorkerHost>): void {
    const previous = this.#externals.get(message.id);
    if (previous) this.#disposeExternal(previous);
    this.#log.log('debug', 'worker', '加入外掛音軌', {
      id: message.id,
      source: message.source.kind,
    });
    const external: External = {
      id: message.id,
      controller: new AbortController(),
      media: null,
      source: null,
      tracker: null,
      track: null,
      opening: Promise.resolve(),
      hasInstance: false,
      disposed: false,
    };
    this.#externals.set(message.id, external);
    external.opening = this.#openExternal(external, message.source);
  }

  async #openExternal(
    external: External,
    wire: WorkerAddAudioMessage<WorkerHost>['source'],
  ): Promise<void> {
    const { signal } = external.controller;
    try {
      const env = this.#requireEnv();
      const { opened, media } = await this.#openInstance(external, wire);
      const probed = toProbedMedia(media.raw);
      const audio = probed.tracks.filter(
        (t): t is ProbedAudioTrack => t.kind === 'audio' && t.supported,
      );
      const track = audio.find((t) => t.default) ?? audio[0];
      if (!track) throw new WorkerError('CODEC_UNSUPPORTED', '外掛音軌的來源沒有可以播放的音軌');
      // 外掛音軌的 0 點是選用的 stream 的第一個可播放 sample（不是容器的 start_time）。
      await media.alignTo(track.streamIndex, env.sampleRate, signal);
      signal.throwIfAborted();
      external.media = media;
      external.track = track;
      external.tracker = this.#bufferTracker(external, opened, {
        size: probed.size,
        // demux 的進度已換算成媒體時間（加上 offset），不以來源的長度截斷；主執行緒以媒體的 duration 截斷。
        duration: NaN,
        sourceDuration: probed.duration,
        bitRates: [media.raw.streams[track.streamIndex]?.bitRate ?? 0],
        readaheadSeconds: env.limits.readaheadSeconds,
      });
      this.#log.log('info', 'demux', `外掛音軌開檔完成：${probed.format}`, {
        id: external.id,
        duration: probed.duration,
        stream: track.streamIndex,
        codec: track.codec,
      });
      this.#deps.postMessage({ type: 'audioprobe', id: external.id, track });
    } catch (error) {
      const superseded = signal.aborted;
      this.#disposeExternal(external);
      if (superseded) return;
      // 外掛音軌失敗不影響主媒體：instance 已丟掉，以非致命的錯誤回報（wasm 記憶體用完時是 MEMORY_LIMIT）。
      const wire = toWireError(error);
      const code = crashReason(error) === 'out-of-memory' ? 'MEMORY_LIMIT' : wire.code;
      this.#log.log('warn', 'demux', `外掛音軌開檔失敗：${wire.message}`, {
        id: external.id,
        code,
      });
      this.#deps.postMessage({
        type: 'audioerror',
        id: external.id,
        error: { ...wire, code, fatal: false },
      });
    }
  }

  /**
   * 主來源音軌的 decoder 開不起來：停止這次輸出並以非致命的 `audiofailed` 回報。換音軌時由主執行緒換回原本的軌，不是換軌
   * 時由主執行緒把該軌標為不支援、以 `audio: null` 重新 start（只播影片）；Worker 不自行改成只輸出影片。
   */
  #audioDecoderFailed(epoch: number, error: AudioDecoderError): void {
    this.#log.log('warn', 'audio', error.message, { epoch });
    this.#deps.postMessage({
      type: 'audiofailed',
      epoch,
      source: null,
      error: { ...toWireError(error), fatal: false },
    });
  }

  /**
   * 輸出中的外掛音軌失敗：丟掉它（之後選用它時不輸出音訊），送出這個 epoch 的 `eof` 讓 worklet 以靜音推進時鐘，再以
   * `audiofailed` 告訴主執行緒。
   */
  #failExternal(external: External, epoch: number, error: unknown): void {
    const wire = toWireError(error);
    this.#log.log('warn', 'audio', `外掛音軌失敗：${wire.message}`, {
      epoch,
      id: external.id,
      code: wire.code,
    });
    this.#disposeExternal(external);
    if (this.#tracks?.audio?.source === external.id) {
      this.#tracks = { ...this.#tracks, audio: null };
    }
    this.#env?.port.postMessage({ type: 'eof', epoch } satisfies WorkerToWorkletMessage);
    this.#deps.postMessage({
      type: 'audiofailed',
      epoch,
      source: external.id,
      error: { ...wire, fatal: false },
    });
  }

  #disposeExternal(external: External): void {
    if (!this.#releaseInstance(external)) return;
    if (this.#externals.get(external.id) === external) this.#externals.delete(external.id);
  }

  /** 中止來源的讀取、丟掉 instance；已經丟掉時回傳 false。 */
  #releaseInstance(holder: SourceInstance): boolean {
    if (holder.disposed) return false;
    holder.disposed = true;
    holder.controller.abort();
    holder.source?.close?.();
    holder.media = null;
    if (holder.hasInstance) this.#libavInstances--;
    if (holder.tracker) this.#buffers.delete(holder.tracker);
    return true;
  }

  /**
   * offset 很大的容器內音軌用的 instance：第一次需要時以同一個來源開檔，之後沿用。開不起來時為 null（呼叫端改用共用的
   * demuxer）。等開檔時以 `signal` 中止（輸出被取代）。
   */
  async #separateInstance(
    load: Load,
    stream: number,
    signal: AbortSignal,
  ): Promise<LibavMedia | null> {
    let separate = load.separate;
    if (!separate) {
      const holder: SourceInstance = {
        controller: new AbortController(),
        media: null,
        source: null,
        tracker: null,
        opening: Promise.resolve(),
        hasInstance: false,
        disposed: false,
      };
      holder.opening = this.#openSeparate(load, holder, stream);
      load.separate = separate = holder;
    }
    await abortable(separate.opening, signal);
    return separate.media;
  }

  async #openSeparate(load: Load, holder: SourceInstance, stream: number): Promise<void> {
    try {
      const env = this.#requireEnv();
      this.#log.log('info', 'demux', '音軌 offset 很大：另開 instance demux 音軌', {
        epoch: load.epoch,
        stream,
      });
      const { opened, media } = await this.#openInstance(holder, load.wire);
      holder.media = media;
      // demux 的進度已換算成媒體時間（加上 offset），同外掛音軌不以來源的長度截斷。
      holder.tracker = this.#bufferTracker(holder, opened, {
        size: opened.size,
        duration: NaN,
        sourceDuration: media.raw.duration === null ? NaN : media.raw.duration / 1e6,
        bitRates: [media.raw.streams[stream]?.bitRate ?? 0],
        readaheadSeconds: env.limits.readaheadSeconds,
      });
    } catch (error) {
      const superseded = holder.controller.signal.aborted;
      this.#releaseInstance(holder);
      if (load.separate === holder) load.separate = null;
      if (superseded) return;
      // 開不起來（例如 wasm 記憶體不夠）：改回與影片共用 demuxer。
      this.#log.log('warn', 'demux', '另開 instance 失敗，音軌與影片共用 demuxer', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #disposeSeparate(load: Load): void {
    if (!load.separate) return;
    this.#releaseInstance(load.separate);
    load.separate = null;
  }

  /**
   * 一個來源的資料備妥進度。`duration` 是截斷進度的長度（NaN 時不截斷）；`sourceDuration` 是估計位元組率用的來源長度，
   * 省略時同 `duration`。
   */
  #bufferTracker(
    holder: { disposed: boolean },
    opened: ByteSource,
    options: {
      size: number;
      duration: number;
      sourceDuration?: number;
      bitRates: number[];
      readaheadSeconds: number;
    },
  ): BufferTracker {
    const tracker: BufferTracker = new BufferTracker({
      source: opened,
      size: opened.size,
      duration: options.duration,
      byteRate: initialByteRate({
        size: options.size,
        duration: options.sourceDuration ?? options.duration,
        bitRates: options.bitRates,
      }),
      readaheadSeconds: options.readaheadSeconds,
      post: (message) => {
        if (!holder.disposed) this.#onBuffer(tracker, message);
      },
    });
    return tracker;
  }

  /**
   * 一個來源的資料備妥進度：目前輸出的各來源都回報了同一個 epoch 才合併送出。還沒讀到結尾的來源取最早的終點（都到了
   * 結尾時取最晚的），`fetching` 只要有一個在抓取就是 true。
   */
  #onBuffer(tracker: BufferTracker, message: WorkerBufferMessage): void {
    if (!this.#buffers.has(tracker)) return;
    this.#buffers.set(tracker, message);
    const reported: WorkerBufferMessage[] = [];
    for (const m of this.#buffers.values()) {
      if (m?.epoch !== message.epoch) return;
      reported.push(m);
    }
    if (reported.length === 1) {
      this.#deps.postMessage(message);
      return;
    }
    const open = reported.filter((m) => !m.eof);
    const ends = (open.length > 0 ? open : reported).map((m) => m.end);
    this.#deps.postMessage({
      type: 'buffer',
      epoch: message.epoch,
      end: open.length > 0 ? Math.min(...ends) : Math.max(...ends),
      eof: open.length === 0,
      fetching: reported.some((m) => m.fetching),
    });
  }

  /**
   * 開始一個 epoch 的輸出，取代前一個：中止前一個的讀取，等它的 libav 呼叫結束，再 seek 並供料。
   * 被取代的輸出不論 libav 回傳什麼都不回報，判斷只看這個輸出是否還是目前的（epoch）。
   */
  #startOutput(message: OutputRequest): void {
    const load = this.#load;
    if (!load) return;
    this.#log.log('debug', 'demux', message.seek ? 'seek' : '開始輸出', {
      epoch: message.epoch,
      time: message.time,
      superseding: this.#output !== null,
    });
    this.#stopOutput();
    load.media?.abortReads();
    // seek 時進行中的網路請求（含預讀）一起中止：卡住的請求要換新的才能恢復。開檔後的第一次輸出不 seek，
    // demuxer 接著讀，不必中止。
    if (message.seek) load.source?.abort?.();
    // 外掛音軌（與另開的 instance）的輸出一律先 seek，所以每次都中止；沒選用的也因此不再預讀。開檔中的不動（讀取
    // 屬於 probe）。
    for (const holder of [...this.#externals.values(), load.separate]) {
      if (!holder?.media) continue;
      holder.media.abortReads();
      holder.source?.abort?.();
    }
    // 開檔中的 instance 屬於舊輸出。即使新輸出也需要另開 instance，也不能等舊的讀取。
    if (load.separate && !load.separate.media) this.#disposeSeparate(load);
    const output = new AbortController();
    this.#output = output;
    this.#demand.setEpoch(message.epoch);
    // 同一個 demuxer 同時只有一個供料：等前一個被中止的供料停下（它可能還在等 libav 的呼叫）。
    const previous = this.#outputDone;
    this.#outputDone = (async () => {
      await previous;
      await load.opening;
      await this.#runOutput(load, message, output);
    })();
  }

  async #runOutput(load: Load, message: OutputRequest, output: AbortController): Promise<void> {
    const { signal } = output;
    const media = load.media;
    if (signal.aborted || !media) return;
    this.#current = null;
    try {
      const env = this.#requireEnv();
      const post = (m: WorkerToWorkletMessage, transfer: Transferable[]) => {
        env.port.postMessage(m, transfer);
      };
      const { epoch } = message;
      const startTime = Math.max(0, message.time);
      const selected = message.audio;
      // 外掛音軌：等它開檔完成（主執行緒在 probe 之後才選用它）；被移除或失敗時不輸出音訊。
      const external =
        selected?.source == null ? null : (this.#externals.get(selected.source) ?? null);
      if (external) await abortable(external.opening, signal);
      signal.throwIfAborted();
      const externalMedia = external?.media ?? null;
      const mainAudio = selected?.source === null ? selected : null;
      const externalAudio = externalMedia ? selected : null;
      const subtitle = this.#subtitleOutput(load, message, output);
      // 主來源在輸出它的音軌、影片軌或字幕軌時 demux（音軌是外掛的、不選影片時只為字幕 demux）。
      const demuxMain = mainAudio !== null || message.video !== null || subtitle !== null;
      this.#buffers = new Map();
      if (demuxMain && load.tracker) {
        load.tracker.start(epoch, startTime);
        this.#buffers.set(load.tracker, null);
      }
      /** 這個 epoch 的音訊送完了（`eof` 已送出）：告訴主執行緒，之後的影片不再受音訊的進度約束。 */
      const audioEnd = () => {
        if (!signal.aborted) this.#deps.postMessage({ type: 'audioend', epoch });
      };
      // 前一個輸出已經停下：換了影片軌（或不再輸出影片）才能關掉舊軌的 decoder。
      if (message.video === null) this.#closeVideo(load);
      if (!demuxMain && !externalAudio) {
        // 不輸出任何軌：另開的 instance 也不再需要。worklet 以靜音推進時鐘。
        this.#disposeSeparate(load);
        post({ type: 'eof', epoch }, []);
        audioEnd();
        return;
      }
      const video = message.video === null ? null : this.#videoDecoding(load, message.video);
      // offset 很大的容器內音軌與影片同時輸出：音軌在另開的 instance demux。不再需要時丟掉（前一個輸出已經停下）。
      const separateMedia =
        mainAudio && video && needsSeparate(message)
          ? await this.#separateInstance(load, mainAudio.stream, signal)
          : (this.#disposeSeparate(load), null);
      signal.throwIfAborted();
      const separate: SeparateAudio | null =
        external && externalMedia && externalAudio
          ? { holder: external, media: externalMedia, selection: externalAudio }
          : load.separate && separateMedia && mainAudio
            ? { holder: load.separate, media: separateMedia, selection: mainAudio }
            : null;
      if (separate?.holder.tracker) {
        separate.holder.tracker.start(epoch, startTime);
        this.#buffers.set(separate.holder.tracker, null);
      }
      // 主來源 demux 的音軌（另開 instance 時不 demux 音軌）。
      const mainDemuxAudio = separate ? null : mainAudio;
      const { limits } = env;
      const demux = (
        tracker: BufferTracker | null,
        pace?: (end: number, stop: AbortSignal) => Promise<void>,
      ) => ({
        epoch,
        queueLimits: {
          seconds: NORMAL_QUEUE_SECONDS,
          bytes: NORMAL_QUEUE_BYTES,
          hardBytes: limits.packetQueueBytes,
        },
        onDemux: (end: number, eof: boolean) => {
          tracker?.onDemux(epoch, end, eof);
        },
        log: this.#log,
        ...(pace && { pace }),
      });
      const audioOptions = {
        sampleRate: env.sampleRate,
        duration: load.duration,
        rate: env.rate,
        epoch,
        demand: this.#demand,
        pool: this.#pool,
        post,
        log: this.#log,
      };
      const audioSelection = externalAudio ?? mainAudio;
      const audioOffset = audioSelection?.offset ?? 0;
      this.#log.log('debug', 'audio', '開始供料', {
        epoch,
        audio: audioSelection?.stream ?? null,
        ...(externalAudio && { audioSource: external?.id }),
        ...(audioOffset !== 0 && { audioOffset }),
        video: message.video,
        codec:
          audioSelection === null
            ? null
            : (externalAudio ? externalMedia : media)?.raw.streams[audioSelection.stream]?.codec,
      });
      if (!audioSelection) {
        post({ type: 'eof', epoch }, []);
        audioEnd();
      }
      const current: CurrentOutput = {
        demuxers: [],
        audio: null,
        video: null,
        setRate: null,
      };
      this.#current = current;
      /** 音訊的 pipeline 建立之後：記下它與它的 demuxer（stats、背景的播放位置）並套用建立期間收到的 rate。 */
      const onAudio = (
        audio: AudioPipeline<unknown> | null,
        demuxer: DemuxerView,
        selection: AudioSelection,
      ) => {
        if (!audio) return;
        current.audio = { demuxer, stream: selection.stream, pipeline: audio };
        current.setRate = (rate) => {
          audio.setRate(rate);
        };
        audio.setRate(env.rate);
      };
      // 背景中以已經送給 worklet 的音訊估計播放位置：實際的播放位置不會超過它。不用音訊 lane 的 demux 進度：offset 為正
      // 時起點前的靜音一開始就讓 PcmQueue 滿了，lane 停在來源的開頭，換算成媒體時間會遠超過播放位置。音訊的 pipeline
      // 還沒建立時以起點估計。
      const played = audioSelection
        ? () => (current.audio?.pipeline.sent ?? startTime) - PLAYED_MARGIN_SECONDS
        : null;
      // 主來源只為字幕 demux（音軌是外掛的，或沒有音訊）：字幕不進封包佇列，demux 沒有東西讓它停下，改以播放進度控制，
      // 不超前 `NORMAL_QUEUE_SECONDS` 以上。播放進度取主執行緒轉送的音訊時鐘（暫停時不前進）與已經送給 worklet 的音訊
      // （外掛音軌）之中較晚的；兩者都沒有時是起點。
      const paceSubtitles =
        mainDemuxAudio === null && !video
          ? async (end: number, stop: AbortSignal) => {
              for (;;) {
                const position = this.#position?.epoch === epoch ? this.#position.time : startTime;
                const progress = Math.max(startTime, position, current.audio?.pipeline.sent ?? 0);
                if (end <= progress + NORMAL_QUEUE_SECONDS) return;
                await sleep(PACE_INTERVAL_MS, stop);
              }
            }
          : undefined;
      // 主來源與外掛音軌各自 seek、demux：兩個 instance 的 Asyncify 互不影響，一邊的讀取掛起不擋另一邊。
      const runMain = async () => {
        const main = await media
          .startOutput({
            audio: mainDemuxAudio?.stream ?? null,
            audioOffset: mainDemuxAudio?.offset ?? 0,
            video: video ? message.video : null,
            subtitle,
            seek: message.seek,
            startTime,
            signal,
            demux: demux(load.tracker, paceSubtitles),
            audioOptions,
          })
          .catch((error: unknown) => {
            if (signal.aborted || !(error instanceof AudioDecoderError)) throw error;
            this.#audioDecoderFailed(epoch, error);
            return null;
          });
        if (!main) return;
        signal.throwIfAborted();
        current.demuxers.push(main.demuxer);
        if (mainDemuxAudio) onAudio(main.audio, main.demuxer, mainDemuxAudio);
        if (main.video && message.video !== null) {
          current.video = { demuxer: main.demuxer, stream: message.video };
        }
        await withDemux(main.demuxer, signal, async () => {
          // 只為字幕 demux：沒有供料，demux（依播放進度節流）到結尾（或失敗）才停。
          if (!main.audio && !main.video) return main.demuxer.settled(signal);
          await Promise.all([
            main.audio?.run().then(audioEnd),
            video && main.video
              ? this.#runVideo(
                  video,
                  main.video,
                  message,
                  // 背景中影片不取封包，硬上限仍須立即中止等候並回報。
                  AbortSignal.any([signal, main.demuxer.fatal]),
                  played,
                  !main.audio,
                )
              : undefined,
          ]);
        });
      };
      // 另一個 instance 的音軌（外掛音軌，或 offset 很大的容器內音軌）一律 seek 到 time − offset（不依賴 demuxer 目前的
      // 位置）。外掛音軌失敗（崩潰以外）不影響主來源：丟掉它，這個 epoch 的音訊以靜音結束，由主執行緒移除它。
      const runSeparate = async ({ holder, media: fromMedia, selection }: SeparateAudio) => {
        try {
          const ext = await fromMedia.startOutput({
            audio: selection.stream,
            audioOffset: selection.offset,
            video: null,
            subtitle: null,
            seek: true,
            startTime,
            signal,
            demux: demux(holder.tracker),
            audioOptions,
          });
          signal.throwIfAborted();
          current.demuxers.push(ext.demuxer);
          onAudio(ext.audio, ext.demuxer, selection);
          await withDemux(ext.demuxer, signal, async () => {
            if (!ext.audio) return;
            await ext.audio.run();
            audioEnd();
          });
        } catch (error) {
          if (signal.aborted || crashReason(error) !== null) throw error;
          if (holder === external) this.#failExternal(external, epoch, error);
          else if (error instanceof AudioDecoderError) this.#audioDecoderFailed(epoch, error);
          else throw error;
        }
      };
      await Promise.all([demuxMain ? runMain() : undefined, separate && runSeparate(separate)]);
    } catch (error) {
      // 被取代：中止的讀取或 libav 回傳的任何錯誤都不回報。
      if (this.#output !== output) return;
      this.#reportError(message.epoch, error);
    }
  }

  /**
   * 選用字幕軌的 cue：每批 demux 讀到的字幕封包轉成 cue，以 `cues` 送出。不支援的軌（圖形字幕）不會被選用，選了也
   * 不 demux。被取代的輸出不再送。
   */
  #subtitleOutput(
    load: Load,
    message: OutputRequest,
    output: AbortController,
  ): { stream: number; onPackets: (packets: SubtitlePacket[]) => void } | null {
    const stream = message.subtitle;
    const track = load.tracks.find((t) => t.kind === 'subtitle' && t.streamIndex === stream);
    if (stream === null || track?.kind !== 'subtitle' || !track.supported) return null;
    const read = cueReader(track);
    const { epoch } = message;
    return {
      stream,
      onPackets: (packets) => {
        if (this.#output !== output) return;
        const cues = packets.flatMap((p) => read(p) ?? []);
        if (cues.length === 0) return;
        this.#log.log('debug', 'subtitle', `送出 ${String(cues.length)} 個 cue`, {
          epoch,
          start: cues[0]?.start,
        });
        this.#deps.postMessage({ type: 'cues', epoch, cues });
      },
    };
  }

  /** 這次 load 的影片解碼；第一次輸出影片時建立。Engine 對應不到 WebCodecs 的軌（不會被選用）為 null。 */
  #videoDecoding(load: Load, stream: number): VideoDecoding<VideoChunk | null, VideoFrame> | null {
    if (load.video && load.videoStream === stream) return load.video;
    this.#closeVideo(load);
    const raw = load.media?.raw.streams[stream];
    const config = raw ? videoConfig(raw) : null;
    if (!config) return null;
    load.video = new VideoDecoding<VideoChunk | null, VideoFrame>({
      config,
      toChunk: (chunk) => chunk,
      credit: this.#frames,
      createDecoder: this.#deps.createVideoDecoder ?? createWebVideoDecoder,
    });
    load.videoStream = stream;
    if (this.#videoSuspended) load.video.suspend();
    return load.video;
  }

  /**
   * 解碼一個 epoch 的影片，frame 以 transfer 送給主執行緒。decoder 失敗而放棄時以 `videoerror` 回報（非致命），之後不再
   * 選用這條影片軌。demux 失敗（含超過封包佇列的硬上限）時影片停止（`videoend`）；同一個 demuxer 有音訊的供料時由它在
   * 播完佇列中的封包後回報，否則（`reportDemuxErrors`：沒有音訊，或音訊來自另一個 instance）由這裡回報。
   * `played`：背景中估計的播放位置（有音訊時）。
   */
  async #runVideo(
    video: VideoDecoding<VideoChunk | null, VideoFrame>,
    packets: HoldableLane<VideoChunk | null>,
    message: OutputRequest,
    signal: AbortSignal,
    played: (() => number) | null,
    reportDemuxErrors: boolean,
  ): Promise<void> {
    const { epoch } = message;
    let result: 'end' | 'failed' | null = null;
    try {
      result = await video.run({
        packets,
        startTime: Math.max(0, message.time),
        epoch,
        signal,
        post: (frame) => {
          this.#deps.postMessage({ type: 'frame', epoch, frame }, [frame]);
        },
        end: () => {
          this.#deps.postMessage({ type: 'videoend', epoch });
        },
        retry: (error) => {
          this.#log.log('warn', 'video', `影片解碼失敗，重新設定 decoder：${error.message}`, {
            epoch,
            stream: message.video,
          });
        },
        ...(played && { played }),
        fail: (error, beforeFirstFrame) => {
          // 被取代的輸出（例如已經換了軌）不回報。
          if (signal.aborted) return;
          // 主執行緒不再選用這條影片軌（只播音訊），之後的 seek 也不 demux 它。
          if (this.#tracks) this.#tracks = { ...this.#tracks, video: null };
          this.#log.log(
            'warn',
            'video',
            `影片解碼失敗${beforeFirstFrame ? '（configure 或首個 keyframe）' : '（重新設定之後）'}，只播音訊：${error.message}`,
            { epoch, stream: message.video },
          );
          this.#deps.postMessage({
            type: 'videoerror',
            epoch,
            beforeFirstFrame,
            error: {
              code: beforeFirstFrame ? 'CODEC_UNSUPPORTED' : 'DECODE_FAILED',
              fatal: false,
              message: error.message,
            },
          });
        },
      });
      // 失敗之後這個 epoch 的影片封包照樣取出丟掉，封包佇列才不會因為這條 lane 而增長。
      if (result === 'failed') {
        while ((await packets.next(signal)) !== undefined) {
          // 丟掉。
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (result !== 'failed') this.#deps.postMessage({ type: 'videoend', epoch });
      if (reportDemuxErrors) throw error;
    }
  }

  /** 關閉目前影片軌的 decoder（換影片軌、不再輸出影片）。 */
  #closeVideo(load: Load): void {
    if (!load.video) return;
    load.decodedBefore += load.video.stats.decoded;
    load.video.close();
    load.video = null;
    load.videoStream = null;
  }

  #stopOutput(): void {
    this.#output?.abort();
    this.#output = null;
  }

  #dispose(load: Load): void {
    if (load.disposed) return;
    load.disposed = true;
    load.controller.abort();
    load.source?.close?.();
    load.video?.close();
    load.video = null;
    load.media = null;
    if (load.hasInstance) this.#libavInstances--;
    this.#disposeSeparate(load);
    if (this.#load === load) this.#load = null;
  }

  #stats(): WorkerStats {
    const env = this.#env;
    const externals = [...this.#externals.values()];
    // 主來源與外掛音軌的預讀、網路合計。
    const sources = [
      this.#load?.source,
      this.#load?.separate?.source,
      ...externals.map((e) => e.source),
    ].flatMap((s) => s?.stats?.() ?? []);
    const current = this.#current;
    const video = this.#load?.video ?? null;
    return {
      libavInstances: this.#libavInstances,
      cache: {
        bytes: env?.cache.bytes ?? 0,
        limitBytes: env?.cache.limitBytes ?? 0,
        aheadBytes: sum(sources.map((s) => s.aheadBytes)),
        readaheadTarget: sum(sources.map((s) => s.readaheadTarget)),
        fetching: sources.some((s) => s.fetching),
        hits: env?.cache.hits ?? 0,
        misses: env?.cache.misses ?? 0,
      },
      network: {
        bytesLoaded: sum(sources.map((s) => s.bytesLoaded)),
        inflight: sources.flatMap((s) => s.inflight),
      },
      packetQueue: {
        audioSeconds: current?.audio ? current.audio.demuxer.seconds(current.audio.stream) : 0,
        videoSeconds: current?.video ? current.video.demuxer.seconds(current.video.stream) : 0,
        bytes: sum(current?.demuxers.map((d) => d.bytes) ?? []),
      },
      wasmHeapBytes: sum(
        [this.#load?.media, this.#load?.separate?.media, ...externals.map((e) => e.media)].map(
          (m) => m?.heapBytes ?? 0,
        ),
      ),
      video:
        current?.video && video
          ? { ...video.stats, decoded: (this.#load?.decodedBefore ?? 0) + video.stats.decoded }
          : null,
      openVideoFrames: video?.openFrames ?? 0,
    };
  }

  #reportError(epoch: number, error: unknown): void {
    // wasm trap 或記憶體用完：instance 不能再用，主執行緒回報 INTERNAL 並 terminate 這個 Worker。
    const reason = crashReason(error);
    if (reason !== null) {
      this.#log.log('error', 'worker', `instance 無法繼續運作（${reason}）`, {
        message: error instanceof Error ? error.message : String(error),
      });
      this.#deps.postMessage({
        type: 'crash',
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#deps.postMessage({ type: 'error', epoch, error: toWireError(error) });
  }

  #requireEnv(): Environment {
    if (!this.#env) throw new WorkerError('INTERNAL', 'media Worker 還沒有收到 init');
    return this.#env;
  }
}

/** 容器內音軌的 offset 很大而且同時解碼影片：音軌在另開的 instance demux（見 `SEPARATE_OFFSET_SECONDS`）。 */
function needsSeparate(request: OutputRequest): boolean {
  const { audio } = request;
  return (
    audio !== null &&
    audio.source === null &&
    request.video !== null &&
    Math.abs(audio.offset) > SEPARATE_OFFSET_SECONDS
  );
}

/** `promise` 的結果；`signal` 先中止時以它的 reason reject（不等 `promise`）。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** `start`／`select` 的選擇。 */
function selectionOf(message: WorkerTrackSelection): Selection {
  return {
    audio:
      message.audio === null
        ? null
        : {
            source: message.audioSource ?? null,
            stream: message.audio,
            offset: message.audioOffset ?? 0,
          },
    video: message.video,
    subtitle: message.subtitle,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
