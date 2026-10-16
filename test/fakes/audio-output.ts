// 假音訊輸出：記錄送給 AudioWorklet 的訊息，worklet 的回報由測試腳本控制。

import type { MainToWorkletMessage, WorkletToMainMessage } from '../../src/protocol/index.js';

/** 省略 epoch 的 worklet 訊息（逐一套用到 union 的每個成員）。 */
type WithOptionalEpoch<T> = T extends unknown ? Omit<T, 'epoch'> & { epoch?: number } : never;

export class FakeAudioOutput {
  readonly sampleRate = 48_000;
  readonly received: MainToWorkletMessage[] = [];
  /** 依發生順序記錄 connect／disconnect／close，用來檢查 destroy 的步驟。 */
  readonly calls: ('connect' | 'disconnect' | 'close')[] = [];
  readonly #onMessage: (message: WorkletToMainMessage) => void;
  readonly #channels: MessageChannel[] = [];

  constructor(onMessage: (message: WorkletToMainMessage) => void) {
    this.#onMessage = onMessage;
  }

  connect(): Promise<MessagePort> {
    this.calls.push('connect');
    const channel = new MessageChannel();
    this.#channels.push(channel);
    return Promise.resolve(channel.port2);
  }

  post(message: MainToWorkletMessage): void {
    this.received.push(message);
  }

  disconnect(): void {
    this.calls.push('disconnect');
    this.release();
  }

  close(): Promise<void> {
    this.calls.push('close');
    return Promise.resolve();
  }

  /** 最後一個 `flush` 的 epoch，也就是 worklet 目前的 epoch。 */
  get epoch(): number {
    const flush = this.received.findLast((m) => m.type === 'flush');
    if (!flush) throw new Error('worklet 還沒收到 flush');
    return flush.epoch;
  }

  /** 以 worklet 的身分回報；省略 epoch 時用目前的 epoch。 */
  reply(message: WithOptionalEpoch<WorkletToMainMessage>): void {
    this.#onMessage({ ...message, epoch: message.epoch ?? this.epoch });
  }

  /** 關閉 connect() 建立的 MessageChannel，避免 Node 的 port 留著。 */
  release(): void {
    for (const channel of this.#channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  }
}
