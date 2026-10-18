// AudioContext 的生命週期（ADR-0004、硬性約束第 4 條）：串行佇列、解鎖、長時間暫停的 suspend、重建，
// 以及分辨 Engine 以外的變化（系統中斷、外部的 suspend／resume）。播放意圖與狀態機留在 Engine。

import type { WorkletToMainMessage } from '../protocol/index.js';
import type { AudioOutput, AudioOutputConfig, EngineDeps } from './deps.js';

/** `suspend()`、`resume()`、`close()` 各自的 timeout（ms）。 */
export const CONTEXT_TIMEOUT_MS = 2000;

/** 佇列中一個操作的結果。 */
export type ContextOpResult = 'ok' | 'failed' | 'timeout';

/**
 * AudioContext 操作的串行佇列：一次只執行一個，每個有 `CONTEXT_TIMEOUT_MS` 的 timeout，逾時就換下一個。
 * 佇列是空的時候在 `run()` 內同步呼叫操作，user gesture 才算數。
 */
export class ContextQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  /** 有操作還沒 settle（或還沒逾時）。這段期間的 `statechange` 視為 Engine 自己造成的。 */
  get busy(): boolean {
    return this.#pending > 0;
  }

  run(op: () => Promise<unknown>): Promise<ContextOpResult> {
    const start = () => withTimeout(op);
    const result = this.#pending === 0 ? start() : this.#tail.then(start);
    this.#pending++;
    const done = result.then((value) => {
      this.#pending--;
      return value;
    });
    this.#tail = done;
    return done;
  }
}

/** 呼叫 `op()`，以 `ContextOpResult` resolve，不會 reject。 */
function withTimeout(op: () => Promise<unknown>): Promise<ContextOpResult> {
  return new Promise<ContextOpResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, CONTEXT_TIMEOUT_MS);
    const settle = (value: ContextOpResult) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      op().then(
        () => {
          settle('ok');
        },
        () => {
          settle('failed');
        },
      );
    } catch {
      settle('failed');
    }
  });
}

/**
 * 啟動 context 的結果：`'running'` 已開始；`'locked'` 被拒絕或逾時（沒有 user gesture）；
 * `'interrupted'` 逾時且 context 處於系統中斷。
 */
export type StartResult = 'running' | 'locked' | 'interrupted';

/** Engine 以外造成的變化。 */
export type ContextChange =
  /** 系統中斷（iOS 來電等）。 */
  | 'interrupted'
  /** 執行中的 context 被 Engine 以外的人 suspend。 */
  | 'suspended'
  /** Engine 或外部 suspend 的 context 被 Engine 以外的人 resume。 */
  | 'resumed';

export interface AudioContextHooks {
  /** 目前的音訊輸出送來的 worklet 訊息。 */
  message(message: WorkletToMainMessage): void;
  /** 即將建立或 resume context；在 `start()` 的呼叫內同步呼叫，所以在 user gesture 的同步段內。 */
  beforeStart(cause: 'unlock' | 'resume'): void;
  /** Engine 以外造成的變化。 */
  changed(change: ContextChange): void;
  /** `running` 改變；Engine 依它與播放意圖決定 worklet 播或停。 */
  runningChanged(): void;
}

/**
 * Engine 對 context 的認知：
 * - `fresh`：剛建立，還沒開始過。
 * - `running`：Engine 的 resume 成功，或觀察到它自己開始。
 * - `suspended`：Engine 的長時間暫停 suspend，或被外部 suspend。
 * - `interrupted`：系統中斷；WebKit 之後自己 resume 時仍維持，直到 Engine 的 resume 成功。
 */
type Phase = 'fresh' | 'running' | 'suspended' | 'interrupted';

/** 一個 AudioContext 與它自己的佇列。 */
interface Slot {
  output: AudioOutput;
  queue: ContextQueue;
  phase: Phase;
  /** 最後一個 `statechange` 帶的 state。 */
  observed: AudioContextState | null;
  /** 曾經開始過。 */
  unlocked: boolean;
  /** 逾時的 resume 可能之後才生效（例如 Chromium 等到 gesture 才開始）；那時的 `running` 不是外部的 resume。 */
  lateResume: boolean;
  /** 進行中的啟動；同時的 `start()` 共用它。 */
  starting: Promise<StartResult> | null;
}

/**
 * Engine 持有的 AudioContext。`suspend()`、`resume()`、`close()` 一律經 context 自己的 `ContextQueue`，
 * 流程不看 `AudioContext.state`；`statechange` 只用來分辨 Engine 以外的變化。
 */
export class AudioContextLifecycle {
  readonly #create: EngineDeps['createAudioOutput'];
  readonly #config: AudioOutputConfig;
  readonly #hooks: AudioContextHooks;
  #slot: Slot | null = null;
  #closed = false;

  constructor(
    create: EngineDeps['createAudioOutput'],
    config: AudioOutputConfig,
    hooks: AudioContextHooks,
  ) {
    this.#create = create;
    this.#config = config;
    this.#hooks = hooks;
  }

  /** 目前的音訊輸出；還沒建立時為 null。 */
  get output(): AudioOutput | null {
    return this.#slot?.output ?? null;
  }

  /** Engine 認為 context 正在執行：worklet 可以出聲。 */
  get running(): boolean {
    return this.#slot?.phase === 'running';
  }

  /** 目前的 context 曾經開始過。 */
  get unlocked(): boolean {
    return this.#slot?.unlocked ?? false;
  }

