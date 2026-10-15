// 指令佇列：依呼叫順序串行執行，較新的指令可以取代尚未完成的指令。

/** 指令的執行內容；`signal` 在指令被取代、失敗或佇列關閉時 abort，reason 為 reject 的錯誤。 */
export type CommandRun<T> = (signal: AbortSignal) => Promise<T>;

interface Entry<K> {
  readonly kind: K;
  readonly run: CommandRun<unknown>;
  readonly controller: AbortController;
  readonly result: Deferred<unknown>;
  started: boolean;
  settled: boolean;
}

/** 被取代或中止的指令 reject 的錯誤。 */
export function abortError(): DOMException {
  return new DOMException('指令被取代或中止', 'AbortError');
}

/** 可以從外部 resolve／reject 的 Promise（lib 是 es2023，沒有 `Promise.withResolvers`）。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 串行的指令佇列。佇列頭的指令在 `enqueue()` 內同步開始執行，完成後下一個指令接著開始。
 *
 * 取代：新指令取代 `supersedes` 為 true 的所有尚未完成的指令（包括執行中的），它們以 AbortError reject。
 * 被取代的包括執行中的指令時，新指令接手它的位置並立即開始執行（例如執行中的 seek 被新的 seek 取代，
 * 不能等排在後面的 play 先完成）；否則新指令照呼叫順序排在尾端。
 */
export class CommandQueue<K extends string> {
  readonly #entries: Entry<K>[] = [];
  #closed: (() => Error) | null = null;

  enqueue<T>(
    kind: K,
    run: CommandRun<T>,
    supersedes: (kind: K) => boolean = () => false,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed());

    const entry: Entry<K> = {
      kind,
      run,
      controller: new AbortController(),
      result: deferred(),
      started: false,
      settled: false,
    };

    const superseded = this.#entries.filter((e) => supersedes(e.kind));
    if (superseded[0]?.started) this.#entries.unshift(entry);
    else this.#entries.push(entry);
    for (const e of superseded) this.#remove(e, abortError());
    this.#pump();
    return entry.result.promise as Promise<T>;
  }

  /** 以 `error` reject 所有尚未完成的指令；之後仍可加入新的指令。 */
  fail(error: Error): void {
    for (const entry of [...this.#entries]) this.#remove(entry, error);
  }

  /** 以 AbortError reject 所有尚未完成的指令；之後加入的指令都以 `error()` reject。 */
  close(error: () => Error): void {
    this.#closed = error;
    this.fail(abortError());
  }

  #remove(entry: Entry<K>, reason: Error): void {
    const index = this.#entries.indexOf(entry);
    if (index !== -1) this.#entries.splice(index, 1);
    if (!entry.settled) {
      entry.settled = true;
      entry.result.reject(reason);
    }
    entry.controller.abort(reason);
  }

  #pump(): void {
    const head = this.#entries[0];
    if (!head || head.started) return;
    head.started = true;

    // 在 executor 內同步開始執行，run 同步丟出的錯誤也變成 rejection。
    new Promise<unknown>((resolve) => {
      resolve(head.run(head.controller.signal));
    }).then(
      (value) => {
        this.#finish(head, () => {
          head.result.resolve(value);
        });
      },
      (error: unknown) => {
        this.#finish(head, () => {
          head.result.reject(error);
        });
      },
    );
  }

  #finish(entry: Entry<K>, settle: () => void): void {
    if (entry.settled) return;
    entry.settled = true;
    this.#entries.splice(this.#entries.indexOf(entry), 1);
    settle();
    this.#pump();
  }
}
