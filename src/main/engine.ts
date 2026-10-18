// createEngine() 與 Engine 的實作：指令佇列、狀態機與狀態鏡像。

import type { ProbedMedia, WireSource, WorkletToMainMessage } from '../protocol/index.js';
import { abortError, CommandQueue, deferred, type Deferred } from './command-queue.js';
import { createWebAudioOutput } from './audio-output.js';
import type { AudioOutput, EngineDeps, MainHost, MediaWorker, WasmAssets } from './deps.js';
import { EngineError } from './errors.js';
import {
  DurationChangeEvent,
  EngineErrorEvent,
  SeekedEvent,
  StateChangeEvent,
  TimeUpdateEvent,
  TracksChangeEvent,
} from './events.js';
import { notImplemented } from './not-implemented.js';
import { resolveEngineOptions, type ResolvedEngineOptions } from './options.js';
import { detectPlatform } from './platform.js';
import { selectInitialTracks, toContainerTracks } from './tracks.js';
import type {
  AudioTrack,
  Engine,
  EngineErrorCode,
  EngineOptions,
  EngineState,
  EngineStats,
  LoadOptions,
  MediaInfo,
  Source,
  StateChangeReason,
  TimeRange,
  Track,
  TrackSelection,
  VideoSize,
} from './types.js';

/**
 * 建立 Engine。整個 App 建立一個，換檔用 `load()`。
 *
 * 選項的數值超出範圍時丟 `RangeError`，見 `EngineOptions` 各欄位。平台（iOS／iPadOS、Android、桌面）在這裡判斷一次，
 * 決定 `audioBuffer` 與 `limits` 的預設值。
 */
export function createEngine(options?: EngineOptions): Engine {
  // 真實的 media Worker 與 wasm 由「純音訊播放的串接」（#36）接上。
  return createEngineWith(
    {
      platform: detectPlatform(globalThis.navigator),
      loadWasm: () => notImplemented('wasm 的載入'),
      createWorker: () => notImplemented('media Worker'),
      createAudioOutput: createWebAudioOutput,
    },
    options,
  );
}

/** 以指定的 deps 建立 Engine；`createEngine()` 帶真實 deps 呼叫它，Node 測試注入 `test/fakes/`。不放進套件的 `exports`。 */
export function createEngineWith(deps: EngineDeps, options?: EngineOptions): Engine {
  return new EngineImpl(deps, resolveEngineOptions(options, deps.platform));
}

type CommandKind = 'load' | 'play' | 'pause' | 'seek';

const noSelection: Readonly<TrackSelection> = { audio: null, video: null, subtitle: null };

/** 執行中的 load。 */
interface LoadContext {
  /** 起點；loading 期間的 seek 會改寫它。 */
  startTime: number;
  /** worklet 最後一次 flush 的位置。 */
  flushedAt: number;
  probed: ProbedMedia | null;
  /** 已送出 `start` 之後才有。 */
  info: MediaInfo | null;
  selection: TrackSelection;
  /** loading 期間的 seek，與 load 一起 resolve。 */
  seek: Deferred<number> | null;
}

class EngineImpl extends EventTarget implements Engine {
  readonly #deps: EngineDeps;
  readonly #options: ResolvedEngineOptions;
  readonly #queue = new CommandQueue<CommandKind>();
  /** 等待狀態改變的指令；每次鏡像更新後重新檢查。 */
  readonly #waiters = new Set<() => void>();

  #state: EngineState = 'idle';
  #paused = true;
  /** 最後一個 statechange 帶的 `paused`；#changeIntent() 到 #announceIntent() 之間與 `#paused` 不同。 */
  #announcedPaused = true;
  #currentTime = 0;
  #duration = NaN;
  #media: MediaInfo | null = null;
  #tracks: readonly Track[] = [];
  #selected: Readonly<TrackSelection> = noSelection;
  #error: EngineError | null = null;

