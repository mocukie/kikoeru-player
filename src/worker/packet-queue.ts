// demux 與解碼之間的封包佇列（ADR-0007）：每條選用中的軌一個先進先出的佇列。平常到 2 秒或 8 MiB 就停止 demux；
// 某條選用中的軌是空的（交錯不良的檔案）時繼續 demux，超過硬上限是 fatal 的 MEMORY_LIMIT。

import { WorkerError } from './errors.js';

export interface PacketQueueLimits {
  /** 平常的上限：任一條軌的秒數。 */
  seconds: number;
  /** 平常的上限：所有軌的 bytes 合計。 */
  bytes: number;
  /** 硬上限（bytes），超過時 MEMORY_LIMIT。 */
  hardBytes: number;
}

/** 平常的上限：2 秒或 8 MiB，先到者為準。 */
export const NORMAL_QUEUE_SECONDS = 2;
export const NORMAL_QUEUE_BYTES = 8 * 1024 * 1024;

interface Lane<P> {
  packets: P[];
  bytes: number;
}

export class PacketQueue<P> {
  readonly #lanes = new Map<number, Lane<P>>();
  readonly #limits: PacketQueueLimits;
  readonly #size: (packet: P) => number;
  readonly #timing: (packet: P) => { time: number | null; duration: number };
  #bytes = 0;
  #ended = false;
  #error: Error | null = null;
  readonly #waiters = new Set<() => void>();

  constructor(
    streams: readonly number[],
    limits: PacketQueueLimits,
    size: (packet: P) => number,
    timing: (packet: P) => { time: number | null; duration: number },
  ) {
    for (const stream of streams) this.#lanes.set(stream, { packets: [], bytes: 0 });
    this.#limits = limits;
    this.#size = size;
    this.#timing = timing;
  }

  /** 所有軌的 bytes 合計。 */
  get bytes(): number {
    return this.#bytes;
  }

  /** 不需要再 demux：沒有空的軌，而且任一條軌到了平常的秒數或 bytes 到了平常的上限。 */
  get full(): boolean {
    const lanes = [...this.#lanes.keys()];
    if (lanes.some((s) => this.#lane(s).packets.length === 0)) return false;
    return (
      this.#bytes >= this.#limits.bytes ||
      lanes.some((s) => this.seconds(s) >= this.#limits.seconds)
    );
  }

  /** 一條軌在佇列中的秒數：有時間戳時是最後一個封包的結尾減第一個的時間，否則是時長的合計。 */
  seconds(stream: number): number {
    const { packets } = this.#lane(stream);
    const head = packets[0];
    const tail = packets.at(-1);
    if (!head || !tail) return 0;
    const first = this.#timing(head);
    const last = this.#timing(tail);
    if (first.time !== null && last.time !== null) {
      return Math.max(0, last.time + last.duration - first.time);
    }
    return packets.reduce((sum, p) => sum + this.#timing(p).duration, 0);
  }

  /** 加入一條軌的封包；超過硬上限時丟 MEMORY_LIMIT。 */
  push(stream: number, packets: readonly P[]): void {
    const lane = this.#lane(stream);
    for (const packet of packets) {
      const size = this.#size(packet);
      lane.packets.push(packet);
      lane.bytes += size;
      this.#bytes += size;
    }
    if (this.#bytes > this.#limits.hardBytes) {
      throw new WorkerError(
        'MEMORY_LIMIT',
        `封包佇列超過上限 ${String(this.#limits.hardBytes)} bytes（交錯不良的媒體）`,
      );
    }
    this.#notify();
  }

  /** 取出一條軌的下一個封包；沒有時為 undefined。 */
  shift(stream: number): P | undefined {
    const lane = this.#lane(stream);
    const packet = lane.packets.shift();
    if (packet !== undefined) {
      const size = this.#size(packet);
      lane.bytes -= size;
      this.#bytes -= size;
      this.#notify();
    }
    return packet;
  }

  /** 等到一條軌有封包並取出；demux 結束、佇列空了時為 undefined，demux 失敗時以它的錯誤 reject。 */
  async next(stream: number, signal: AbortSignal): Promise<P | undefined> {
    for (;;) {
      const packet = this.shift(stream);
      if (packet !== undefined) return packet;
      if (this.#error !== null) throw this.#error;
      if (this.#ended) return undefined;
      await this.#wait(signal);
    }
  }

  /** 等到不滿（可以繼續 demux）。 */
  async space(signal: AbortSignal): Promise<void> {
    while (this.full) await this.#wait(signal);
    signal.throwIfAborted();
  }

  /** demux 已到結尾，而且佇列空了。 */
  get drained(): boolean {
    return (
      this.#ended &&
      this.#bytes === 0 &&
      [...this.#lanes.values()].every((l) => l.packets.length === 0)
    );
  }

  /** demux 到了結尾。 */
  end(): void {
    this.#ended = true;
    this.#notify();
  }

  /** demux 失敗：等待封包的一方以這個錯誤 reject。 */
  fail(error: unknown): void {
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#notify();
  }

  #lane(stream: number): Lane<P> {
    const lane = this.#lanes.get(stream);
    if (!lane) throw new WorkerError('INTERNAL', `封包佇列沒有 stream ${String(stream)}`);
    return lane;
  }

  #wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#waiters.delete(wake);
        reject(signal.reason as Error);
      };
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }
}
