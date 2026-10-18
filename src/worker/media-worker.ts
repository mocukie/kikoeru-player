// media Worker 的訊息處理：init、load（開檔與 probe）、start（音訊供料）、port（改接重建後的 worklet）與 stats。
// 主執行緒每次 load 都 terminate 舊的 Worker（ADR-0002），但 Worker 也處理同一個 Worker 內的 load 取代：
// 前一個 load 的讀取被中止、instance 被丟棄。

import type {
  MainToWorkerMessage,
  WorkerLoadMessage,
  WorkerPortMessage,
  WorkerStartMessage,
  WorkerToMainMessage,
  WorkerToWorkletMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { BufferPool, Demand } from './audio-pipeline.js';
import { toWireError, WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { LibavMedia, type Instantiate, type LibavAssets } from './libav.js';
import { hasPlayableTrack, toProbedMedia } from './probe.js';
import { openSource, type ByteSource } from './source.js';

export interface MediaWorkerDeps {
  postMessage(message: WorkerToMainMessage): void;
  /** 開啟來源；預設為 `source.ts` 的實作，測試可以換成可控制的來源。 */
  openSource?: (
    wire: WorkerLoadMessage<WorkerHost>['source'],
    signal: AbortSignal,
  ) => Promise<ByteSource>;
  /** 建立 libav instance；預設為 `WebAssembly.instantiate`，測試可以模擬配置失敗。 */
  instantiate?: Instantiate;
}

/** Worker 從 init 得到的環境。 */
interface Environment {
  assets: LibavAssets;
  port: MessagePort;
  sampleRate: number;
}

/** 一次 load：一個來源與它的 libav instance。 */
interface Load {
  epoch: number;
  controller: AbortController;
  /** 開檔完成後才有。 */
  media: LibavMedia | null;
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
  /** 這個 load 最後一個 start（`port` 重新供料時沿用它的音軌）；新的 load 清掉。 */
  #started: WorkerStartMessage | null = null;
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
        this.#start(message);
        break;
      case 'seek':
        // 精準 seek 與讀取中止後的恢復由「精準 seek 與 reload」#37 加入。
        break;
      case 'stats':
        this.#deps.postMessage({
          type: 'stats',
          id: message.id,
          stats: { libavInstances: this.#libavInstances },
        });
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
    // 舊的 worklet 的要求已經沒有意義；新的 worklet 會以新的 epoch 要資料。
    // 重新供料沿用 start 的流程（從 demuxer 目前的位置解碼，丟掉 `time` 之前的 sample）；
    // 精準 seek（#37）完成後改走 seek 的流程。
    const start = this.#started;
    if (start) this.#start({ ...start, epoch: message.epoch, time: message.time });
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
    this.#started = null;
    if (this.#load) this.#dispose(this.#load);
    const load: Load = {
      epoch: message.epoch,
      controller: new AbortController(),
      media: null,
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
      const open = this.#deps.openSource ?? openSource;
      const source = await open(wire, signal);
      signal.throwIfAborted();
      load.hasInstance = true;
      this.#libavInstances++;
      const media = await LibavMedia.open(env.assets, source, signal);
      signal.throwIfAborted();
      const probed = toProbedMedia(media.raw);
      if (!hasPlayableTrack(probed)) {
        throw new WorkerError('CODEC_UNSUPPORTED', '沒有可以播放的音軌或影片軌');
      }
      load.media = media;
      this.#deps.postMessage({ type: 'probe', epoch: load.epoch, media: probed });
    } catch (error) {
      // open／probe 被中止或失敗：丟掉這個 instance。被取代的 load 不回報。
      const superseded = signal.aborted;
      this.#dispose(load);
      if (!superseded) this.#reportError(load.epoch, error);
    }
  }

  #start(message: WorkerStartMessage): void {
    const load = this.#load;
    if (!load) return;
    this.#started = message;
    this.#stopOutput();
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

  async #runOutput(
    load: Load,
    message: WorkerStartMessage,
    output: AbortController,
  ): Promise<void> {
    const { signal } = output;
    if (signal.aborted || !load.media) return;
    try {
      const env = this.#requireEnv();
      const post = (m: WorkerToWorkletMessage, transfer: Transferable[]) => {
        env.port.postMessage(m, transfer);
      };
      if (message.audio === null) {
        // 不輸出音訊：worklet 以靜音推進時鐘。
        post({ type: 'eof', epoch: message.epoch }, []);
        return;
      }
      const pipeline = await load.media.startAudio(message.audio, {
        sampleRate: env.sampleRate,
        startTime: Math.max(0, message.time),
        epoch: message.epoch,
        demand: this.#demand,
        pool: this.#pool,
        signal,
        post,
      });
      signal.throwIfAborted();
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
    load.media = null;
    if (load.hasInstance) this.#libavInstances--;
    if (this.#load === load) this.#load = null;
  }

  #reportError(epoch: number, error: unknown): void {
    if (error instanceof WebAssembly.RuntimeError) {
      // wasm trap 之後 instance 不能再用；主執行緒回報 INTERNAL（完整的崩潰路線見 #40）。
      this.#deps.postMessage({ type: 'crash', reason: 'wasm-trap', message: error.message });
      return;
    }
    this.#deps.postMessage({ type: 'error', epoch, error: toWireError(error) });
  }

  #requireEnv(): Environment {
    if (!this.#env) throw new WorkerError('INTERNAL', 'media Worker 還沒有收到 init');
    return this.#env;
  }
}
