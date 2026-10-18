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
import {
  AssetLoadError,
  type AudioOutput,
  type AudioOutputConfig,
  type AudioOutputHandlers,
  type MainHost,
} from './deps.js';

/** 音量變化的 `setTargetAtTime` time constant（秒）。 */
const GAIN_TIME_CONSTANT = 0.01;

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
      const name: WorkletProcessorName = 'kikoeru-player-output';
      const processorOptions: WorkletProcessorOptions = {
        audioBuffer: config.audioBuffer,
        audioFadeMs: config.audioFadeMs,
      };
      const node = new AudioWorkletNode(context, name, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = ({ data }: MessageEvent<WorkletToMainMessage>) => {
        if (!this.#disconnected) handlers.message(data);
      };
      node.connect(gain);
      gain.connect(context.destination);
      this.#node = node;
      for (const message of this.#queued.splice(0)) node.port.postMessage(message);
      return node;
    })();
    // connect() 回報錯誤；這裡只避免 unhandled rejection。
    this.#ready.catch(() => undefined);
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

  /** 此刻聽到的 context 時間（秒）；context 還沒開始時為 null。 */
  #heardTime(): number | null {
    const context = this.#context;
    return heardContextTime({
      currentTime: context.currentTime,
      now: performance.now(),
      // Safari 以外都有；舊版 Safari 沒有 outputLatency。
      timestamp: 'getOutputTimestamp' in context ? context.getOutputTimestamp() : undefined,
      outputLatency: 'outputLatency' in context ? context.outputLatency : undefined,
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
    return this.#context.close();
  }

  disconnect(): void {
    this.#disconnected = true;
    this.#queued = [];
    this.#context.onstatechange = null;
    if (this.#node) {
      this.#node.port.onmessage = null;
      this.#node.port.close();
      this.#node.disconnect();
    }
    this.#gain.disconnect();
  }
}
