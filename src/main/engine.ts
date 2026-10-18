// createEngine() 與 Engine 的實作：指令佇列、狀態機與狀態鏡像。

import type {
  ProbedMedia,
  WireSource,
  WorkletClockMessage,
  WorkletToMainMessage,
} from '../protocol/index.js';
import { abortError, CommandQueue, deferred, type Deferred } from './command-queue.js';
import { createWebAudioOutput } from './audio-output.js';
import {
  AssetLoadError,
  type AudioOutput,
  type EngineDeps,
  type MainHost,
  type MediaWorker,
  type WasmAssets,
} from './deps.js';
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
import { createWebMediaWorker } from './media-worker.js';
import { detectPlatform } from './platform.js';
import { sameTrackStructure, selectInitialTracks, toContainerTracks } from './tracks.js';
import { loadWasmAssets } from './wasm.js';
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
  return createEngineWith(
    {
      platform: detectPlatform(globalThis.navigator),
      loadWasm: () => loadWasmAssets(options?.assets),
      createWorker: createWebMediaWorker,
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

/** `reload()` 沿用的上一份媒體：軌道（含 track id）與選擇。 */
interface ReloadOf {
  info: MediaInfo;
  selection: TrackSelection;
}

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
  /** 鏡像的位置：時鐘停住時就是 `currentTime`；播放中是內插的基準之一（見 `currentTime`）。 */
  #currentTime = 0;
  /** 這個 epoch 最後一個 clock；播放中以它與此刻聽到的 frame 內插 `currentTime`。flush 時清掉。 */
  #clock: WorkletClockMessage | null = null;
  /** 這次進入 playing 之後 `currentTime` 回傳過的最大值；內插的結果不低於它，也不低於開始播放的位置。 */
  #heardFloor = 0;
  /** ring 的 frame 數與累計的 underrun，取自最後一個 clock，供 `getStats().audio`。 */
  #ringFrames = 0;
  #underruns = 0;
  /** playing 期間依 `timeUpdateInterval` 發出 timeupdate 的 timer。 */
  #timeUpdateTimer: ReturnType<typeof setInterval> | null = null;
  #lastTimeUpdate = NaN;
  /** 等待 Worker 回覆的 `stats` 要求；Worker 被 terminate 時以 0 個 instance resolve。 */
  readonly #statsRequests = new Map<number, (libavInstances: number) => void>();
  #statsSeq = 0;
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
  /** 最近一次 `load()` 的來源與選項，`reload()` 以它重新開檔。 */
  #lastLoad: { source: Source; options: LoadOptions } | null = null;
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
    const clock = this.#clock;
    const audio = this.#audio;
    if (this.#state !== 'playing' || !clock || !audio) return this.#currentTime;
    const heard = audio.heardFrame();
    if (heard === null) return this.#currentTime;
    // clock：`position` 的 sample 在 context frame `frame` 進入 graph；聽到的 frame 已扣掉輸出延遲。
    let time = clock.position + (heard - clock.frame) / audio.sampleRate;
    time = Math.max(time, this.#heardFloor);
    if (!Number.isNaN(this.#duration)) time = Math.min(time, this.#duration);
    this.#heardFloor = time;
    return time;
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
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    return this.#queue.enqueue(
      'load',
      (signal) => this.#runReload(signal),
      () => true,
    );
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
  /**
   * 目前只有 `resources` 與 `audio` 是實際的數字，其餘欄位是 0／空值，由快取與預讀 #39、診斷 #45 接上。
   */
  async getStats(): Promise<EngineStats> {
    const libavInstances = await this.#workerStats();
    const audio = this.#audio;
    const sampleRate = audio?.sampleRate ?? 0;
    return {
      bufferAhead: 0,
      audio: {
        ringMs: sampleRate > 0 ? (this.#ringFrames * 1000) / sampleRate : 0,
        underruns: this.#underruns,
        outputLatencyMs: (audio?.outputLatency() ?? 0) * 1000,
        targetMs: this.#options.audioBuffer.targetMs,
      },
      video: null,
      packetQueue: { audioSeconds: 0, videoSeconds: 0, bytes: 0 },
      cache: {
        bytes: 0,
        limitBytes: this.#options.limits.cacheBytes,
        aheadBytes: 0,
        readaheadTarget: 0,
        fetching: false,
        hits: 0,
        misses: 0,
      },
      network: { bytesLoaded: 0, inflight: [] },
      wasmHeapBytes: 0,
      resources: { workers: this.#worker ? 1 : 0, libavInstances, openVideoFrames: 0 },
    };
  }

  // ───────────────────────────── 指令的執行 ─────────────────────────────

  /**
   * 以最近一次 `load()` 的來源重新開檔。媒體的鏡像（`media`、`tracks`、`selectedTracks`、`duration`）在 reload
   * 期間維持原狀；沒有完成過的 load（例如 load 本身失敗）就以同樣的選項重新 load。
   */
  async #runReload(signal: AbortSignal): Promise<MediaInfo> {
    const last = this.#lastLoad;
    if (!last || this.#state === 'idle') {
      throw new DOMException(
        `state 為 '${this.#state}'，沒有可以 reload 的媒體`,
        'InvalidStateError',
      );
    }
    const position =
      this.#state === 'error' ? (this.#error?.position ?? this.#currentTime) : this.currentTime;
    const previous = this.#media ? { info: this.#media, selection: { ...this.#selected } } : null;
    return this.#runLoad(
      last.source,
      { ...last.options, startTime: position, paused: this.#paused },
      signal,
      previous,
    );
  }

  async #runLoad(
    source: Source,
    options: LoadOptions,
    signal: AbortSignal,
    reloadOf: ReloadOf | null = null,
  ): Promise<MediaInfo> {
    this.#terminateWorker();
    if (!reloadOf) this.#lastLoad = { source, options };
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
    if (!reloadOf) this.#publishMedia(null, noSelection);
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
      let tracks: readonly Track[];
      if (reloadOf) {
        // reload：軌道與 track id 沿用，組成不同就不能接續。
        if (!sameTrackStructure(reloadOf.info.tracks, probed.tracks)) {
          throw this.#fatal('SOURCE_CHANGED', '重新開檔後軌道的組成與先前不同');
        }
        tracks = reloadOf.info.tracks;
        load.selection = reloadOf.selection;
      } else {
        tracks = toContainerTracks(probed.tracks, () => ++this.#trackSeq);
        load.selection = selectInitialTracks(tracks, options.tracks, {
          audio: options.preferredLanguages?.audio ?? this.#options.preferredLanguages.audio,
          subtitle:
            options.preferredLanguages?.subtitle ?? this.#options.preferredLanguages.subtitle,
        });
      }
      const info: MediaInfo = {
        format: probed.format,
        duration: probed.duration,
        size: probed.size,
        tracks,
      };
      load.info = info;
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
        position: this.currentTime,
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
              position: this.currentTime,
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
          case 'stats':
            this.#statsRequests.get(message.id)?.(message.stats.libavInstances);
            this.#statsRequests.delete(message.id);
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
        this.#clock = message;
        this.#currentTime = message.position;
        this.#ringFrames = message.buffered;
        this.#underruns = message.underruns;
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
    if (state !== previous) this.#onStateEntered(state);
    this.dispatchEvent(new StateChangeEvent({ state, previous, paused, reason }));
    this.#notify();
  }

  /** 進入新的 state：播放中依 `timeUpdateInterval` 發出 timeupdate，離開 playing 就停。 */
  #onStateEntered(state: EngineState): void {
    if (state !== 'playing') {
      if (this.#timeUpdateTimer !== null) clearInterval(this.#timeUpdateTimer);
      this.#timeUpdateTimer = null;
      return;
    }
    this.#played = true;
    // 內插從開始播放的位置算起；輸出延遲期間聽到的還是開始之前的靜音。
    this.#heardFloor = this.#currentTime;
    this.#lastTimeUpdate = this.#currentTime;
    this.#timeUpdateTimer ??= setInterval(() => {
      const currentTime = this.currentTime;
      if (currentTime === this.#lastTimeUpdate) return;
      this.#lastTimeUpdate = currentTime;
      this.dispatchEvent(new TimeUpdateEvent({ currentTime }));
    }, this.#options.timeUpdateInterval);
  }

  /** Worker 持有的 libav instance 數；沒有 Worker 時為 0。 */
  #workerStats(): Promise<number> {
    const worker = this.#worker;
    if (!worker) return Promise.resolve(0);
    const id = ++this.#statsSeq;
    return new Promise<number>((resolve) => {
      this.#statsRequests.set(id, resolve);
      worker.post({ type: 'stats', id });
    });
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
    this.#clock = null;
    if (this.#loadContext) this.#loadContext.flushedAt = position;
    this.#audio?.post({ type: 'flush', epoch: this.#epoch, position });
  }

  #beginSeek(time: number): void {
    this.#retarget(time);
    this.#setState('seeking', 'command');
  }

  /** 致命錯誤：結束當前媒體，state 進入 `'error'`，未完成的指令都以 `error` reject。不自動 reload。 */
  #fail(error: EngineError): void {
    const position = this.currentTime;
    this.#terminateWorker();
    this.#loadContext = null;
    this.#error = error;
    // 停掉 ring 內剩下的聲音。
    const epoch = ++this.#epoch;
    this.#flushAudio(position);
    this.#queue.fail(error);
    this.#setState('error', 'error');
    if (this.#epoch === epoch) this.dispatchEvent(new EngineErrorEvent({ error }));
  }

  #terminateWorker(): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const resolve of this.#statsRequests.values()) resolve(0);
    this.#statsRequests.clear();
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
      if (cause instanceof AssetLoadError) {
        throw this.#fatal('ASSET_LOAD_FAILED', 'AudioWorklet 載入失敗', cause);
      }
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
      position: this.currentTime,
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
    return new EngineError('DESTROYED', { fatal: false, position: this.currentTime });
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