  /**
   * 會改變輸出的指令（load、seek）、致命錯誤與 destroy 遞增；Worker 與 worklet 的訊息 epoch 不符即丟棄。
   * 事件一律同步 dispatch，listener 可以在其中呼叫任何指令，所以 dispatch 之後要先以 epoch 確認
   * 目前的操作沒有被取代，才繼續發布狀態或事件。
   */
  #epoch = 0;
  #trackSeq = 0;
  /** 這份媒體是否播放過；seek 結束時決定回到 `'ready'` 或 `'paused'`。 */
  #played = false;
  #worker: MediaWorker | null = null;
  #audio: AudioOutput | null = null;
  #wasm: Promise<WasmAssets> | null = null;
  #loadContext: LoadContext | null = null;
  #isDestroyed = false;
  #destroying: Promise<void> | null = null;

  constructor(deps: EngineDeps, options: ResolvedEngineOptions) {
    super();
    this.#deps = deps;
    this.#options = options;
  }

  get state(): EngineState {
    return this.#state;
  }
  get paused(): boolean {
    return this.#paused;
  }
  get currentTime(): number {
    return this.#currentTime;
  }
  get duration(): number {
    return this.#duration;
  }
  get buffered(): readonly TimeRange[] {
    return notImplemented('buffered');
  }
  get media(): MediaInfo | null {
    return this.#media;
  }
  get tracks(): readonly Track[] {
    return this.#tracks;
  }
  get selectedTracks(): Readonly<TrackSelection> {
    return this.#selected;
  }
  get error(): EngineError | null {
    return this.#error;
  }
  get videoSize(): VideoSize | null {
    return notImplemented('videoSize');
  }
  get audioUnlocked(): boolean {
    return notImplemented('audioUnlocked');
  }

  get volume(): number {
    return notImplemented('volume');
  }
  set volume(_value: number) {
    notImplemented('volume');
  }
  get muted(): boolean {
    return notImplemented('muted');
  }
  set muted(_value: boolean) {
    notImplemented('muted');
  }
  get playbackRate(): number {
    return notImplemented('playbackRate');
  }
  set playbackRate(_value: number) {
    notImplemented('playbackRate');
  }

  unlockAudio(): void {
    notImplemented('unlockAudio()');
  }

  // ───────────────────────────── 指令 ─────────────────────────────

