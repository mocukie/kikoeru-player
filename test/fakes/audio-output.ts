// 假音訊輸出：記錄送給 AudioWorklet 的訊息與對 AudioContext 的呼叫，worklet 的回報與 context 的結果由測試腳本控制。

import type { MainToWorkletMessage, WorkletToMainMessage } from '../../src/protocol/index.js';

/** 省略 epoch 的 worklet 訊息（逐一套用到 union 的每個成員）。 */
type WithOptionalEpoch<T> = T extends unknown ? Omit<T, 'epoch'> & { epoch?: number } : never;

/** Engine 建立音訊輸出時給的設定（同 `AudioOutputConfig`）。 */
export interface FakeAudioOutputConfig {
  audioBuffer: { targetMs: number; refillMs: number; capacityMs: number };
  audioFadeMs: number;
  workletUrl?: string | URL;
}

/** Engine 建立音訊輸出時給的回呼（同 `AudioOutputHandlers`）。 */
export interface FakeAudioOutputHandlers {
  message(message: WorkletToMainMessage): void;
  statechange(state: AudioContextState): void;
}

/** `resume()`／`suspend()`／`close()` 的結果：立即 resolve、立即 reject，或永遠不 settle。 */
export type ContextOpBehavior = 'resolve' | 'reject' | 'hang';

type ContextCall = 'resume' | 'suspend' | 'close';

/** 一個還沒 settle 的 context 操作，測試可以自己 settle 它。 */
export interface PendingContextOp {
  call: ContextCall;
  resolve(): void;
  reject(): void;
}

export class FakeAudioOutput {
  readonly sampleRate = 48_000;
  readonly received: MainToWorkletMessage[] = [];
  /** 依發生順序記錄 connect／disconnect 與 context 的呼叫，用來檢查步驟。 */
  readonly calls: ('connect' | 'disconnect' | ContextCall)[] = [];
  /** 各 context 操作的結果；預設立即 resolve。 */
  readonly behavior: Record<ContextCall, ContextOpBehavior> = {
    resume: 'resolve',
    suspend: 'resolve',
    close: 'resolve',
  };
  /** `behavior` 為 `'hang'` 的呼叫，依呼叫順序。 */
  readonly pending: PendingContextOp[] = [];
  /** `heardFrame()` 的回傳值：此刻聽到的 context frame；null 表示 context 還沒開始。 */
  frameNow: number | null = null;
  /** `outputLatency()` 的回傳值（秒）。 */
  latency = 0;
  /** `setGain()` 的呼叫，依順序。 */
  readonly gains: { gain: number; smooth: boolean }[] = [];
  /** 設定時 `connect()` 以它 reject，模擬 worklet 載入或建立失敗。 */
  connectError: Error | null = null;
  readonly config: FakeAudioOutputConfig;
  readonly #handlers: FakeAudioOutputHandlers;
  readonly #channels: MessageChannel[] = [];

  constructor(handlers: FakeAudioOutputHandlers, config: FakeAudioOutputConfig) {
    this.#handlers = handlers;
    this.config = config;
  }

  resume(): Promise<void> {
    return this.#op('resume');
  }

  suspend(): Promise<void> {
    return this.#op('suspend');
  }

  close(): Promise<void> {
    return this.#op('close');
  }

  connect(): Promise<MessagePort> {
    this.calls.push('connect');
    if (this.connectError !== null) return Promise.reject(this.connectError);
    const channel = new MessageChannel();
    this.#channels.push(channel);
    return Promise.resolve(channel.port2);
  }

  heardFrame(): number | null {
    return this.frameNow;
  }

  outputLatency(): number {
    return this.latency;
  }

  setGain(gain: number, smooth: boolean): void {
    this.gains.push({ gain, smooth });
  }

  post(message: MainToWorkletMessage): void {
    this.received.push(message);
  }

  disconnect(): void {
    this.calls.push('disconnect');
    this.release();
  }

  /** 最後一個 `flush` 的 epoch，也就是 worklet 目前的 epoch。 */
  get epoch(): number {
    const flush = this.received.findLast((m) => m.type === 'flush');
    if (!flush) throw new Error('worklet 還沒收到 flush');
    return flush.epoch;
  }

  /** 最後一個 `play`／`pause`：worklet 目前的播放意圖；還沒收到時為 null。 */
  get intent(): 'play' | 'pause' | null {
    return this.received.findLast((m) => m.type === 'play' || m.type === 'pause')?.type ?? null;
  }

  /** 以 worklet 的身分回報；省略 epoch 時用目前的 epoch。 */
  reply(message: WithOptionalEpoch<WorkletToMainMessage>): void {
    this.#handlers.message({ ...message, epoch: message.epoch ?? this.epoch });
  }

  /** 以 AudioContext 的身分發出 `statechange`。 */
  emitState(state: AudioContextState): void {
    this.#handlers.statechange(state);
  }

  /** 關閉 connect() 建立的 MessageChannel，避免 Node 的 port 留著。 */
  release(): void {
    for (const channel of this.#channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  }

  #op(call: ContextCall): Promise<void> {
    this.calls.push(call);
    switch (this.behavior[call]) {
      case 'resolve':
        return Promise.resolve();
      case 'reject':
        return Promise.reject(new DOMException(`${call}() 被拒絕`, 'NotAllowedError'));
      case 'hang':
        return new Promise<void>((resolve, reject) => {
          this.pending.push({
            call,
            resolve,
            reject: () => {
              reject(new DOMException(`${call}() 被拒絕`, 'NotAllowedError'));
            },
          });
        });
    }
  }
}