  /** 正在啟動 context（resume 還沒有結果）。 */
  get starting(): boolean {
    return this.#slot?.starting != null;
  }

  /** 取得音訊輸出，還沒有時建立。建立失敗時丟出原本的錯誤。 */
  ensure(): AudioOutput {
    this.#slot ??= this.#open();
    return this.#slot.output;
  }

  /**
   * 讓 context 開始：已經在執行時直接 resolve `'running'`；否則（`announce` 時先同步呼叫 `beforeStart`）建立 context
   * 並經佇列 `resume()`。在 user gesture 的同步段內呼叫才能解鎖。
   */
  start(announce = true): Promise<StartResult> {
    if (this.#closed) return Promise.resolve('locked');
    const current = this.#slot;
    if (current?.phase === 'running') return Promise.resolve('running');
    if (current?.starting) return current.starting;
    if (announce) {
      this.#hooks.beforeStart(current?.unlocked ? 'resume' : 'unlock');
      // listener 可能已經 destroy()。
      if (this.#closedDuring()) return Promise.resolve('locked');
      if (this.#slot?.phase === 'running') return Promise.resolve('running');
      if (this.#slot?.starting) return this.#slot.starting;
    }
    const slot = (this.#slot ??= this.#open());
    const starting = this.#resume(slot).then((result) => {
      slot.starting = null;
      if (result === 'running') this.#enter(slot, 'running');
      return result;
    });
    slot.starting = starting;
    return starting;
  }

  /** 長時間暫停：經佇列 `suspend()`。 */
  suspend(): void {
    const slot = this.#slot;
    if (slot?.phase !== 'running') return;
    this.#enter(slot, 'suspended');
    void slot.queue.run(() => slot.output.suspend());
  }

  /**
   * watchdog 的第一步：經佇列 `suspend()` 再 `resume()`，以 resume 的結果 resolve。期間 Engine 仍視 context 為執行中，
   * 失敗時由 Engine 接著重建。
   */
  bounce(): Promise<StartResult> {
    const slot = this.#slot;
    if (!slot) return Promise.resolve('locked');
    void slot.queue.run(() => slot.output.suspend());
    return this.#resume(slot);
  }

  /** watchdog 的第二步：斷開並經佇列關閉目前的 context，建立新的。建立失敗時丟出原本的錯誤。 */
  rebuild(): AudioOutput {
    void this.#release();
    this.#slot = this.#open();
    return this.#slot.output;
  }

  /** destroy：斷開並經佇列關閉，一定會 settle。 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#release();
  }

  /** 同步呼叫的 hook 內可能已經 close()；以方法讀取，避開 TypeScript 對欄位的窄化。 */
  #closedDuring(): boolean {
    return this.#closed;
  }

  /** 經佇列 `resume()`。 */
  async #resume(slot: Slot): Promise<StartResult> {
    const result = await slot.queue.run(() => slot.output.resume());
    slot.lateResume = result === 'timeout';
    if (result === 'ok') return 'running';
    return result === 'timeout' && slot.observed === 'interrupted' ? 'interrupted' : 'locked';
  }

  #release(): Promise<unknown> {
    const slot = this.#slot;
    this.#slot = null;
    if (!slot) return Promise.resolve();
    slot.output.disconnect();
    return slot.queue.run(() => slot.output.close());
  }

  #open(): Slot {
    const slot: Slot = {
      // output 在 create() 回傳後才指定；之前的回呼不會發生。
      output: null as unknown as AudioOutput,
      queue: new ContextQueue(),
      phase: 'fresh',
      observed: null,
      unlocked: false,
      lateResume: false,
      starting: null,
    };
    slot.output = this.#create(
      {
        message: (message) => {
          if (this.#slot === slot) this.#hooks.message(message);
        },
        statechange: (state) => {
          if (this.#slot === slot) this.#observe(slot, state);
        },
      },
      this.#config,
    );
    return slot;
  }

  #enter(slot: Slot, phase: Phase): void {
    if (phase === 'running') slot.unlocked = true;
    if (slot.phase === phase) return;
    const wasRunning = slot.phase === 'running';
    slot.phase = phase;
    if (wasRunning !== (phase === 'running') && this.#slot === slot) this.#hooks.runningChanged();
  }

  /** 依 `statechange` 分辨 Engine 以外的變化；Engine 的操作進行中造成的不算。 */
  #observe(slot: Slot, state: AudioContextState): void {
    slot.observed = state;
    if (state === 'interrupted') {
      // 中斷一定不是 Engine 造成的。
      if (slot.phase === 'interrupted') return;
      this.#enter(slot, 'interrupted');
      this.#hooks.changed('interrupted');
      return;
    }
    if (slot.queue.busy) return;
    if (state === 'suspended' && slot.phase === 'running') {
      this.#enter(slot, 'suspended');
      this.#hooks.changed('suspended');
    } else if (state === 'running') {
      if (slot.phase === 'fresh' || slot.lateResume) {
        // 自己開始（例如已有 sticky activation），或逾時的 resume 之後才生效：不改變播放意圖。
        slot.lateResume = false;
        if (slot.phase !== 'interrupted') this.#enter(slot, 'running');
      } else if (slot.phase === 'suspended') {
        this.#enter(slot, 'running');
        this.#hooks.changed('resumed');
      }
      // interrupted：WebKit 在中斷結束後自己 resume，Engine 仍然暫停，下一次 play() 再 resume。
    }
  }
}
