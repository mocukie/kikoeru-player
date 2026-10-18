// 假 media Worker：記錄收到的訊息，回覆的時機與內容完全由測試腳本控制，不重新實作 Worker 的行為。

import type {
  HostTypes,
  MainToWorkerMessage,
  ProbedMedia,
  WorkerStats,
  WorkerToMainMessage,
} from '../../src/protocol/index.js';

/** 測試環境（dom lib）的 host 物件型別。 */
export interface TestHost extends HostTypes {
  wasmModule: WebAssembly.Module;
  messagePort: MessagePort;
  blob: Blob;
}

type Received = MainToWorkerMessage<TestHost>;

/** 建立 Worker 時 Engine 給的回呼。 */
export interface FakeMediaWorkerHandlers {
  message(message: WorkerToMainMessage): void;
  crash(error: unknown): void;
}

export class FakeMediaWorker {
  readonly received: Received[] = [];
  terminated = false;
  readonly #handlers: FakeMediaWorkerHandlers;
  readonly #waiting: { type: Received['type']; resolve: (message: Received) => void }[] = [];

  constructor(handlers: FakeMediaWorkerHandlers) {
    this.#handlers = handlers;
  }

  post(message: Received): void {
    this.received.push(message);
    for (const waiter of this.#waiting.filter((w) => w.type === message.type)) {
      this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 收到的訊息中，指定 type 的那些。 */
  messages<T extends Received['type']>(type: T): Extract<Received, { type: T }>[] {
    return this.received.filter((m): m is Extract<Received, { type: T }> => m.type === type);
  }

  /** 等到收到第 `count` 個指定 type 的訊息（已經收到時立即 resolve）。 */
  async next<T extends Received['type']>(
    type: T,
    count = 1,
  ): Promise<Extract<Received, { type: T }>> {
    for (;;) {
      const found = this.messages(type)[count - 1];
      if (found) return found;
      await new Promise<Received>((resolve) => this.#waiting.push({ type, resolve }));
    }
  }

  /** 以 Worker 的身分回覆主執行緒。 */
  reply(message: WorkerToMainMessage): void {
    this.#handlers.message(message);
  }

  /** 回覆 probe 結果，epoch 取最後一個 `load` 的。 */
  async probe(media: ProbedMedia): Promise<void> {
    const load = await this.next('load');
    this.reply({ type: 'probe', epoch: load.epoch, media });
  }

  /** 回覆最後一個 `stats` 要求（還沒收到時等第一個）；`stats` 沒有給的欄位為 0／空值。 */
  async stats(
    libavInstances: number,
    stats: Partial<Omit<WorkerStats, 'libavInstances'>> = {},
  ): Promise<void> {
    const request = await this.next('stats', Math.max(1, this.messages('stats').length));
    this.reply({
      type: 'stats',
      id: request.id,
      stats: { ...emptyWorkerStats(), ...stats, libavInstances },
    });
  }

  /** 模擬 Worker 的 `onerror`。 */
  crash(error: unknown = new Error('worker crashed')): void {
    this.#handlers.crash(error);
  }
}

/** 什麼都沒有的 `WorkerStats`。 */
export function emptyWorkerStats(): WorkerStats {
  return {
    libavInstances: 0,
    cache: {
      bytes: 0,
      limitBytes: 0,
      aheadBytes: 0,
      readaheadTarget: 0,
      fetching: false,
      hits: 0,
      misses: 0,
    },
    network: { bytesLoaded: 0, inflight: [] },
    packetQueue: { audioSeconds: 0, videoSeconds: 0, bytes: 0 },
  };
}

/** 假 Worker 的 factory，依建立順序記錄每個 Worker。 */
export class FakeMediaWorkers {
  readonly created: FakeMediaWorker[] = [];

  readonly create = (handlers: FakeMediaWorkerHandlers): FakeMediaWorker => {
    const worker = new FakeMediaWorker(handlers);
    this.created.push(worker);
    return worker;
  };

  /** 最後建立的 Worker。 */
  get last(): FakeMediaWorker {
    const worker = this.created.at(-1);
    if (!worker) throw new Error('還沒有建立任何 media Worker');
    return worker;
  }
}

/** 一首只有一條 AAC 音軌、長 10 秒的媒體。 */
export function audioMedia(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    format: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 10,
    size: 160_000,
    tracks: [
      {
        kind: 'audio',
        streamIndex: 0,
        codec: 'aac',
        supported: true,
        default: true,
        forced: false,
        sampleRate: 44_100,
        channels: 2,
      },
    ],
    ...overrides,
  };
}