  load(source: Source, options: LoadOptions = {}): Promise<MediaInfo> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    return this.#queue.enqueue(
      'load',
      (signal) => this.#runLoad(source, options, signal),
      () => true,
    );
  }

  reload(): Promise<MediaInfo> {
    return notImplemented('reload()');
  }

  play(): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    // 在呼叫內同步解鎖，user gesture 才算數（完整的生命週期由 #41 加入）。
    const unlocking = this.#audio?.unlock() ?? Promise.resolve(true);
    this.#changeIntent(false);
    const playing = this.#queue.enqueue(
      'play',
      (signal) => this.#runPlay(unlocking, signal),
      (k) => k === 'pause',
    );
    this.#announceIntent();
    return playing;
  }

  pause(): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#changeIntent(true);
    const pausing = this.#queue.enqueue(
      'pause',
      (signal) => this.#runPause(signal),
      (k) => k === 'play',
    );
    this.#announceIntent();
    return pausing;
  }

  seek(time: number): Promise<number> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    if (!Number.isFinite(time)) {
      return Promise.reject(new TypeError(`seek() 的時間必須是有限數，收到 ${String(time)}`));
    }
    if (this.#loadContext) return this.#seekWhileLoading(this.#loadContext, time);
    return this.#queue.enqueue(
      'seek',
      (signal) => this.#runSeek(time, signal),
      (k) => k === 'seek',
    );
  }

  selectTracks(): Promise<void> {
    return notImplemented('selectTracks()');
  }
  addExternalAudio(): Promise<AudioTrack> {
    return notImplemented('addExternalAudio()');
  }
  removeExternalAudio(): Promise<void> {
    return notImplemented('removeExternalAudio()');
  }
  setAudioOffset(): Promise<void> {
    return notImplemented('setAudioOffset()');
  }
  unload(): Promise<void> {
    return notImplemented('unload()');
  }

  destroy(): Promise<void> {
    this.#destroying ??= this.#runDestroy();
    return this.#destroying;
  }

  attachCanvas(): void {
    notImplemented('attachCanvas()');
  }
  getStats(): Promise<EngineStats> {
    return notImplemented('getStats()');
  }

  // ───────────────────────────── 指令的執行 ─────────────────────────────

  async #runLoad(source: Source, options: LoadOptions, signal: AbortSignal): Promise<MediaInfo> {
    this.#terminateWorker();
    const epoch = ++this.#epoch;
    const startTime = Number.isFinite(options.startTime) ? Math.max(0, options.startTime ?? 0) : 0;
    const load: LoadContext = {
      startTime,
      flushedAt: startTime,
      probed: null,
      info: null,
      selection: noSelection,
      seek: null,
    };
    this.#loadContext = load;
    signal.addEventListener('abort', () => {
      load.seek?.reject(abortReason(signal));
      if (this.#loadContext === load) this.#loadContext = null;
    });
    this.#played = false;
    this.#error = null;
    this.#currentTime = startTime;
    this.#publishMedia(null, noSelection);
    signal.throwIfAborted();
    this.#setState('loading', 'command', options.paused ?? true);
    signal.throwIfAborted();

    try {
      const audio = this.#audioOutput();
      audio.post({ type: 'flush', epoch, position: startTime });
      audio.post({ type: this.#paused ? 'pause' : 'play', epoch });
      const worker = this.#spawnWorker();
      const [wasm, port] = await abortable(
        Promise.all([this.#loadWasm(), this.#connect(audio)]),
        signal,
      );
      signal.throwIfAborted();
      worker.post(
        {
          type: 'init',
          module: wasm.module,
          glueUrl: wasm.glueUrl,
          workletPort: port,
          sampleRate: audio.sampleRate,
        },
        [port],
      );
      worker.post({ type: 'load', epoch, source: toWireSource(source) });

      const probed = await this.#waitFor(() => load.probed, signal);
      signal.throwIfAborted();
      const tracks = toContainerTracks(probed.tracks, () => ++this.#trackSeq);
      const info: MediaInfo = {
        format: probed.format,
        duration: probed.duration,
        size: probed.size,
        tracks,
      };
      load.info = info;
      load.selection = selectInitialTracks(tracks, options.tracks, {
        audio: options.preferredLanguages?.audio ?? this.#options.preferredLanguages.audio,
        subtitle: options.preferredLanguages?.subtitle ?? this.#options.preferredLanguages.subtitle,
      });
      load.startTime = clamp(load.startTime, probed.duration);
      this.#currentTime = load.startTime;
      if (load.startTime !== load.flushedAt) {
        // 起點被 duration 夾住：換一個 epoch，讓 worklet 從新的位置開始。
        this.#epoch++;
        this.#flushAudio(load.startTime);
      }
      // worklet 以 duration 截掉多的音訊、在 eof 之後補靜音並判定 ended；Worker 開始供料之前送到。
      audio.post({ type: 'duration', epoch: this.#epoch, duration: probed.duration });
      const audioTrack = tracks.find((t) => t.id === load.selection.audio);
      worker.post({
        type: 'start',
        epoch: this.#epoch,
        time: load.startTime,
        audio: audioTrack?.streamIndex ?? null,
      });

      // worklet 回報後，#applyOutput() 結束 load、發布媒體並離開 loading。
      await this.#until(() => this.#loadContext !== load, signal);
      signal.throwIfAborted();
      return info;
    } catch (error) {
      if (!signal.aborted) this.#fail(this.#toEngineError(error));
      throw error;
    }
  }

  #seekWhileLoading(load: LoadContext, time: number): Promise<number> {
    load.seek?.reject(abortError());
    const seek = deferred<number>();
    load.seek = seek;
    if (load.info) {
      load.startTime = clamp(time, load.info.duration);
      this.#retarget(load.startTime);
    } else {
      // 還沒送出 start：只改起點，probe 之後再夾到 duration。
      load.startTime = Math.max(0, time);
      this.#currentTime = load.startTime;
    }
    return seek.promise;
  }

  async #runPlay(unlocking: Promise<boolean>, signal: AbortSignal): Promise<void> {
    this.#assertMedia();
    if (!(await abortable(unlocking, signal))) {
      signal.throwIfAborted();
      // 沒有 user gesture：播放意圖回到暫停。
      this.#changeIntent(true);
      this.#announceIntent();
      throw new EngineError('AUDIO_LOCKED', {
        fatal: false,
        position: this.#currentTime,
        message: '沒有 user gesture，AudioContext 無法開始',
      });
    }
    if (this.#state === 'ended') this.#beginSeek(0);
    await this.#until(() => this.#state === 'playing', signal);
  }

  async #runPause(signal: AbortSignal): Promise<void> {
    await this.#until(() => this.#state !== 'playing' && this.#state !== 'buffering', signal);
  }

  async #runSeek(time: number, signal: AbortSignal): Promise<number> {
    this.#assertMedia();
    const target = clamp(time, this.#duration);
    this.#beginSeek(target);
    // worklet 回報後，#applyOutput() 離開 seeking 並發出 seeked。
    await this.#until(() => this.#state !== 'seeking', signal);
    return target;
  }

  async #runDestroy(): Promise<void> {
    this.#isDestroyed = true;
    this.#epoch++;
    this.#queue.close(() => this.#destroyedError());
    this.#loadContext = null;
    this.#terminateWorker();
    // 主執行緒還沒有持有任何 VideoFrame；影片的 issue 在這裡 close() 它們。
    const audio = this.#audio;
    this.#audio = null;
    audio?.disconnect();
    this.#error = null;
    this.#publishMedia(null, noSelection);
    this.#setState('idle', 'command', true);
    try {
      await audio?.close();
    } catch {
      // 關閉失敗也已經釋放了 Engine 這一側的資源；destroy() 不因此失敗。
    }
  }

  // ───────────────────────────── 訊息 ─────────────────────────────

  #spawnWorker(): MediaWorker {
    const worker: MediaWorker = this.#deps.createWorker({
      message: (message) => {
        if (worker !== this.#worker) return;
        switch (message.type) {
          case 'probe':
            if (this.#loadContext && message.epoch === this.#epoch)
              this.#loadContext.probed = message.media;
            break;
          case 'error': {
            if (message.epoch !== this.#epoch) return;
            const { code, fatal, message: text, detail } = message.error;
            const error = new EngineError(code, {
              fatal,
              position: this.#currentTime,
              message: text,
              ...(detail && { detail }),
            });
            if (fatal) this.#fail(error);
            else this.dispatchEvent(new EngineErrorEvent({ error }));
            break;
          }
          case 'crash':
            this.#fail(
              this.#fatal('INTERNAL', `media Worker 崩潰（${message.reason}）：${message.message}`),
            );
            break;
        }
        this.#notify();
      },
      crash: (cause) => {
        if (worker !== this.#worker) return;
        this.#fail(this.#fatal('INTERNAL', 'media Worker 崩潰', cause));
      },
    });
    this.#worker = worker;
    return worker;
  }

  #onWorkletMessage(message: WorkletToMainMessage): void {
    if (this.#isDestroyed || message.epoch !== this.#epoch) return;
    switch (message.type) {
      case 'clock':
        this.#currentTime = message.position;
        break;
      case 'playing':
      case 'paused':
        this.#applyOutput(message.type);
        break;
      case 'starved':
        if (this.#state === 'playing') this.#setState('buffering', 'media');
        break;
      case 'ended':
        if (this.#state === 'playing' || this.#state === 'buffering') {
          if (!Number.isNaN(this.#duration)) this.#currentTime = this.#duration;
          // paused 維持 false：App 不接下一首時自己 pause()。
          const epoch = this.#epoch;
          this.#setState('ended', 'media');
          if (this.#epoch === epoch) this.dispatchEvent(new Event('ended'));
        }
        break;
    }
    this.#notify();
  }

  /** worklet 開始輸出（`playing`）或停止輸出、資料已備妥（`paused`）。 */
  #applyOutput(output: 'playing' | 'paused'): void {
    switch (this.#state) {
      case 'loading': {
        const load = this.#loadContext;
        if (!load?.info) break;
        // 先結束 load，讓 listener 內的 seek() 走一般的 seek，不再改寫起點。
        const epoch = this.#epoch;
        this.#loadContext = null;
        load.seek?.resolve(load.startTime);
        load.seek = null;
        this.#publishMedia(load.info, load.selection);
        if (this.#epoch !== epoch) break;
        this.#setState(output === 'playing' ? 'playing' : 'ready', 'media');
        break;
      }
      case 'seeking': {
        const epoch = this.#epoch;
        const landing = this.#currentTime;
        this.#setState(
          output === 'playing' ? 'playing' : this.#played ? 'paused' : 'ready',
          'media',
        );
        if (this.#epoch !== epoch) break;
        this.dispatchEvent(new SeekedEvent({ currentTime: landing }));
        if (this.#epoch !== epoch) break;
        this.dispatchEvent(new TimeUpdateEvent({ currentTime: landing }));
        break;
      }
      case 'ready':
      case 'paused':
        if (output === 'playing') this.#setState('playing', 'command');
        break;
      case 'buffering':
        this.#setState(output, output === 'playing' ? 'media' : 'command');
        break;
      case 'playing':
        if (output === 'paused') this.#setState('paused', 'command');
        break;
      default:
        break;
    }
  }

  // ───────────────────────────── 內部 ─────────────────────────────

  /**
   * 改變播放意圖並立即告訴 worklet，但還不發出 statechange：play()／pause() 先把指令入列，
   * 再以 #announceIntent() 發出，listener 內的較新指令才會取代它，而不是反過來。
   */
  #changeIntent(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#audio?.post({ type: paused ? 'pause' : 'play', epoch: this.#epoch });
  }

  /** 發出還沒發出過的播放意圖；期間的 statechange 已經帶上它時不重複發出。 */
  #announceIntent(): void {
    this.#setState(this.#state, 'command');
  }

  #setState(state: EngineState, reason: StateChangeReason, paused = this.#paused): void {
    const previous = this.#state;
    if (state === previous && paused === this.#announcedPaused) return;
    this.#state = state;
    this.#paused = paused;
    this.#announcedPaused = paused;
    if (state === 'playing') this.#played = true;
    this.dispatchEvent(new StateChangeEvent({ state, previous, paused, reason }));
    this.#notify();
  }

  /** 一次更新媒體的鏡像，值有改變時才發出 durationchange、trackschange。 */
  #publishMedia(info: MediaInfo | null, selection: Readonly<TrackSelection>): void {
    const duration = info?.duration ?? NaN;
    const tracks = info?.tracks ?? [];
    const durationChanged = !Object.is(duration, this.#duration);
    const tracksChanged = tracks !== this.#tracks && (tracks.length > 0 || this.#tracks.length > 0);
    const selectionChanged = (['audio', 'video', 'subtitle'] as const).some(
      (kind) => selection[kind] !== this.#selected[kind],
    );
    this.#media = info;
    this.#duration = duration;
    this.#tracks = tracks;
    this.#selected = selection;
    const epoch = this.#epoch;
    if (durationChanged) this.dispatchEvent(new DurationChangeEvent({ duration }));
    if (this.#epoch !== epoch) return;
    if (tracksChanged || selectionChanged) {
      this.dispatchEvent(new TracksChangeEvent({ tracks, selected: selection }));
    }
  }

  /** 遞增 epoch，讓 Worker 從 `time` 重新供料、worklet 丟掉舊的資料。 */
  #retarget(time: number): void {
    const epoch = ++this.#epoch;
    this.#worker?.post({ type: 'seek', epoch, time });
    this.#flushAudio(time);
  }

  #flushAudio(position: number): void {
    this.#currentTime = position;
    if (this.#loadContext) this.#loadContext.flushedAt = position;
    this.#audio?.post({ type: 'flush', epoch: this.#epoch, position });
  }

  #beginSeek(time: number): void {
    this.#retarget(time);
    this.#setState('seeking', 'command');
  }

  /** 致命錯誤：結束當前媒體，state 進入 `'error'`，未完成的指令都以 `error` reject。不自動 reload。 */
  #fail(error: EngineError): void {
    this.#terminateWorker();
    this.#loadContext = null;
    this.#error = error;
    // 停掉 ring 內剩下的聲音。
    const epoch = ++this.#epoch;
    this.#flushAudio(this.#currentTime);
    this.#queue.fail(error);
    this.#setState('error', 'error');
    if (this.#epoch === epoch) this.dispatchEvent(new EngineErrorEvent({ error }));
  }

  #terminateWorker(): void {
    this.#worker?.terminate();
    this.#worker = null;
  }

  #audioOutput(): AudioOutput {
    if (!this.#audio) {
      try {
        const { audioBuffer, assets } = this.#options;
        this.#audio = this.#deps.createAudioOutput(
          (message) => {
            this.#onWorkletMessage(message);
          },
          {
            audioBuffer,
            ...(assets.workletUrl !== undefined && { workletUrl: assets.workletUrl }),
          },
        );
      } catch (cause) {
        throw this.#fatal('AUDIO_OUTPUT', '音訊輸出無法啟動', cause);
      }
    }
    return this.#audio;
  }

  async #connect(audio: AudioOutput): Promise<MessagePort> {
    try {
      return await audio.connect();
    } catch (cause) {
      throw this.#fatal('AUDIO_OUTPUT', 'AudioWorklet 無法接上 media Worker', cause);
    }
  }

  /** wasm 只 compile 一次並持有；失敗時下一次 load 重試。 */
  #loadWasm(): Promise<WasmAssets> {
    this.#wasm ??= new Promise<WasmAssets>((resolve) => {
      resolve(this.#deps.loadWasm());
    }).catch((cause: unknown) => {
      this.#wasm = null;
      throw this.#fatal('ASSET_LOAD_FAILED', 'wasm 載入失敗', cause);
    });
    return this.#wasm;
  }

  #assertMedia(): void {
    if (this.#state === 'idle' || this.#state === 'error') {
      throw new DOMException(`state 為 '${this.#state}'，沒有可播放的媒體`, 'InvalidStateError');
    }
  }

  /** 等到 `get()` 回傳非 null 的值；signal abort 時以其 reason reject。 */
  #waitFor<T>(get: () => T | null, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        this.#waiters.delete(check);
        signal.removeEventListener('abort', onAbort);
      };
      const check = () => {
        const value = get();
        if (value === null) return;
        done();
        resolve(value);
      };
      const onAbort = () => {
        done();
        reject(abortReason(signal));
      };
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      this.#waiters.add(check);
      signal.addEventListener('abort', onAbort);
      check();
    });
  }

  async #until(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    await this.#waitFor(() => (predicate() ? true : null), signal);
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check();
  }

  /** 以目前位置建立致命的 `EngineError`。 */
  #fatal(code: EngineErrorCode, message: string, cause?: unknown): EngineError {
    return new EngineError(code, {
      fatal: true,
      position: this.#currentTime,
      message,
      ...(cause !== undefined && { cause }),
    });
  }

  #toEngineError(error: unknown): EngineError {
    return error instanceof EngineError
      ? error
      : this.#fatal('INTERNAL', error instanceof Error ? error.message : String(error), error);
  }

  #destroyedError(): EngineError {
    return new EngineError('DESTROYED', { fatal: false, position: this.#currentTime });
  }
}

/** 夾在 `[0, duration]`；duration 未知（NaN）時只夾下限。 */
function clamp(time: number, duration: number): number {
  return Math.max(0, Number.isNaN(duration) ? time : Math.min(time, duration));
}

/** signal abort 時以其 reason reject，不等 `promise`。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      })
      .then(resolve, reject);
  });
}

/** 指令佇列一律以 Error（AbortError 或 EngineError）abort signal。 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function toWireSource(source: Source): WireSource<MainHost> {
  switch (source.kind) {
    case 'http':
      return {
        kind: 'http',
        url: String(source.url),
        ...(source.credentials && { credentials: source.credentials }),
        ...(source.headers && { headers: source.headers }),
        ...(source.size !== undefined && { size: source.size }),
      };
    case 'bytes':
      return { kind: 'bytes', data: source.data, ...(source.name && { name: source.name }) };
    case 'blob':
      return { kind: 'blob', blob: source.blob };
  }
}
