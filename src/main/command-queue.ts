// 指令佇列：依呼叫順序串行執行，較新的指令可以取代尚未完成的指令。

/** 指令的執行內容；`signal` 在指令被取代、失敗或佇列關閉時 abort，reason 為 reject 的錯誤。 */
export type CommandRun<T> = (signal: AbortSignal) => Promise<T>;

interface Entry<K> {
  readonly kind: K;
  readonly run: CommandRun<unknown>;
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  started: boolean;
  settled: boolean;
}

/** 被取代的指令 reject 的錯誤。 */
export function abortError(): DOMException {
  return new DOMException('被較新的指令取代', 'AbortError');
}

/**
 * 串行的指令佇列。佇列頭的指令在 `enqueue()` 內同步開始執行，完成後下一個指令接著開始。
 *
 * 取代：新指令取代 `supersedes` 為 true 的所有尚未完成的指令（包括執行中的），它們以 AbortError reject，
 * 新指令排在第一個被取代者的位置；被取代的是執行中的指令時，新指令立即開始執行。
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

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry<K> = {
      kind,
      run,
      controller: new AbortController(),
      resolve,
      reject,
      started: false,
      settled: false,
    };

    const index = this.#entries.findIndex((e) => supersedes(e.kind));
    if (index === -1) {
      this.#entries.push(entry);
    } else {
      const superseded = this.#entries.filter((e) => supersedes(e.kind));
      this.#entries.splice(index, 0, entry);
      for (const e of superseded) this.#remove(e, abortError());
    }
    this.#pump();
    return promise as Promise<T>;
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
      entry.reject(reason);
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
          head.resolve(value);
        });
      },
      (error: unknown) => {
        this.#finish(head, () => {
          head.reject(error);
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
