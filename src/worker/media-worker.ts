// media Worker 的訊息處理：init、load（開檔與 probe）、start 與 seek（音訊供料）、port（改接重建後的 worklet）、
// rate（變速）與 stats。
// 主執行緒每次 load 都 terminate 舊的 Worker（ADR-0002），但 Worker 也處理同一個 Worker 內的 load 取代：
// 前一個 load 的讀取被中止、instance 被丟棄。

import type {
  MainToWorkerMessage,
  RetryPolicy,
  WorkerLimits,
  WorkerLoadMessage,
  WorkerPortMessage,
  WorkerStats,
  WorkerToMainMessage,
  WorkerToWorkletMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { BufferPool, Demand, type AudioPipeline } from './audio-pipeline.js';
import { BufferTracker } from './buffer-tracker.js';
import { initialByteRate } from './byte-rate.js';
import { crashReason, toWireError, WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { LibavMedia, type Instantiate, type LibavAssets } from './libav.js';
import { NORMAL_QUEUE_BYTES, NORMAL_QUEUE_SECONDS } from './packet-queue.js';
import { hasPlayableTrack, toProbedMedia } from './probe.js';
import { CachedSource, RangeCache } from './range-cache.js';
import { openSource, type ByteSource } from './source.js';

export interface MediaWorkerDeps {
  postMessage(message: WorkerToMainMessage): void;
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
  /** 先 seek 到 `time`；false 時接著 demuxer 目前的位置（開檔後的開頭）讀。 */
  seek: boolean;
}

/** 一次 load：一個來源與它的 libav instance。 */
interface Load {
  epoch: number;
  controller: AbortController;
  /** 開檔完成後才有。 */
  media: LibavMedia | null;
  /** 開好的來源；http 時是 `CachedSource`。 */
  source: ByteSource | null;
  /** probe 之後才有。 */
  tracker: BufferTracker | null;
  /** 開檔、probe 中。start 等它完成。 */
  opening: Promise<void>;
  /** 已建立（或正在建立）libav instance，計入 `libavInstances`。 */
  hasInstance: boolean;
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
  /** 目前輸出的 pipeline，供 stats 的封包佇列。 */
  #pipeline: AudioPipeline<unknown> | null = null;
  /** `start` 選用的音軌；之後的 `seek` 沿用。`start` 之前為 undefined。 */
  #audio: number | null | undefined = undefined;
  #libavInstances = 0;

  constructor(deps: MediaWorkerDeps) {
    this.#deps = deps;
  }

  handle(message: MainToWorkerMessage<WorkerHost>): void {
    switch (message.type) {
      case 'init':
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
        this.#audio = message.audio;
        // 開檔後 demuxer 在開頭；從其他位置開始要先 seek。
        this.#startOutput({ ...message, seek: message.time > 0 });
        break;
      case 'seek':
        if (this.#audio === undefined) break;
        this.#startOutput({ ...message, audio: this.#audio, seek: true });
        break;
      case 'rate':
        if (this.#env) this.#env.rate = message.rate;
        this.#pipeline?.setRate(message.rate);
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
    env.port.onmessage = null;
    env.port.close();
    env.port = message.port;
    this.#listen(message.port);
    // 舊的 worklet 的要求已經沒有意義；新的 worklet 會以新的 epoch 要資料。重新供料走 seek 的流程。
    if (this.#audio !== undefined) {
      this.#startOutput({
        epoch: message.epoch,
        time: message.time,
        audio: this.#audio,
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
    this.#audio = undefined;
    this.#pipeline = null;
    if (this.#load) this.#dispose(this.#load);
    const load: Load = {
      epoch: message.epoch,
      controller: new AbortController(),
      media: null,
      source: null,
      tracker: null,
      opening: Promise.resolve(),
      hasInstance: false,
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
            onRequestError: (error) => {
              if (this.#load === load) {
                this.#deps.postMessage({ type: 'readerror', error: toWireError(error) });
              }
            },
          }));
      const opened = await open(wire, signal, env.retry);
      if (signal.aborted) {
        if (opened instanceof CachedSource) opened.close();
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
      const probed = toProbedMedia(media.raw);
      if (!hasPlayableTrack(probed)) {
        throw new WorkerError('CODEC_UNSUPPORTED', '沒有可以播放的音軌或影片軌');
      }
      load.media = media;
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
    this.#stopOutput();
    load.media?.abortReads();
    // seek 時進行中的網路請求（含預讀）一起中止：卡住的請求要換新的才能恢復。開檔後的第一次輸出不 seek，
    // demuxer 接著讀，不必中止。
    if (message.seek && load.source instanceof CachedSource) load.source.abort();
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
    if (signal.aborted || !load.media) return;
    try {
      const env = this.#requireEnv();
      const post = (m: WorkerToWorkletMessage, transfer: Transferable[]) => {
        env.port.postMessage(m, transfer);
      };
      const tracker = load.tracker;
      tracker?.start(message.epoch, Math.max(0, message.time));
      if (message.audio === null) {
        // 不輸出音訊：worklet 以靜音推進時鐘。
        post({ type: 'eof', epoch: message.epoch }, []);
        return;
      }
      const { limits } = env;
      const pipeline = await load.media.startAudio(message.audio, {
        sampleRate: env.sampleRate,
        startTime: Math.max(0, message.time),
        rate: env.rate,
        seek: message.seek,
        epoch: message.epoch,
        demand: this.#demand,
        pool: this.#pool,
        signal,
        post,
        queueLimits: {
          seconds: NORMAL_QUEUE_SECONDS,
          bytes: NORMAL_QUEUE_BYTES,
          hardBytes: limits.packetQueueBytes,
        },
        onDemux: (end, eof) => {
          tracker?.onDemux(message.epoch, end, eof);
        },
      });
      signal.throwIfAborted();
      this.#pipeline = pipeline as AudioPipeline<unknown>;
      // 建立 pipeline 期間（seek）收到的 rate。
      pipeline.setRate(env.rate);
      await pipeline.run();
    } catch (error) {
      // 被取代：中止的讀取或 libav 回傳的任何錯誤都不回報。
      if (this.#output !== output) return;
      this.#reportError(message.epoch, error);
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
    if (load.source instanceof CachedSource) load.source.close();
    load.media = null;
    if (load.hasInstance) this.#libavInstances--;
    if (this.#load === load) this.#load = null;
  }

  #stats(): WorkerStats {
    const env = this.#env;
    const source = this.#load?.source;
    const cached = source instanceof CachedSource ? source : null;
    const pipeline = this.#pipeline;
    return {
      libavInstances: this.#libavInstances,
      cache: {
        bytes: env?.cache.bytes ?? 0,
        limitBytes: env?.cache.limitBytes ?? 0,
        aheadBytes: cached?.aheadBytes ?? 0,
        readaheadTarget: cached?.readaheadTarget ?? 0,
        fetching: cached?.fetching ?? false,
        hits: env?.cache.hits ?? 0,
        misses: env?.cache.misses ?? 0,
      },
      network: {
        bytesLoaded: cached?.client.bytesLoaded ?? 0,
        inflight: cached?.client.inflight() ?? [],
      },
      packetQueue: {
        audioSeconds: pipeline?.queuedSeconds ?? 0,
        videoSeconds: 0,
        bytes: pipeline?.queuedBytes ?? 0,
      },
    };
  }

  #reportError(epoch: number, error: unknown): void {
    // wasm trap 或記憶體用完：instance 不能再用，主執行緒回報 INTERNAL 並 terminate 這個 Worker。
    const reason = crashReason(error);
    if (reason !== null) {
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
