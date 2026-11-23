// 外掛音軌（`addExternalAudio()`）的來源與 media Worker 對 `addaudio` 的回覆。外掛音軌屬於當前媒體：load、unload 時
// 清掉，reload 時在新的 Worker 以同一個 id 重新開啟。選軌、移除與失敗時的切換由 Engine 決定。

import type { ProbedAudioTrack, WireError } from '../protocol/index.js';
import type { MediaWorker } from './deps.js';
import { EngineError, fromWireError } from './errors.js';
import type { Source, Track } from './types.js';
import { toWireSource } from './wire-source.js';

/** 每份媒體最多的外掛音軌數（「記憶體上限的數值」#23）。 */
export const MAX_EXTERNAL_AUDIO = 4;

/** Worker 對 `addaudio` 的回覆。 */
type AddAudioReply = { track: ProbedAudioTrack } | { error: WireError };

/** 等到 `get()` 回傳非 null 的值（Engine 收到 Worker 的訊息之後重新檢查）；signal abort 時以其 reason reject。 */
type WaitFor = <T>(get: () => T | null, signal: AbortSignal) => Promise<T>;

export class ExternalAudioSources {
  /** 當前媒體的外掛音軌的來源（track id → 來源），依加入的順序。 */
  readonly #sources = new Map<string, Source>();
  /** Worker 對 `addaudio` 的回覆（id → 結果），由等待它的指令取走。 */
  readonly #replies = new Map<string, AddAudioReply>();
  readonly #waitFor: WaitFor;

  constructor(waitFor: WaitFor) {
    this.#waitFor = waitFor;
  }

  /** 當前媒體的外掛音軌（track id 與來源），依加入的順序。 */
  entries(): [string, Source][] {
    return [...this.#sources];
  }

  /** 開啟成功的外掛音軌屬於當前媒體。 */
  add(id: string, source: Source): void {
    this.#sources.set(id, source);
  }

  /** 外掛音軌不再屬於當前媒體（移除或失敗）：之後的 reload 不再加入。 */
  delete(id: string): void {
    this.#sources.delete(id);
  }

  /** 換成新的媒體（load、unload）。 */
  clear(): void {
    this.#sources.clear();
  }

  /** Worker 被 terminate：還沒取走的回覆作廢。 */
  dropReplies(): void {
    this.#replies.clear();
  }

  /** Worker 的 `audioprobe`／`audioerror`。 */
  onReply(id: string, reply: AddAudioReply): void {
    this.#replies.set(id, reply);
  }

  /** 請 Worker 以 `id` 開啟外掛音軌的來源；結果由 `reply()` 取得。 */
  request(worker: MediaWorker, id: string, source: Source): void {
    this.#replies.delete(id);
    worker.post({ type: 'addaudio', id, source: toWireSource(source) });
  }

  /** 等 Worker 對 `addaudio` 的回覆並取走它。 */
  async reply(id: string, signal: AbortSignal): Promise<AddAudioReply> {
    const reply = await this.#waitFor(() => this.#replies.get(id) ?? null, signal);
    this.#replies.delete(id);
    return reply;
  }

  /** 請 Worker 開啟外掛音軌的來源並等它的 probe；失敗時丟非致命的 `EngineError`（`position` 是此刻的播放位置）。 */
  async open(
    worker: MediaWorker,
    id: string,
    source: Source,
    signal: AbortSignal,
    position: () => number,
  ): Promise<ProbedAudioTrack> {
    this.request(worker, id, source);
    const reply = await this.reply(id, signal);
    if ('track' in reply) return reply.track;
    throw fromWireError(reply.error, { fatal: false, position: position() });
  }

  /**
   * reload：等新的 Worker 重新開啟外掛音軌 `id`。成功且組成（codec、stream）與 `before`（reload 之前的軌）相同時為 null，
   * 否則是要回報的非致命錯誤。
   */
  async reopened(
    id: string,
    before: Track | undefined,
    signal: AbortSignal,
    position: () => number,
  ): Promise<EngineError | null> {
    const reply = await this.reply(id, signal);
    signal.throwIfAborted();
    if ('error' in reply) {
      return fromWireError(reply.error, {
        fatal: false,
        position: position(),
        message: `外掛音軌重新開檔失敗：${reply.error.message}`,
        detail: { trackId: id },
      });
    }
    if (before?.codec === reply.track.codec && before.streamIndex === reply.track.streamIndex) {
      return null;
    }
    return new EngineError('SOURCE_CHANGED', {
      fatal: false,
      position: position(),
      message: `重新開檔後外掛音軌 '${id}' 的組成與先前不同`,
      detail: { trackId: id },
    });
  }
}
