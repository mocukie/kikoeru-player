// 一個來源的資料備妥進度：demux 的進度加上 Range 快取中預讀的 bytes，以位元組率換算成媒體時間（ADR-0007），
// 送給主執行緒作為 `buffered` 與 buffering 恢復的依據；也依位元組率維持預讀的目標。

import type { WorkerBufferMessage } from '../protocol/index.js';
import { ByteRate } from './byte-rate.js';
import { CachedSource } from './range-cache.js';
import type { ByteSource } from './source.js';

/** `end` 至少變動這麼多秒才送出（主執行緒的 `bufferedchange` 另外有 0.5 秒的門檻與節流）。 */
const MIN_END_CHANGE = 0.1;

export interface BufferTrackerOptions {
  source: ByteSource;
  size: number;
  /** 媒體長度（秒）；未知時為 NaN。 */
  duration: number;
  /** 初始的位元組率（bytes／秒），見 `initialByteRate()`。 */
  byteRate: number;
  readaheadSeconds: number;
  post: (message: WorkerBufferMessage) => void;
}

export class BufferTracker {
  readonly #options: BufferTrackerOptions;
  readonly #cached: CachedSource | null;
  readonly #rate: ByteRate;
  #epoch = -1;
  /** 這個 epoch demux 過了（之後才送出）。 */
  #active = false;
  #demuxEnd = 0;
  #demuxEof = false;
  #last: WorkerBufferMessage | null = null;

  constructor(options: BufferTrackerOptions) {
    this.#options = options;
    this.#cached = options.source instanceof CachedSource ? options.source : null;
    this.#rate = new ByteRate(options.byteRate);
    if (this.#cached) {
      this.#cached.onChange = () => {
        this.#update();
      };
    }
  }

  /** 開始一個 epoch 的輸出（start、seek）：demux 從 `time` 起，位元組率重新累計，並開始預讀。 */
  start(epoch: number, time: number): void {
    this.#epoch = epoch;
    this.#active = false;
    this.#demuxEnd = time;
    this.#demuxEof = false;
    this.#rate.reset();
    this.#updateTarget();
  }

  /** demux 讀取來源的 `position`：與目前的 demux 進度一起修正位元組率。 */
  onRead(position: number): void {
    this.#rate.observe(position, this.#demuxEnd);
    this.#updateTarget();
  }

  /** `epoch` 的 demux 進度：封包到媒體時間 `end`；`eof` 表示 demux 到了結尾。 */
  onDemux(epoch: number, end: number, eof: boolean): void {
    if (epoch !== this.#epoch) return;
    this.#active = true;
    this.#demuxEnd = end;
    this.#demuxEof ||= eof;
    this.#update();
  }

  #updateTarget(): void {
    this.#cached?.setReadahead(this.#options.readaheadSeconds * this.#rate.value);
  }

  #update(): void {
    if (!this.#active) return;
    const message = this.#message();
    const last = this.#last;
    if (
      last?.epoch === message.epoch &&
      last.eof === message.eof &&
      last.fetching === message.fetching &&
      (Object.is(last.end, message.end) || Math.abs(last.end - message.end) < MIN_END_CHANGE)
    ) {
      return;
    }
    this.#last = message;
    this.#options.post(message);
  }

  #message(): WorkerBufferMessage {
    const { duration, size } = this.#options;
    const epoch = this.#epoch;
    const source = this.#cached;
    if (!source) return { type: 'buffer', epoch, end: duration, eof: true, fetching: false };
    const ahead = source.aheadBytes;
    const position = source.position;
    const eof = this.#demuxEof || (position !== null && position + ahead >= size);
    let end = this.#demuxEnd + ahead / this.#rate.value;
    if (Number.isFinite(duration)) end = eof ? duration : Math.min(end, duration);
    return { type: 'buffer', epoch, end, eof, fetching: source.fetching };
  }
}
