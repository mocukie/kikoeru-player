// 真實的音訊輸出：一個 AudioContext 與輸出 stereo 的 AudioWorkletNode（ADR-0004）。
// 每個 media Worker 經新的 MessageChannel 直接供料給 worklet。

import type {
  MainToWorkletMessage,
  WorkletConnectMessage,
  WorkletProcessorName,
  WorkletProcessorOptions,
  WorkletToMainMessage,
} from '../protocol/index.js';
import { heardContextTime } from './latency.js';
import { fromContextFrame } from './log.js';
import {
  AssetLoadError,
  type AudioOutput,
  type AudioOutputConfig,
  type AudioOutputHandlers,
  type MainHost,
} from './deps.js';

/** 音量變化的 `setTargetAtTime` time constant（秒）。 */
const GAIN_TIME_CONSTANT = 0.01;

/**
 * 第一次讀 `outputLatency` 與 `getOutputTimestamp()`（預熱）之前要等的時間（ms）：context 開始 render 滿這麼久，
 * 而且預熱之前就開始播放（對 worklet 送出 `play`，或換算聽到的位置）時，開始播放也滿這麼久（#76）。
 *
 * Gecko 在輸出延遲還沒快取時，主執行緒持有 graph 的 monitor 同步向 cubeb 查詢；這個查詢碰上剛開始的另一個音訊串流
 * （例如背景播放模組的 anchor `<audio>`）時，會與 AudioIPC、PulseAudio 的 callback 形成死鎖，content process 整個卡住。
 * 第一次換算發生在開始播放的那一刻，anchor 也在那一刻開始。所以由音訊輸出在 context 與 anchor 的串流都已經啟動之後
 * 自己先讀一次 `outputLatency`，Gecko 之後就使用快取；在那之前換算只扣 `baseLatency`。通常 context 在 load 時
 * 就開始 render，到開始播放時已經預熱過，換算不受影響。
 * 150 ms：#76 的實驗中錯開 50 ms 以上就不再卡死；更長的話，開始播放時還沒預熱的情況下，開頭不準的那段也更長。
 * 其他與 Engine 無關的串流（例如 App 自己的 `<audio>`）剛好在預熱的那一刻開始時仍可能碰上，Engine 無法避開。
 */
const LATENCY_WARMUP_MS = 150;

/** 還沒看到 context 開始 render，或預熱讀到 0（Gecko 不快取 0）時，再試的間隔（ms）。 */
const WARMUP_RETRY_MS = 50;

/** 預熱讀到 0 時最多再試的次數；之後照常讀延遲相關的 API。 */
const WARMUP_ZERO_RETRIES = 10;

/** worklet 的預設位置；`addModule()` 原樣載入，App 的 bundler 依這個寫法把檔案當成資產複製。 */
function defaultWorkletUrl(): URL {
  return new URL('../worklet/index.js', import.meta.url);
}

/**
 * 建立 AudioContext（不指定 `sampleRate`，`latencyHint: 'playback'`）並載入 worklet；worklet 經 `GainNode`
 * （音量與靜音）接到 destination。
 * `resume()`、`suspend()`、`close()` 原樣轉給 AudioContext，串行與 timeout 由 Engine 的佇列負責。
 */
export function createWebAudioOutput(
  handlers: AudioOutputHandlers,
  config: AudioOutputConfig,
): AudioOutput {
  return new WebAudioOutput(handlers, config);
}

