// media Worker 的訊息處理：init、load（開檔與 probe）、start 與 seek（音訊供料、影片解碼與字幕 cue）、port（改接重建後的
// worklet）、rate（變速）、frameclosed（影片 frame 的 backpressure）與 stats。
// 主執行緒每次 load 都 terminate 舊的 Worker（ADR-0002），但 Worker 也處理同一個 Worker 內的 load 取代：
// 前一個 load 的讀取被中止、instance 被丟棄。

import type {
  MainToWorkerMessage,
  ProbedTrack,
  RetryPolicy,
  WorkerLimits,
  WorkerLoadMessage,
  WorkerPortMessage,
  WorkerStats,
  WorkerToMainMessage,
  WorkerToWorkletMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { BufferPool, Demand } from './audio-pipeline.js';
import { BufferTracker } from './buffer-tracker.js';
import { initialByteRate } from './byte-rate.js';
import { withDemux, type Demuxer, type PacketLane } from './demuxer.js';
import { crashReason, toWireError, WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { LibavMedia, type Instantiate, type LibavAssets } from './libav.js';
import { createWorkerLogger, silentLogger, type Logger } from './log.js';
import { NORMAL_QUEUE_BYTES, NORMAL_QUEUE_SECONDS } from './packet-queue.js';
import { hasPlayableTrack, toProbedMedia, videoConfig, withPlatformSupport } from './probe.js';
import { RangeCache } from './range-cache.js';
import { openSource, type ByteSource } from './source.js';
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

/** 一個 epoch 的輸出：`start` 或 `seek`。 */
interface OutputRequest {
  epoch: number;
  time: number;
  /** 選用音軌的 stream index；null 表示不輸出音訊。 */
  audio: number | null;
  /** 選用影片軌的 stream index；null 表示不解碼影片。 */
  video: number | null;
  /** 選用字幕軌的 stream index；null 表示不送 cue。 */
  subtitle: number | null;
  /** 先 seek 到 `time`；false 時接著 demuxer 目前的位置（開檔後的開頭）讀。 */
  seek: boolean;
}

/** 一次 load：一個來源與它的 libav instance。 */
interface Load {
  epoch: number;
  controller: AbortController;
  /** 開檔完成後才有。 */
  media: LibavMedia | null;
  /** 開好的來源；http 時經過 Range 快取（`CachedSource`）。 */
  source: ByteSource | null;
  /** probe 之後才有。 */
  tracker: BufferTracker | null;
  /** probe 到的軌道；probe 之後才有。 */
  tracks: readonly ProbedTrack[];
  /** 開檔、probe 中。start 等它完成。 */
  opening: Promise<void>;
  /** 已建立（或正在建立）libav instance，計入 `libavInstances`。 */
  hasInstance: boolean;
  /** 選用影片軌的解碼；第一次輸出影片時建立，load 結束時 close。 */
  video: VideoDecoding<VideoChunk | null, VideoFrame> | null;
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
  /** 目前輸出的 demuxer 與選用的軌，供 stats 的封包佇列與 `rate`。 */
  #current: {
    demuxer: Demuxer<unknown>;
    audio: number | null;
    video: number | null;
    setRate: ((rate: number) => void) | null;
  } | null = null;
  /** `start` 選用的各軌；之後的 `seek` 沿用。`start` 之前為 undefined。 */
  #tracks: { audio: number | null; video: number | null; subtitle: number | null } | undefined =
    undefined;
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
      case 'start':
        this.#tracks = { audio: message.audio, video: message.video, subtitle: message.subtitle };
        // 開檔後 demuxer 在開頭；從其他位置開始要先 seek。
        this.#startOutput({ ...message, seek: message.time > 0 });
        break;
      case 'seek':
        if (this.#tracks === undefined) break;
        this.#startOutput({ ...message, ...this.#tracks, seek: true });
        break;
      case 'rate':
        this.#log.log('debug', 'audio', '改變播放速度', { rate: message.rate });
        if (this.#env) this.#env.rate = message.rate;
        this.#current?.setRate?.(message.rate);
        break;
      case 'frameclosed':
        this.#frames.release(message.count);
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
    const load: Load = {
      epoch: message.epoch,
      controller: new AbortController(),
      media: null,
      source: null,
      tracker: null,
      tracks: [],
      opening: Promise.resolve(),
      hasInstance: false,
      video: null,
      disposed: false,
    };
    this.#load = load;
    load.opening = this.#open(load, message.source);
  }

  async #open(load: Load, wire: WorkerLoadMessage<WorkerHost>['source']): Promise<void> {
    const { signal } = load.controller;
    try {
      const env = this.#requireEnv();
      const open =
        this.#deps.openSource ??
        ((wire, signal, retry) =>
          openSource(wire, signal, {
            retry,
            cache: env.cache,
            log: this.#log,
            onRequestError: (error) => {
              if (this.#load === load) {
                this.#deps.postMessage({ type: 'readerror', error: toWireError(error) });
              }
            },
          }));
      const opened = await open(wire, signal, env.retry);
      if (signal.aborted) {
        opened.close?.();
        signal.throwIfAborted();
      }
      load.source = opened;
      // demux 讀取的位置與當時的 demux 進度用來修正位元組率。
      const source: ByteSource = {
        size: opened.size,
        read: (offset, length, readSignal) => {
          load.tracker?.onRead(offset);
          return opened.read(offset, length, readSignal);
        },
      };
      load.hasInstance = true;
      this.#libavInstances++;
      const media = await LibavMedia.open(env.assets, source, signal);
      signal.throwIfAborted();
      const isSupported = this.#deps.isVideoConfigSupported ?? isVideoConfigSupported;
      const probed = await withPlatformSupport(toProbedMedia(media.raw), media.raw, isSupported);
      signal.throwIfAborted();
      if (!hasPlayableTrack(probed)) {
        throw new WorkerError('CODEC_UNSUPPORTED', '沒有可以播放的音軌或影片軌');
      }
      load.media = media;
      load.tracks = probed.tracks;
      load.tracker = new BufferTracker({
        source: opened,
        size: opened.size,
        duration: probed.duration,
        byteRate: initialByteRate({
          size: probed.size,
          duration: probed.duration,
          bitRates: media.raw.streams
            .filter((s) => s.type === 'audio' || s.type === 'video')
            .map((s) => s.bitRate),
        }),
        readaheadSeconds: env.limits.readaheadSeconds,
        post: (message) => {
          if (this.#load === load) this.#deps.postMessage(message);
        },
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
    try {
      const env = this.#requireEnv();
      const post = (m: WorkerToWorkletMessage, transfer: Transferable[]) => {
        env.port.postMessage(m, transfer);
      };
      const tracker = load.tracker;
      const startTime = Math.max(0, message.time);
      tracker?.start(message.epoch, startTime);
      if (message.audio === null && message.video === null) {
        // 不輸出音訊：worklet 以靜音推進時鐘。
        post({ type: 'eof', epoch: message.epoch }, []);
        return;
      }
      const video = message.video === null ? null : this.#videoDecoding(load, message.video);
      const { limits } = env;
      const started = await media.startOutput({
        audio: message.audio,
        video: video ? message.video : null,
        subtitle: this.#subtitleOutput(load, message, output),
        seek: message.seek,
        startTime,
        signal,
        demux: {
          epoch: message.epoch,
          queueLimits: {
            seconds: NORMAL_QUEUE_SECONDS,
            bytes: NORMAL_QUEUE_BYTES,
            hardBytes: limits.packetQueueBytes,
          },
          onDemux: (end, eof) => {
            tracker?.onDemux(message.epoch, end, eof);
          },
          log: this.#log,
        },
        audioOptions: {
          sampleRate: env.sampleRate,
          rate: env.rate,
          epoch: message.epoch,
          demand: this.#demand,
          pool: this.#pool,
          post,
          log: this.#log,
        },
      });
      signal.throwIfAborted();
      const { demuxer, audio } = started;
      this.#current = {
        demuxer: demuxer as Demuxer<unknown>,
        audio: audio ? message.audio : null,
        video: started.video ? message.video : null,
        setRate: audio
          ? (rate) => {
              audio.setRate(rate);
            }
          : null,
      };
      // 建立 pipeline 期間（seek）收到的 rate。
      audio?.setRate(env.rate);
      this.#log.log('debug', 'audio', '開始供料', {
        epoch: message.epoch,
        audio: message.audio,
        video: message.video,
        codec: message.audio === null ? null : media.raw.streams[message.audio]?.codec,
      });
      if (!audio) post({ type: 'eof', epoch: message.epoch }, []);
      await withDemux(demuxer, signal, () =>
        Promise.all([
          audio?.run(),
          video && started.video
            ? this.#runVideo(video, started.video, message, signal, audio !== null)
            : undefined,
        ]),
      );
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
    if (load.video) return load.video;
    const raw = load.media?.raw.streams[stream];
    const config = raw ? videoConfig(raw) : null;
    if (!config) return null;
    load.video = new VideoDecoding<VideoChunk | null, VideoFrame>({
      config,
      toChunk: (chunk) => chunk,
      credit: this.#frames,
      createDecoder: this.#deps.createVideoDecoder ?? createWebVideoDecoder,
    });
    return load.video;
  }

  /**
   * 解碼一個 epoch 的影片，frame 以 transfer 送給主執行緒。decoder 失敗以 `videoerror` 回報（非致命）。demux 失敗時
   * 影片只是停止（`videoend`），由音訊的供料在播完佇列中的封包後回報；沒有音訊時才由這裡回報。
   */
  async #runVideo(
    video: VideoDecoding<VideoChunk | null, VideoFrame>,
    packets: PacketLane<VideoChunk | null>,
    message: OutputRequest,
    signal: AbortSignal,
    hasAudio: boolean,
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
        fail: (error, beforeFirstFrame) => {
          // configure 或首個 keyframe 失敗：主執行緒不再選用這條影片軌，之後的 seek 也不 demux 它。
          if (beforeFirstFrame && this.#tracks) this.#tracks = { ...this.#tracks, video: null };
          this.#log.log(
            'warn',
            'video',
            `影片解碼失敗${beforeFirstFrame ? '（configure 或首個 keyframe）' : ''}：${error.message}`,
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
      if (!hasAudio) throw error;
    }
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
    if (this.#load === load) this.#load = null;
  }

  #stats(): WorkerStats {
    const env = this.#env;
    const source = this.#load?.source?.stats?.();
    const current = this.#current;
    const video = this.#load?.video ?? null;
    return {
      libavInstances: this.#libavInstances,
      cache: {
        bytes: env?.cache.bytes ?? 0,
        limitBytes: env?.cache.limitBytes ?? 0,
        aheadBytes: source?.aheadBytes ?? 0,
        readaheadTarget: source?.readaheadTarget ?? 0,
        fetching: source?.fetching ?? false,
        hits: env?.cache.hits ?? 0,
        misses: env?.cache.misses ?? 0,
      },
      network: {
        bytesLoaded: source?.bytesLoaded ?? 0,
        inflight: source?.inflight ?? [],
      },
      packetQueue: {
        audioSeconds: current?.audio != null ? current.demuxer.seconds(current.audio) : 0,
        videoSeconds: current?.video != null ? current.demuxer.seconds(current.video) : 0,
        bytes: current?.demuxer.bytes ?? 0,
      },
      wasmHeapBytes: this.#load?.media?.heapBytes ?? 0,
      video: current?.video != null && video ? video.stats : null,
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
