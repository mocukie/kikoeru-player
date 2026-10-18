// 真實的音訊輸出：一個 AudioContext 與輸出 stereo 的 AudioWorkletNode（ADR-0004）。
// 每個 media Worker 經新的 MessageChannel 直接供料給 worklet。

import type {
  MainToWorkletMessage,
  WorkletConnectMessage,
  WorkletProcessorName,
  WorkletProcessorOptions,
  WorkletToMainMessage,
} from '../protocol/index.js';
import type { AudioOutput, AudioOutputConfig, MainHost } from './deps.js';

/** `unlock()` 與 `close()` 等待 AudioContext 的上限（ms），對齊 ADR-0004 的 2 秒 timeout。 */
const CONTEXT_TIMEOUT_MS = 2000;

/** worklet 的預設位置；`addModule()` 原樣載入，App 的 bundler 依這個寫法把檔案當成資產複製。 */
function defaultWorkletUrl(): URL {
  return new URL('../worklet/index.js', import.meta.url);
}

/**
 * 建立 AudioContext（不指定 `sampleRate`，`latencyHint: 'playback'`）並載入 worklet。
 * 在 user gesture 的同步段內呼叫時，context 會直接開始。
 */
export function createWebAudioOutput(
  onMessage: (message: WorkletToMainMessage) => void,
  config: AudioOutputConfig,
): AudioOutput {
  return new WebAudioOutput(onMessage, config);
}

class WebAudioOutput implements AudioOutput {
  readonly #context: AudioContext;
  /** worklet 載入、node 接上 destination 之後 resolve。 */
  readonly #ready: Promise<AudioWorkletNode>;
  #node: AudioWorkletNode | null = null;
  /** node 建立之前送出的訊息，建立後依序送出。 */
  #queued: MainToWorkletMessage[] = [];
  #disconnected = false;

  constructor(onMessage: (message: WorkletToMainMessage) => void, config: AudioOutputConfig) {
    const context = new AudioContext({ latencyHint: 'playback' });
    this.#context = context;
    this.#ready = (async () => {
      await context.audioWorklet.addModule(config.workletUrl ?? defaultWorkletUrl());
      const name: WorkletProcessorName = 'kikoeru-player-output';
      const processorOptions: WorkletProcessorOptions = { audioBuffer: config.audioBuffer };
      const node = new AudioWorkletNode(context, name, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = ({ data }: MessageEvent<WorkletToMainMessage>) => {
        if (!this.#disconnected) onMessage(data);
      };
      node.connect(context.destination);
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

  post(message: MainToWorkletMessage): void {
    if (this.#node) this.#node.port.postMessage(message);
    else this.#queued.push(message);
  }

  unlock(): Promise<boolean> {
    // 必須在呼叫內同步 resume，user gesture 才算數。
    const resuming = this.#context.resume().then(
      () => true,
      () => false,
    );
    return withTimeout(resuming, false);
  }

  disconnect(): void {
    this.#disconnected = true;
    this.#queued = [];
    if (this.#node) {
      this.#node.port.onmessage = null;
      this.#node.port.close();
      this.#node.disconnect();
    }
  }

  async close(): Promise<void> {
    // 完整的串行佇列由「AudioContext 生命週期」#41 加入；這裡至少保證一定會 settle。
    await withTimeout(
      this.#context.close().then(
        () => true,
        () => false,
      ),
      false,
    );
  }
}

/** `promise` 在 `CONTEXT_TIMEOUT_MS` 內沒有 resolve 時以 `fallback` resolve。 */
function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, CONTEXT_TIMEOUT_MS);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