class WebAudioOutput implements AudioOutput {
  readonly #context: AudioContext;
  readonly #gain: GainNode;
  /** worklet 載入、node 接上 destination 之後 resolve。 */
  readonly #ready: Promise<AudioWorkletNode>;
  #node: AudioWorkletNode | null = null;
  /** node 建立之前送出的訊息，建立後依序送出。 */
  #queued: MainToWorkletMessage[] = [];
  #disconnected = false;
  /** 第一次看到 context 開始 render（`currentTime` 大於 0）的 `performance.now()`（ms）；還沒看到時為 null。 */
  #renderingSince: number | null = null;
  /** 預熱之前第一次開始播放（送出 `play` 或換算聽到的位置）的 `performance.now()`（ms）；還沒有時為 null。 */
  #playbackStartedAt: number | null = null;
  /** 已經預熱，之後可以讀延遲相關的 API。 */
  #latencyWarm = false;
  /** 預熱讀到 0 的次數。 */
  #zeroReads = 0;
  #warmupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: AudioOutputHandlers, config: AudioOutputConfig) {
    const context = new AudioContext({ latencyHint: 'playback' });
    this.#context = context;
    const gain = new GainNode(context);
    this.#gain = gain;
    context.onstatechange = () => {
      if (!this.#disconnected) handlers.statechange(context.state);
    };
    this.#ready = (async () => {
      const url = config.workletUrl ?? defaultWorkletUrl();
      try {
        await context.audioWorklet.addModule(url);
      } catch (cause) {
        throw new AssetLoadError(`無法載入 AudioWorklet（${String(url)}）`, { cause });
      }
      // 載入期間已經 disconnect()（destroy 或 watchdog 重建）：不再建立 node、不接上 destination，
      // 否則已關閉的 context 會留下接著 destination 的 node 與沒有關閉的 port。
      if (this.#disconnected) throw new Error('音訊輸出在 AudioWorklet 載入期間已經斷開');
      const name: WorkletProcessorName = 'kikoeru-player-output';
      const processorOptions: WorkletProcessorOptions = {
        audioBuffer: config.audioBuffer,
        audioFadeMs: config.audioFadeMs,
        logLevel: config.logLevel,
      };
      const node = new AudioWorkletNode(context, name, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = ({ data }: MessageEvent<WorkletToMainMessage>) => {
        if (this.#disconnected) return;
        if (data.type !== 'log') {
          handlers.message(data);
          return;
        }
        const time = fromContextFrame({
          frame: data.frame,
          sampleRate: context.sampleRate,
          currentTime: context.currentTime,
          now: performance.now(),
        });
        handlers.log({ ...data.entry, time });
      };
      node.connect(gain);
      gain.connect(context.destination);
      this.#node = node;
      for (const message of this.#queued.splice(0)) node.port.postMessage(message);
      return node;
    })();
    // connect() 回報錯誤；這裡只避免 unhandled rejection。
    this.#ready.catch(() => undefined);
    this.#warmupTimer = setTimeout(this.#warmUpLatency, WARMUP_RETRY_MS);
  }

  /**
   * 預熱：`LATENCY_WARMUP_MS` 的條件都滿足時讀一次 `outputLatency`，讓 Gecko 在此刻查詢並快取；還沒滿足時排到那時候，
   * 讀到 0 時稍後再讀。
   */
  readonly #warmUpLatency = (): void => {
    this.#warmupTimer = null;
    if (this.#disconnected) return;
    const now = performance.now();
    const since = this.#observeRendering(now);
    const warmupAt =
      since === null ? null : Math.max(since, this.#playbackStartedAt ?? since) + LATENCY_WARMUP_MS;
    if (warmupAt === null || now < warmupAt) {
      this.#warmupTimer = setTimeout(
        this.#warmUpLatency,
        warmupAt === null ? WARMUP_RETRY_MS : warmupAt - now,
      );
      return;
    }
    // Safari 以外都有。
    const latency = 'outputLatency' in this.#context ? this.#context.outputLatency : undefined;
    if (latency === 0 && this.#zeroReads++ < WARMUP_ZERO_RETRIES) {
      this.#warmupTimer = setTimeout(this.#warmUpLatency, WARMUP_RETRY_MS);
      return;
    }
    this.#latencyWarm = true;
  };

  #stopWarmup(): void {
    if (this.#warmupTimer !== null) clearTimeout(this.#warmupTimer);
    this.#warmupTimer = null;
  }

  /** 記下 context 第一次被看到開始 render 的時刻並回傳；還沒開始時為 null。 */
  #observeRendering(now: number): number | null {
    if (this.#renderingSince === null && this.#context.currentTime > 0) this.#renderingSince = now;
    return this.#renderingSince;
  }

  get sampleRate(): number {
    return this.#context.sampleRate;
  }

  async connect(): Promise<MessagePort> {
    const node = await this.#ready;
    const channel = new MessageChannel();
    const message: WorkletConnectMessage<MainHost> = { type: 'connect', port: channel.port1 };
    node.port.postMessage(message, [channel.port1]);
    return channel.port2;
  }

  heardFrame(): number | null {
    const heard = this.#heardTime();
    return heard === null ? null : heard * this.#context.sampleRate;
  }

  outputLatency(): number {
    const heard = this.#heardTime();
    return heard === null ? 0 : Math.max(0, this.#context.currentTime - heard);
  }

  /**
   * 此刻聽到的 context 時間（秒）；context 還沒開始時為 null。預熱之前只扣 `baseLatency`，並把這次換算當成開始播放，
   * 預熱延到它之後。
   */
  #heardTime(): number | null {
    const context = this.#context;
    const currentTime = context.currentTime;
    const now = performance.now();
    const since = this.#observeRendering(now);
    if (since === null) return null;
    const warm = this.#latencyWarm;
    if (!warm) this.#playbackStartedAt ??= now;
    return heardContextTime({
      currentTime,
      now,
      // Safari 以外都有；舊版 Safari 沒有 outputLatency。
      timestamp: warm && 'getOutputTimestamp' in context ? context.getOutputTimestamp() : undefined,
      outputLatency: warm && 'outputLatency' in context ? context.outputLatency : undefined,
      baseLatency: context.baseLatency,
    });
  }

  setGain(gain: number, smooth: boolean): void {
    const param = this.#gain.gain;
    const now = this.#context.currentTime;
    param.cancelScheduledValues(now);
    if (smooth) param.setTargetAtTime(gain, now, GAIN_TIME_CONSTANT);
    else param.value = gain;
  }

  post(message: MainToWorkletMessage): void {
    // 預熱之前開始播放：預熱延到它之後（LATENCY_WARMUP_MS）。
    if (message.type === 'play' && !this.#latencyWarm)
      this.#playbackStartedAt ??= performance.now();
    if (this.#node) this.#node.port.postMessage(message);
    else this.#queued.push(message);
  }

  resume(): Promise<void> {
    return this.#context.resume();
  }

  suspend(): Promise<void> {
    return this.#context.suspend();
  }

  close(): Promise<void> {
    this.#stopWarmup();
    return this.#context.close();
  }

  disconnect(): void {
    this.#disconnected = true;
    this.#queued = [];
    this.#stopWarmup();
    this.#context.onstatechange = null;
    if (this.#node) {
      this.#node.port.onmessage = null;
      this.#node.port.close();
      this.#node.disconnect();
    }
    this.#gain.disconnect();
  }
}
